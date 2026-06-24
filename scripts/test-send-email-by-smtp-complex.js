#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const host = process.env.SMTP_HOST || "127.0.0.1";
const port = Number(process.env.SMTP_PORT || "11025");
const from =
  process.env.MAIL_FROM ||
  "0100019ee2e810c8-f39edd21-27b5-46db-a255-33ac3f17f76a-000000@atlassian-bounces.atlassian.net";
const to = process.env.MAIL_TO || "receiver@example.com";
const rawEmailPath =
  process.env.RAW_EMAIL_PATH ||
  path.resolve(
    __dirname,
    "fixtures",
    "OpenAI Dev News_ Codex app, tips from OpenAI devs.eml",
  );

function normalizeRawEmail(raw) {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

function createLineReader(socket) {
  let buffer = "";
  const queue = [];
  let pending = null;

  function flushLines() {
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      queue.push(line);
      index = buffer.indexOf("\n");
    }
  }

  function pump() {
    if (!pending) {
      return;
    }

    while (queue.length > 0) {
      const line = queue.shift();
      pending.lines.push(line);

      const match = line.match(/^(\d{3})([ -])/);
      if (match && match[2] === " ") {
        const result = pending;
        pending = null;
        result.resolve(result.lines);
        return;
      }
    }
  }

  socket.on("data", (chunk) => {
    buffer += chunk;
    flushLines();
    pump();
  });

  socket.on("error", (error) => {
    if (pending) {
      pending.reject(error);
      pending = null;
      return;
    }
    console.error(error.message);
    process.exit(1);
  });

  socket.on("close", () => {
    if (pending) {
      pending.reject(new Error("Connection closed unexpectedly"));
      pending = null;
    }
  });

  return {
    readResponse() {
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, lines: [] };
        pump();
      });
    },
  };
}

async function main() {
  if (!fs.existsSync(rawEmailPath)) {
    throw new Error(`Raw email fixture not found: ${rawEmailPath}`);
  }

  const rawEmail = normalizeRawEmail(fs.readFileSync(rawEmailPath, "utf8"));
  const socket = net.createConnection({ host, port });
  socket.setEncoding("utf8");
  const reader = createLineReader(socket);

  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  async function send(command) {
    socket.write(`${command}\r\n`);
    return reader.readResponse();
  }

  const greeting = await reader.readResponse();
  if (!greeting.some((line) => line.startsWith("220"))) {
    throw new Error(`Unexpected greeting: ${greeting.join(" | ")}`);
  }

  const ehloLines = await send("EHLO localhost");
  if (!ehloLines.some((line) => line.startsWith("250"))) {
    throw new Error(`EHLO failed: ${ehloLines.join(" | ")}`);
  }

  const mailFrom = await send(`MAIL FROM:<${from}>`);
  if (!mailFrom.some((line) => line.startsWith("250"))) {
    throw new Error(`MAIL FROM failed: ${mailFrom.join(" | ")}`);
  }

  const rcptTo = await send(`RCPT TO:<${to}>`);
  if (!rcptTo.some((line) => line.startsWith("250"))) {
    throw new Error(`RCPT TO failed: ${rcptTo.join(" | ")}`);
  }

  const data = await send("DATA");
  if (!data.some((line) => line.startsWith("354"))) {
    throw new Error(`DATA failed: ${data.join(" | ")}`);
  }

  socket.write(`${rawEmail}\r\n.\r\n`);
  const accepted = await reader.readResponse();
  if (!accepted.some((line) => line.startsWith("250"))) {
    throw new Error(`Message was not accepted: ${accepted.join(" | ")}`);
  }

  const quit = await send("QUIT");
  if (!quit.some((line) => line.startsWith("221"))) {
    throw new Error(`QUIT failed: ${quit.join(" | ")}`);
  }

  socket.end();
  console.log(`Sent complex SMTP email fixture to ${to} via ${host}:${port}`);
  console.log(`Fixture: ${rawEmailPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
