import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mailEvents } from './realtime.js';
import type { StoredMessage } from './types.js';
import { summarizeMessage } from './mime.js';

type ChunkRecord = {
  id: number;
  filePath: string;
  messages: StoredMessage[];
};

type StoreOptions = {
  dataDir: string;
  chunkSize: number;
  maxChunkBytes: number;
};

function isChunkFile(fileName: string) {
  return /^chunk-\d+\.json$/.test(fileName);
}

function parseChunkId(fileName: string) {
  const match = /^chunk-(\d+)\.json$/.exec(fileName);
  return match ? Number(match[1]) : 0;
}

function normalizeAttachment(attachment: any) {
  const safe = attachment ?? {};
  return {
    filename: typeof safe.filename === 'string' && safe.filename ? safe.filename : 'attachment',
    type: typeof safe.type === 'string' ? safe.type : undefined,
    content: typeof safe.content === 'string' ? safe.content : undefined,
    contentId: typeof safe.contentId === 'string' ? safe.contentId : undefined,
    disposition: typeof safe.disposition === 'string' ? safe.disposition : undefined,
    size: Number(safe.size) || 0
  };
}

function normalizeMessage(raw: any): StoredMessage {
  return {
    id: typeof raw?.id === 'string' ? raw.id : randomUUID(),
    source: raw?.source === 'sendgrid-api' ? 'sendgrid-api' : 'smtp',
    createdAt: typeof raw?.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    isRead: Boolean(raw?.isRead),
    from: typeof raw?.from === 'string' ? raw.from : '',
    to: Array.isArray(raw?.to) ? raw.to.filter((item: unknown) => typeof item === 'string') : [],
    cc: Array.isArray(raw?.cc) ? raw.cc.filter((item: unknown) => typeof item === 'string') : [],
    bcc: Array.isArray(raw?.bcc) ? raw.bcc.filter((item: unknown) => typeof item === 'string') : [],
    subject: typeof raw?.subject === 'string' ? raw.subject : '',
    headers: raw?.headers && typeof raw.headers === 'object' ? raw.headers : {},
    text: typeof raw?.text === 'string' ? raw.text : '',
    html: typeof raw?.html === 'string' ? raw.html : '',
    raw: typeof raw?.raw === 'string' ? raw.raw : '',
    attachments: Array.isArray(raw?.attachments) ? raw.attachments.map(normalizeAttachment) : [],
    replyTo: typeof raw?.replyTo === 'string' ? raw.replyTo : undefined,
    envelopeFrom: typeof raw?.envelopeFrom === 'string' ? raw.envelopeFrom : undefined,
    envelopeTo: Array.isArray(raw?.envelopeTo) ? raw.envelopeTo.filter((item: unknown) => typeof item === 'string') : []
  };
}

export class MessageStore {
  private chunks: ChunkRecord[] = [];
  private nextChunkId = 1;

  constructor(private readonly options: StoreOptions) {
    this.load();
  }

  private ensureDataDir() {
    fs.mkdirSync(this.options.dataDir, { recursive: true });
  }

  private chunkFilePath(id: number) {
    return path.join(this.options.dataDir, `chunk-${String(id).padStart(6, '0')}.json`);
  }

  private saveChunk(chunk: ChunkRecord) {
    fs.writeFileSync(
      chunk.filePath,
      JSON.stringify(
        {
          chunkId: chunk.id,
          messages: chunk.messages
        },
        null,
        2
      ),
      'utf8'
    );
  }

  private load() {
    this.ensureDataDir();
    const entries = fs
      .readdirSync(this.options.dataDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isChunkFile(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => parseChunkId(left) - parseChunkId(right));

    this.chunks = entries
      .map((fileName) => {
        const filePath = path.join(this.options.dataDir, fileName);
        try {
          const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          const rawMessages = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.messages)
              ? parsed.messages
              : [];
          const messages = rawMessages.map(normalizeMessage);
          return {
            id: parseChunkId(fileName),
            filePath,
            messages
          } satisfies ChunkRecord;
        } catch {
          return null;
        }
      })
      .filter((chunk): chunk is ChunkRecord => Boolean(chunk));

    this.nextChunkId = this.chunks.length ? Math.max(...this.chunks.map((chunk) => chunk.id)) + 1 : 1;
  }

  private estimateChunkBytes(messages: StoredMessage[]) {
    return Buffer.byteLength(
      JSON.stringify(
        {
          messages
        },
        null,
        0
      )
    );
  }

  private ensureInsertChunk(message: StoredMessage) {
    let chunk = this.chunks[this.chunks.length - 1];
    if (!chunk) {
      chunk = {
        id: this.nextChunkId++,
        filePath: this.chunkFilePath(this.nextChunkId - 1),
        messages: []
      };
      this.chunks.push(chunk);
    }

    const candidate = [message, ...chunk.messages];
    if (chunk.messages.length >= this.options.chunkSize || this.estimateChunkBytes(candidate) > this.options.maxChunkBytes) {
      chunk = {
        id: this.nextChunkId++,
        filePath: this.chunkFilePath(this.nextChunkId - 1),
        messages: []
      };
      this.chunks.push(chunk);
    }

    return chunk;
  }

  private findLocation(id: string) {
    for (const chunk of this.chunks) {
      const index = chunk.messages.findIndex((message) => message.id === id);
      if (index !== -1) {
        return { chunk, index, message: chunk.messages[index] };
      }
    }
    return null;
  }

  list(query = '') {
    const normalized = query.trim().toLowerCase();
    const items = this.chunks
      .flatMap((chunk) => chunk.messages)
      .filter((message) => {
        if (!normalized) return true;
        return [
          message.from,
          message.subject,
          message.raw,
          message.to.join(','),
          message.cc.join(','),
          message.bcc.join(',')
        ]
          .join(' ')
          .toLowerCase()
          .includes(normalized);
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(summarizeMessage);

    return { items, total: items.length };
  }

  get(id: string) {
    return this.findLocation(id)?.message ?? null;
  }

  insert(message: Omit<StoredMessage, 'id' | 'createdAt'>) {
    const stored: StoredMessage = {
      ...message,
      id: randomUUID(),
      createdAt: new Date().toISOString()
    };

    const chunk = this.ensureInsertChunk(stored);
    chunk.messages.unshift(stored);
    this.saveChunk(chunk);
    mailEvents.publish({ kind: 'new-message', message: summarizeMessage(stored) });
    return stored;
  }

  markRead(id: string, isRead: boolean) {
    const location = this.findLocation(id);
    if (!location) {
      return null;
    }

    if (location.message.isRead !== isRead) {
      location.message.isRead = isRead;
      this.saveChunk(location.chunk);
      mailEvents.publish({ kind: 'inbox-updated' });
    }

    return location.message;
  }

  delete(id: string) {
    const location = this.findLocation(id);
    if (!location) {
      return false;
    }

    location.chunk.messages.splice(location.index, 1);
    if (!location.chunk.messages.length) {
      fs.rmSync(location.chunk.filePath, { force: true });
      this.chunks = this.chunks.filter((chunk) => chunk.id !== location.chunk.id);
    } else {
      this.saveChunk(location.chunk);
    }

    mailEvents.publish({ kind: 'inbox-updated' });
    return true;
  }

  clear() {
    for (const chunk of this.chunks) {
      fs.rmSync(chunk.filePath, { force: true });
    }
    this.chunks = [];
    this.nextChunkId = 1;
    mailEvents.publish({ kind: 'inbox-updated' });
  }
}
