import { TextDecoder } from 'node:util';
import type { AttachmentRecord, StoredMessage } from './types.js';

type HeaderParams = {
  value: string;
  params: Map<string, string>;
};

type MimePart = {
  headers: Map<string, string>;
  contentType: string;
  contentTypeRaw: string;
  contentParams: Map<string, string>;
  disposition: string;
  dispositionRaw: string;
  dispositionParams: Map<string, string>;
  transferEncoding: string;
  body: string;
  content: Buffer;
  children: MimePart[];
};

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

function splitHeaderParams(value: string) {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      inQuote = !inQuote;
      current += char;
      continue;
    }

    if (char === ';' && !inQuote) {
      parts.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

function unquote(value: string) {
  return value.trim().replace(/^"|"$/g, '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function decodePercentBytes(value: string) {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '%' && /^[0-9a-fA-F]{2}$/.test(value.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(value.charCodeAt(index));
    }
  }
  return Buffer.from(bytes);
}

function decodeBuffer(buffer: Buffer, charset = 'utf-8') {
  const normalized = charset.trim().toLowerCase() || 'utf-8';
  try {
    return new TextDecoder(normalized).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

function decodeRfc2231Value(value: string) {
  const match = /^([^']*)'[^']*'(.*)$/.exec(value);
  if (!match) {
    return decodeMimeWords(value);
  }

  return decodeBuffer(decodePercentBytes(match[2]), match[1] || 'utf-8');
}

function decodeQuotedPrintable(value: string) {
  const normalized = value.replace(/=\r?\n/g, '');
  const bytes: number[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char !== '=') {
      bytes.push(char.charCodeAt(0));
      continue;
    }

    const next = normalized.slice(index + 1, index + 3);
    if (/^[0-9a-fA-F]{2}$/.test(next)) {
      bytes.push(Number.parseInt(next, 16));
      index += 2;
      continue;
    }

    bytes.push('='.charCodeAt(0));
  }

  return Buffer.from(bytes);
}

function decodeMimeWords(value: string) {
  return value.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_match, charset: string, encoding: string, payload: string) => {
    try {
      const buffer = encoding.toUpperCase() === 'B'
        ? Buffer.from(payload.replace(/\s+/g, ''), 'base64')
        : decodeQuotedPrintable(payload.replace(/_/g, ' '));
      return decodeBuffer(buffer, charset);
    } catch {
      return _match;
    }
  });
}

function parseHeaderWithParams(value: string): HeaderParams {
  const [rawValue = '', ...params] = splitHeaderParams(value);
  const parsedParams = new Map<string, string>();

  for (const param of params) {
    const index = param.indexOf('=');
    if (index === -1) continue;
    const name = param.slice(0, index).trim().toLowerCase();
    const rawParamValue = unquote(param.slice(index + 1));
    parsedParams.set(
      name.replace(/\*$/, ''),
      name.endsWith('*') ? decodeRfc2231Value(rawParamValue) : decodeMimeWords(rawParamValue)
    );
  }

  return {
    value: rawValue.trim().toLowerCase(),
    params: parsedParams
  };
}

function parseAddressList(value: string) {
  const entries: string[] = [];
  let current = '';
  let inQuote = false;
  let inAngle = false;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      inQuote = !inQuote;
      current += char;
      continue;
    }

    if (char === '<' && !inQuote) {
      inAngle = true;
      current += char;
      continue;
    }

    if (char === '>' && !inQuote) {
      inAngle = false;
      current += char;
      continue;
    }

    if (char === ',' && !inQuote && !inAngle) {
      if (current.trim()) entries.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) entries.push(current.trim());

  return entries.map((entry) => decodeMimeWords(entry).replace(/^"([^"]+)"\s*</, '$1 <').trim());
}

function decodeBodyBuffer(rawBody: string, transferEncoding: string) {
  const encoding = transferEncoding.trim().toLowerCase();

  if (encoding === 'base64') {
    return Buffer.from(rawBody.replace(/\s+/g, ''), 'base64');
  }

  if (encoding === 'quoted-printable') {
    return decodeQuotedPrintable(rawBody);
  }

  return Buffer.from(rawBody, 'utf8');
}

function decodeTextBody(rawBody: string, contentType: HeaderParams, transferEncoding: string) {
  return decodeBuffer(decodeBodyBuffer(rawBody, transferEncoding), contentType.params.get('charset') || 'utf-8');
}

function parseMultipart(body: string, boundary: string) {
  const marker = `--${boundary}`;
  const terminator = `${marker}--`;
  const parts: string[] = [];
  let current = '';
  let collecting = false;

  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    if (line === marker || line === terminator) {
      if (collecting && current.trim()) {
        parts.push(current.replace(/\n$/, ''));
      }
      current = '';
      collecting = line !== terminator;
      if (line === terminator) break;
      continue;
    }

    if (!collecting) continue;
    current += `${line}\n`;
  }

  return parts;
}

