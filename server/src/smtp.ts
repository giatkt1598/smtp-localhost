import net from 'node:net';
import { MessageStore } from './store.js';
import { parseMimeMessage } from './mime.js';

type SessionState = {
  mailFrom: string;
  recipients: string[];
  dataMode: boolean;
  buffer: string[];
};

function extractEmail(value: string) {
  const match = /<([^>]+)>/.exec(value);
  return (match?.[1] ?? value).trim();
}

function response(lines: string | string[]) {
  return `${(Array.isArray(lines) ? lines : [lines]).join('\r\n')}\r\n`;
}

export function startSmtpServer(store: MessageStore, host: string, port: number, maxBytes: number) {
  const server = net.createServer((socket) => {
    const state: SessionState = {
      mailFrom: '',
      recipients: [],
      dataMode: false,
      buffer: []
    };

    let pending = '';

    socket.setEncoding('utf8');
    socket.write(response('220 smtp-localhost ready'));

    socket.on('data', (chunk) => {
      pending += chunk;

      while (pending.includes('\n')) {
        const index = pending.indexOf('\n');
        const line = pending.slice(0, index).replace(/\r$/, '');
        pending = pending.slice(index + 1);

        if (state.dataMode) {
          if (line === '.') {
            const rawMessage = state.buffer
              .map((entry) => (entry.startsWith('..') ? entry.slice(1) : entry))
              .join('\r\n');

            if (Buffer.byteLength(rawMessage) > maxBytes) {
              socket.write(response('552 Message too large'));
            } else {
              const parsed = parseMimeMessage(rawMessage);
              store.insert({
                source: 'smtp',
                isRead: false,
                from: parsed.from || state.mailFrom || '',
                to: parsed.to.length ? parsed.to : state.recipients,
                cc: parsed.cc,
                bcc: parsed.bcc,
                subject: parsed.subject,
                headers: Object.fromEntries(parsed.headers.entries()),
                text: parsed.text,
                html: parsed.html,
                raw: rawMessage,
                attachments: parsed.attachments,
                replyTo: parsed.replyTo,
                envelopeFrom: state.mailFrom,
                envelopeTo: state.recipients
              });
              socket.write(response('250 Message accepted'));
            }

            state.dataMode = false;
            state.buffer = [];
            state.mailFrom = '';
            state.recipients = [];
            continue;
          }

          state.buffer.push(line);
          continue;
        }

        const [commandRaw, ...restParts] = line.trim().split(/\s+/);
        const command = commandRaw?.toUpperCase();
        const rest = restParts.join(' ');

        switch (command) {
          case 'EHLO':
            socket.write(response(['250-smtp-localhost', '250-8BITMIME', '250 PIPELINING']));
            break;
          case 'HELO':
            socket.write(response('250 smtp-localhost'));
            break;
          case 'MAIL':
            state.mailFrom = extractEmail(rest.replace(/^FROM:/i, ''));
            state.recipients = [];
            socket.write(response('250 OK'));
            break;
          case 'RCPT':
            state.recipients.push(extractEmail(rest.replace(/^TO:/i, '')));
            socket.write(response('250 OK'));
            break;
          case 'DATA':
            if (!state.recipients.length) {
              socket.write(response('503 Need RCPT TO first'));
            } else {
              state.dataMode = true;
              state.buffer = [];
              socket.write(response('354 End data with <CR><LF>.<CR><LF>'));
            }
            break;
          case 'RSET':
            state.mailFrom = '';
            state.recipients = [];
            state.dataMode = false;
            state.buffer = [];
            socket.write(response('250 OK'));
            break;
          case 'NOOP':
            socket.write(response('250 OK'));
            break;
          case 'QUIT':
            socket.write(response('221 Bye'));
            socket.end();
            break;
          default:
            socket.write(response('502 Command not implemented'));
        }
      }
    });

    socket.on('error', () => undefined);
  });

  server.listen(port, host);
  return server;
}
