import type { AttachmentRecord, StoredMessage } from './types.js';

const headerValue = (headers: Map<string, string>, key: string) =>
  headers.get(key.toLowerCase()) ?? '';

function unfoldHeaders(rawHeaders: string) {
  const lines = rawHeaders.replace(/\r\n/g, '\n').split('\n');
  const result: string[] = [];

  for (const line of lines) {
    if (/^[ \t]/.test(line) && result.length) {
      result[result.length - 1] += ` ${line.trim()}`;
    } else if (line.trim()) {
      result.push(line.trim());
    }
  }

  return result;
}

function parseHeaders(rawHeaders: string) {
  const headers = new Map<string, string>();
  for (const line of unfoldHeaders(rawHeaders)) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers.set(name, value);
  }
  return headers;
}

function splitMime(raw: string) {
  const separatorIndex = raw.search(/\r?\n\r?\n/);
  if (separatorIndex === -1) {
    return { rawHeaders: '', body: raw };
  }

  const rawHeaders = raw.slice(0, separatorIndex);
  const body = raw.slice(separatorIndex).replace(/^\r?\n\r?\n/, '');
  return { rawHeaders, body };
}

function parseAddressList(value: string) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^<|>$/g, '').trim());
}

function decodeBase64(value: string) {
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function parseContentType(contentType: string) {
  const [type = 'text/plain', ...params] = contentType.split(';').map((item) => item.trim());
  const attributes = new Map<string, string>();
  for (const param of params) {
    const index = param.indexOf('=');
    if (index === -1) continue;
    const name = param.slice(0, index).trim().toLowerCase();
    const value = param.slice(index + 1).trim().replace(/^"|"$/g, '');
    attributes.set(name, value);
  }
  return { type: type.toLowerCase(), attributes };
}

function parseMultipart(body: string, boundary: string) {
  const marker = `--${boundary}`;
  const terminator = `${marker}--`;
  const parts: string[] = [];
  let current = '';

  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    if (line === marker || line === terminator) {
      if (current.trim()) {
        parts.push(current.trim());
      }
      current = '';
      if (line === terminator) break;
      continue;
    }
    if (current) {
      current += '\n';
    }
    current += line;
  }

  return parts;
}

function extractBodyParts(body: string, contentType: string): { text: string; html: string } {
  const { type, attributes } = parseContentType(contentType);

  if (type.startsWith('multipart/')) {
    const boundary = attributes.get('boundary');
    if (!boundary) {
      return { text: '', html: '' };
    }

    let text = '';
    let html = '';

    for (const part of parseMultipart(body, boundary)) {
      const split = splitMime(part);
      const headers = parseHeaders(split.rawHeaders);
      const nested = extractBodyParts(split.body, headerValue(headers, 'content-type') || 'text/plain');
      const nestedType = parseContentType(headerValue(headers, 'content-type') || 'text/plain').type;

      if (!text && nested.text && nestedType.includes('text/plain')) {
        text = nested.text;
      }
      if (!html && nested.html && nestedType.includes('text/html')) {
        html = nested.html;
      }
      if (!text && nestedType === 'text/plain') {
        text = split.body.trim();
      }
      if (!html && nestedType === 'text/html') {
        html = split.body.trim();
      }
    }

    return { text, html };
  }

  if (type === 'text/html') {
    return { text: '', html: body.trim() };
  }

  return { text: body.trim(), html: '' };
}

export function parseMimeMessage(raw: string) {
  const { rawHeaders, body } = splitMime(raw);
  const headers = parseHeaders(rawHeaders);
  const contentType = headerValue(headers, 'content-type') || 'text/plain';
  const extracted = extractBodyParts(body, contentType);
  const attachments: AttachmentRecord[] = [];
  const disposition = headerValue(headers, 'content-disposition');

  if (disposition.toLowerCase().includes('attachment')) {
    attachments.push({
      filename: /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? 'attachment',
      type: contentType,
      content: body.trim(),
      size: Buffer.byteLength(body)
    });
  }

  return {
    headers,
    from: headerValue(headers, 'from'),
    to: parseAddressList(headerValue(headers, 'to')),
    cc: parseAddressList(headerValue(headers, 'cc')),
    bcc: parseAddressList(headerValue(headers, 'bcc')),
    replyTo: headerValue(headers, 'reply-to'),
    subject: headerValue(headers, 'subject'),
    text: extracted.text,
    html: extracted.html,
    attachments,
    contentType: contentType.toLowerCase()
  };
}

export function parseSendGridContent(content?: Array<{ type?: string; value?: string }>) {
  let text = '';
  let html = '';

  for (const item of content ?? []) {
    if (!item?.type) continue;
    if (item.type === 'text/plain') text = item.value ?? '';
    if (item.type === 'text/html') html = item.value ?? '';
  }

  return { text, html };
}

export function decodeSendGridAttachment(item: {
  filename?: string;
  type?: string;
  content?: string;
  disposition?: string;
  content_id?: string;
}) {
  const content = item.content ? decodeBase64(item.content) : '';
  return {
    filename: item.filename ?? 'attachment',
    type: item.type,
    content: item.content,
    contentId: item.content_id,
    disposition: item.disposition,
    size: Buffer.byteLength(content)
  };
}

export function summarizeMessage(message: StoredMessage) {
  return {
    id: message.id,
    source: message.source,
    createdAt: message.createdAt,
    isRead: message.isRead,
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    raw: message.raw,
    attachments: message.attachments
  };
}
