# SMTP Localhost

`SMTP Localhost` is a local email sandbox for development and testing. It combines:

- a lightweight SMTP server for receiving mail from local applications
- a SendGrid-compatible HTTP API for programmatic message submission
- a mailbox-style web UI for browsing, searching, and inspecting received mail
- realtime inbox updates in the browser

The goal is to make email workflows easy to verify on `localhost` without relying on a real mail relay.

## Features

- Receives mail over SMTP on `localhost:11025`
- Accepts SendGrid-style requests at `POST /v3/mail/send`
- Stores messages in memory and persists them as chunked JSON files under `server/data/mailbox`
- Serves a web UI at `http://localhost:18025`
- Pushes realtime inbox updates when new mail arrives
- Supports search, message detail views, plain text, raw source, and JSON metadata
- Allows messages to be marked as `read` or `unread`
- Supports deleting individual messages or clearing the entire inbox

## Requirements

- Node.js 20 or newer
- npm
- Docker and Docker Compose for container-based runs

## Run Locally

```bash
npm install
npm run dev
```

Then open:

- Web UI: `http://localhost:18025`
- SMTP: `localhost:11025`

## Build and Start

```bash
npm run build
npm run start
```

## Run with Docker

```bash
docker compose up --build
```

Then open:

- Web UI: `http://localhost:18025`
- SMTP: `localhost:11025`

## Test Send Scripts

### Send via SMTP

```bash
npm run send:smtp
```

### Send via HTTP API

```bash
npm run send:http
```

## Configuration

### SMTP Configuration

Use these values when configuring any SMTP client:

- Host: `localhost`
- Port: `11025`
- TLS/SSL: disabled
- Authentication: not required
- Accepted server commands: `HELO`, `EHLO`, `MAIL FROM`, `RCPT TO`, `DATA`, `RSET`, `NOOP`, `QUIT`

Recommended local test values:

- `SMTP_HOST=localhost`
- `SMTP_PORT=11025`

Example `nodemailer` transport:

```js
{
  host: "localhost",
  port: 11025,
  secure: false,
  ignoreTLS: true
}
```

### HTTP Configuration

The HTTP server exposes both the mailbox UI and the API on the same port:

- Base URL: `http://localhost:18025`
- UI: `GET /`
- Health check: `GET /api/health`
- Inbox API: `GET /api/messages`
- SendGrid-compatible endpoint: `POST /v3/mail/send`

SendGrid-compatible request rules:

- Required header: `Authorization: Bearer <any-non-empty-token>`
- Accepted content type: `application/json`
- CORS: enabled for all origins
- Realtime inbox updates: `GET /api/events` via Server-Sent Events

Supported SendGrid payload fields include:

- `from`
- `personalizations`
- `reply_to`
- `subject`
- `content`
- `attachments`

Example HTTP request:

```bash
curl -X POST http://localhost:18025/v3/mail/send \
  -H "Authorization: Bearer local-test-token" \
  -H "Content-Type: application/json" \
  -d '{
    "from": { "email": "sender@example.com" },
    "personalizations": [
      { "to": [{ "email": "receiver@example.com" }] }
    ],
    "subject": "Test message",
    "content": [
      { "type": "text/plain", "value": "Hello from SMTP Localhost" }
    ]
  }'
```

### Runtime Defaults

- `HOST` - bind address used by the HTTP and SMTP servers
- `HTTP_PORT` - defaults to `18025`
- `SMTP_PORT` - defaults to `11025`
- `MAIL_DATA_DIR` - defaults to `server/data/mailbox`
- `MAIL_CHUNK_SIZE` - defaults to `25`
- `MAIL_CHUNK_MAX_BYTES` - defaults to `524288`
- `MAX_MESSAGE_BYTES` - defaults to `10485760`

When running in Docker, the service binds to `0.0.0.0` inside the container and the same ports are exposed on the host.

## Local API

- `GET /api/health`
- `GET /api/messages`
- `GET /api/messages/:id`
- `PATCH /api/messages/:id/read`
- `PATCH /api/messages/:id/unread`
- `DELETE /api/messages/:id`
- `DELETE /api/messages`
- `GET /api/events`

## Environment Variables

### Server

- `HOST` - bind address for the HTTP and SMTP servers
- `HTTP_PORT` - defaults to `18025`
- `SMTP_PORT` - defaults to `11025`
- `MAIL_DATA_DIR` - defaults to `server/data/mailbox`
- `MAIL_CHUNK_SIZE` - defaults to `25`
- `MAIL_CHUNK_MAX_BYTES` - defaults to `524288`
- `MAX_MESSAGE_BYTES` - defaults to `10485760`

### Test Scripts

- `SMTP_HOST`
- `SMTP_PORT`
- `HTTP_HOST`
- `HTTP_PORT`
- `MAIL_FROM`
- `MAIL_TO`
- `MAIL_SUBJECT`
- `MAIL_BODY`
- `MAIL_TEXT`
- `MAIL_HTML`
- `SENDGRID_API_KEY`

## Project Structure

```text
.
├── client/   # React + Vite frontend
├── server/   # Node.js + TypeScript backend
├── scripts/  # helper scripts
├── Dockerfile
├── docker-compose.yaml
└── README.md
```

## Notes

- This tool is intended for local development only.
- It is not a production-grade mail relay or persistent database.
- When the server restarts, the inbox is restored from the chunked JSON data stored in `MAIL_DATA_DIR`.
