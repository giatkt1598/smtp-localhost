import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { mailEvents } from './realtime.js';
import { MessageStore } from './store.js';
import { parseMimeMessage, parseSendGridContent, decodeSendGridAttachment } from './mime.js';
import { serveStatic } from './static.js';
import { startSmtpServer } from './smtp.js';

const HOST = process.env.HOST ?? '127.0.0.1';
const HTTP_PORT = Number(process.env.HTTP_PORT ?? '18025');
const SMTP_PORT = Number(process.env.SMTP_PORT ?? '11025');
const MAX_MESSAGE_BYTES = Number(process.env.MAX_MESSAGE_BYTES ?? `${10 * 1024 * 1024}`);
const MAIL_DATA_DIR = process.env.MAIL_DATA_DIR ?? path.resolve(process.cwd(), 'data', 'mailbox');
const MAIL_CHUNK_SIZE = Number(process.env.MAIL_CHUNK_SIZE ?? '25');
const MAIL_CHUNK_MAX_BYTES = Number(process.env.MAIL_CHUNK_MAX_BYTES ?? `${512 * 1024}`);
const store = new MessageStore({
  dataDir: MAIL_DATA_DIR,
  chunkSize: MAIL_CHUNK_SIZE,
  maxChunkBytes: MAIL_CHUNK_MAX_BYTES
});
const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,accept',
  'access-control-max-age': '86400'
};

function withCorsHeaders(headers: http.OutgoingHttpHeaders = {}) {
  return {
    ...headers,
    ...corsHeaders
  };
}

function json(res: http.ServerResponse, statusCode: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, withCorsHeaders({
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  }));
  res.end(payload);
}

function text(res: http.ServerResponse, statusCode: number, body: string, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, withCorsHeaders({
    'content-type': contentType,
    'content-length': Buffer.byteLength(body)
  }));
  res.end(body);
}

function readBody(req: http.IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_MESSAGE_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function getHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function normalizePerson(value: any) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.email === 'string') {
    return value.name ? `${value.name} <${value.email}>` : value.email;
  }
  return '';
}

function normalizeList(value: any): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map(normalizePerson).filter(Boolean);
  }
  return [normalizePerson(value)].filter(Boolean);
}

function applyMessagePayload({
  source,
  from,
  to,
  cc,
  bcc,
  subject,
  headers,
  text,
  html,
  raw,
  attachments,
  replyTo,
  envelopeFrom,
  envelopeTo,
  isRead
}: {
  source: 'smtp' | 'sendgrid-api';
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  headers: Record<string, string>;
  text: string;
  html: string;
  raw: string;
  attachments: Array<{ filename: string; type?: string; content?: string; contentId?: string; disposition?: string; size: number }>;
  replyTo?: string;
  envelopeFrom?: string;
  envelopeTo: string[];
  isRead: boolean;
}) {
  return store.insert({
    source,
    from,
    to,
    cc,
    bcc,
    subject,
    headers,
    text,
    html,
    raw,
    attachments,
    replyTo,
    envelopeFrom,
    envelopeTo,
    isRead
  });
}