function parsePart(raw: string): MimePart {
  const { rawHeaders, body } = splitMime(raw);
  const headers = parseHeaders(rawHeaders);
  const contentTypeRaw = headerValue(headers, 'content-type') || 'text/plain; charset=utf-8';
  const contentType = parseHeaderWithParams(contentTypeRaw);
  const dispositionRaw = headerValue(headers, 'content-disposition');
  const disposition = parseHeaderWithParams(dispositionRaw);
  const transferEncoding = headerValue(headers, 'content-transfer-encoding');
  const type = contentType.value || 'text/plain';
  const children = type.startsWith('multipart/')
    ? parseMultipart(body, contentType.params.get('boundary') || '').map(parsePart)
    : [];

  return {
    headers,
    contentType: type,
    contentTypeRaw,
    contentParams: contentType.params,
    disposition: disposition.value,
    dispositionRaw,
    dispositionParams: disposition.params,
    transferEncoding,
    body,
    content: children.length ? Buffer.alloc(0) : decodeBodyBuffer(body, transferEncoding),
    children
  };
}

function isAttachment(part: MimePart) {
  return Boolean(
    !part.children.length &&
    (
      part.disposition === 'attachment' ||
      part.dispositionParams.has('filename') ||
      part.contentParams.has('name') ||
      (part.disposition === 'inline' && headerValue(part.headers, 'content-id'))
    )
  );
}

function attachmentFilename(part: MimePart) {
  return (
    part.dispositionParams.get('filename') ||
    part.contentParams.get('name') ||
    headerValue(part.headers, 'content-id').replace(/^<|>$/g, '') ||
    'attachment'
  );
}

function collectAttachments(part: MimePart, attachments: AttachmentRecord[] = []) {
  if (isAttachment(part)) {
    attachments.push({
      filename: attachmentFilename(part),
      type: part.contentType,
      content: part.content.toString('base64'),
      contentId: headerValue(part.headers, 'content-id').replace(/^<|>$/g, '') || undefined,
      disposition: part.dispositionRaw || undefined,
      size: part.content.byteLength
    });
  }

  for (const child of part.children) {
    collectAttachments(child, attachments);
  }

  return attachments;
}

function collectBodies(part: MimePart): { text: string; html: string } {
  if (part.children.length) {
    let text = '';
    let html = '';

    for (const child of part.children) {
      const nested = collectBodies(child);
      if (!text && nested.text) text = nested.text;
      if (!html && nested.html) html = nested.html;
    }

    return { text, html };
  }

  if (isAttachment(part)) {
    return { text: '', html: '' };
  }

  if (part.contentType === 'text/html') {
    return {
      text: '',
      html: decodeTextBody(part.body, { value: part.contentType, params: part.contentParams }, part.transferEncoding).trim()
    };
  }

  if (part.contentType === 'text/plain' || part.contentType.startsWith('text/')) {
    return {
      text: decodeTextBody(part.body, { value: part.contentType, params: part.contentParams }, part.transferEncoding).trim(),
      html: ''
    };
  }

  return { text: '', html: '' };
}

function rewriteCidLinks(html: string, attachments: AttachmentRecord[]) {
  const byContentId = new Map(
    attachments
      .filter((attachment) => attachment.contentId && attachment.content)
      .map((attachment) => [
        attachment.contentId!.toLowerCase(),
        `data:${attachment.type || 'application/octet-stream'};base64,${attachment.content}`
      ])
  );

  return html.replace(/cid:([^"')\s>]+)/gi, (match, rawContentId: string) => {
    const contentId = decodeURIComponent(rawContentId).replace(/^<|>$/g, '').toLowerCase();
    return byContentId.get(contentId) ?? match;
  });
}

function decodedHeaders(headers: Map<string, string>) {
  return new Map(Array.from(headers.entries()).map(([key, value]) => [key, decodeMimeWords(value)]));
}

function decodeBase64(value: string) {
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

export function parseMimeMessage(raw: string) {
  const root = parsePart(raw);
  const headers = decodedHeaders(root.headers);
  const bodies = collectBodies(root);
  const attachments = collectAttachments(root);

  return {
    headers,
    from: decodeMimeWords(headerValue(root.headers, 'from')),
    to: parseAddressList(headerValue(root.headers, 'to')),
    cc: parseAddressList(headerValue(root.headers, 'cc')),
    bcc: parseAddressList(headerValue(root.headers, 'bcc')),
    replyTo: decodeMimeWords(headerValue(root.headers, 'reply-to')),
    subject: decodeMimeWords(headerValue(root.headers, 'subject')),
    text: bodies.text,
    html: rewriteCidLinks(bodies.html, attachments),
    attachments,
    contentType: root.contentType
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