function buildRawMessage({
  from,
  to,
  cc,
  bcc,
  subject,
  text,
  html,
  replyTo,
  attachments
}: {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  attachments: Array<{ filename: string; type?: string; content?: string; contentId?: string; disposition?: string; size: number }>;
}) {
  const boundary = `boundary-${Date.now().toString(36)}`;
  const alternativeBoundary = `${boundary}-alternative`;
  const mixedBoundary = `${boundary}-mixed`;
  const hasAttachments = attachments.length > 0;
  const headers = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    cc.length ? `Cc: ${cc.join(', ')}` : '',
    bcc.length ? `Bcc: ${bcc.join(', ')}` : '',
    `Subject: ${subject || '(no subject)'}`,
    `MIME-Version: 1.0`,
    replyTo ? `Reply-To: ${replyTo}` : '',
    hasAttachments
      ? `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`
      : html
        ? `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`
        : 'Content-Type: text/plain; charset="utf-8"',
  ].filter(Boolean);

  const messageBody = html
    ? [
        `--${alternativeBoundary}`,
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        text || '',
        `--${alternativeBoundary}`,
        'Content-Type: text/html; charset="utf-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        html || '',
        `--${alternativeBoundary}--`
      ].join('\r\n')
    : text || '';

  const body = hasAttachments
    ? [
        html
          ? [
              `--${mixedBoundary}`,
              `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
              '',
              messageBody,
            ].join('\r\n')
          : [
              `--${mixedBoundary}`,
              'Content-Type: text/plain; charset="utf-8"',
              'Content-Transfer-Encoding: 8bit',
              '',
              text || ''
            ].join('\r\n'),
        ...attachments.map((attachment) => [
          `--${mixedBoundary}`,
          `Content-Type: ${attachment.type || 'application/octet-stream'}; name="${attachment.filename || 'attachment'}"`,
          `Content-Disposition: ${attachment.disposition || 'attachment'}; filename="${attachment.filename || 'attachment'}"`,
          attachment.contentId ? `Content-ID: <${attachment.contentId}>` : '',
          'Content-Transfer-Encoding: base64',
          '',
          attachment.content || '',
        ].filter(Boolean).join('\r\n')),
        `--${mixedBoundary}--`
      ].join('\r\n')
    : messageBody;

  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

async function handleSendGridMail(req: http.IncomingMessage, res: http.ServerResponse) {
  const auth = getHeader(req.headers.authorization);
  if (!auth.startsWith('Bearer ') || !auth.slice(7).trim()) {
    return text(res, 401, 'Missing Bearer token');
  }

  let payload: any;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    return text(res, 400, error instanceof Error ? error.message : 'Invalid JSON');
  }

  const personalizations = Array.isArray(payload.personalizations) && payload.personalizations.length
    ? payload.personalizations
    : [{ to: payload.to ?? [] }];
  const defaultFrom = normalizePerson(payload.from);
  const baseReplyTo = normalizePerson(payload.reply_to);
  const baseSubject = typeof payload.subject === 'string' ? payload.subject : '';
  const { text: plainText, html } = parseSendGridContent(payload.content);
  const attachments = (Array.isArray(payload.attachments) ? payload.attachments : []).map(decodeSendGridAttachment);

  for (const personalization of personalizations) {
    const to = normalizeList(personalization.to);
    const cc = normalizeList(personalization.cc);
    const bcc = normalizeList(personalization.bcc);
    const subject = typeof personalization.subject === 'string' ? personalization.subject : baseSubject;
    const replyTo = normalizePerson(personalization.reply_to) || baseReplyTo;
    const raw = buildRawMessage({
      from: defaultFrom,
      to,
      cc,
      bcc,
      subject,
      text: plainText,
      html,
      replyTo,
      attachments
    });
    const parsed = parseMimeMessage(raw);
    applyMessagePayload({
      source: 'sendgrid-api',
      from: defaultFrom,
      to,
      cc,
      bcc,
      subject,
      headers: Object.fromEntries(parsed.headers.entries()),
      text: parsed.text || plainText,
      html: parsed.html || html,
      raw,
      attachments,
      replyTo,
      envelopeFrom: defaultFrom,
      envelopeTo: to,
      isRead: false
    });
  }

  res.writeHead(202, withCorsHeaders({ 'content-length': '0' }));
  res.end();
}

function handleApi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, searchParams: URLSearchParams) {
  if (req.method === 'GET' && pathname === '/api/health') {
    return json(res, 200, { ok: true, smtpPort: SMTP_PORT, httpPort: HTTP_PORT });
  }

  if (req.method === 'GET' && pathname === '/api/messages') {
    return json(res, 200, store.list(searchParams.get('q') ?? ''));
  }

  if (req.method === 'DELETE' && pathname === '/api/messages') {
    store.clear();
    return json(res, 200, { ok: true });
  }

  const messageMatch = /^\/api\/messages\/([^/]+)$/.exec(pathname);
  if (messageMatch) {
    const message = store.get(messageMatch[1]);
    if (!message) {
      return text(res, 404, 'Message not found');
    }

    if (req.method === 'GET') {
      return json(res, 200, message);
    }

    if (req.method === 'DELETE') {
      store.delete(messageMatch[1]);
      return json(res, 200, { ok: true });
    }
  }

  const readMatch = /^\/api\/messages\/([^/]+)\/(read|unread)$/.exec(pathname);
  if (readMatch && req.method === 'PATCH') {
    const updated = store.markRead(readMatch[1], readMatch[2] === 'read');
    if (!updated) {
      return text(res, 404, 'Message not found');
    }
    return json(res, 200, { ok: true, message: updated });
  }

  const attachMatch = /^\/api\/messages\/([^/]+)\/attachments\/(\d+)$/.exec(pathname);
  if (attachMatch && req.method === 'GET') {
    const message = store.get(attachMatch[1]);
    if (!message) {
      return text(res, 404, 'Message not found');
    }

    const idx = Number(attachMatch[2]);
    const attachment = Array.isArray(message.attachments) ? message.attachments[idx] : undefined;
    if (!attachment) {
      return text(res, 404, 'Attachment not found');
    }

    if (!attachment.content) {
      return text(res, 404, 'Attachment has no content');
    }

    try {
      const buffer = Buffer.from(attachment.content, 'base64');
      const filename = attachment.filename || 'attachment';
      res.writeHead(200, withCorsHeaders({
        'content-type': attachment.type || 'application/octet-stream',
        'content-length': buffer.length,
        'content-disposition': `attachment; filename="${String(filename).replace(/\"/g, '\\\"')}"`
      }));
      res.end(buffer);
      return;
    } catch (err) {
      return text(res, 500, 'Unable to decode attachment');
    }
  }

  return false;
}

function handleEvents(req: http.IncomingMessage, res: http.ServerResponse) {
  res.writeHead(200, withCorsHeaders({
    'content-type': 'text/event-stream; charset=utf-8',
    connection: 'keep-alive',
    'cache-control': 'no-cache, no-transform'
  }));
  res.write('\n');

  const heartbeat = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 15000);

  const onMail = (event: unknown) => {
    res.write(`event: mail\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  mailEvents.on('mail', onMail);

  const cleanup = () => {
    clearInterval(heartbeat);
    mailEvents.off('mail', onMail);
  };

  req.on('close', cleanup);
  req.on('aborted', cleanup);
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host ?? `${HOST}:${HTTP_PORT}`;
  const url = new URL(req.url ?? '/', `http://${host}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, withCorsHeaders());
    res.end();
    return;
  }

  if (req.method === 'POST' && pathname === '/v3/mail/send') {
    return handleSendGridMail(req, res);
  }

  if (req.method === 'GET' && pathname === '/api/events') {
    return handleEvents(req, res);
  }

  const apiHandled = handleApi(req, res, pathname, url.searchParams);
  if (apiHandled !== false) {
    return;
  }

  const staticFile = serveStatic(pathname);
  if (staticFile) {
    const body = fs.readFileSync(staticFile.filePath);
    res.writeHead(200, withCorsHeaders({ 'content-type': staticFile.contentType }));
    res.end(body);
    return;
  }

  if (pathname.startsWith('/api/') || pathname.startsWith('/v3/')) {
    return text(res, 404, 'Not found');
  }

  const indexPath = path.resolve(process.cwd(), '../client/dist/index.html');
  if (fs.existsSync(indexPath)) {
    res.writeHead(200, withCorsHeaders({ 'content-type': 'text/html; charset=utf-8' }));
    res.end(fs.readFileSync(indexPath));
    return;
  }

  text(res, 200, 'SMTP Localhost is running');
});

server.listen(HTTP_PORT, HOST, () => {
  console.log(`HTTP server listening on http://${HOST}:${HTTP_PORT}`);
});

startSmtpServer(store, HOST, SMTP_PORT, MAX_MESSAGE_BYTES);
