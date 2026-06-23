#!/usr/bin/env node

import { randomUUID } from "node:crypto";

const host = process.env.HTTP_HOST || "127.0.0.1";
const port = Number(process.env.HTTP_PORT || "18025");
const from = process.env.MAIL_FROM || "sender@example.com";
const to = process.env.MAIL_TO || "receiver@example.com";
const subject = process.env.MAIL_SUBJECT || "Test message";
const text = process.env.MAIL_TEXT || "Hello from test-send-email-by-http.js";
const html =
  process.env.MAIL_HTML ||
  `<p>${text}. <br><br> <b>This is a test message.</b> <br><br> Message ID: ${randomUUID()}</p>`;
const apiKey = process.env.SENDGRID_API_KEY || "local-test";

async function main() {
  const response = await fetch(`http://${host}:${port}/v3/mail/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: { email: from },
      personalizations: [
        {
          to: [{ email: to }],
        },
      ],
      subject,
      content: [
        { type: "text/plain", value: text },
        { type: "text/html", value: html },
      ],
    }),
  });

  if (response.status !== 202) {
    const body = await response.text();
    throw new Error(`HTTP send failed: ${response.status} ${body}`);
  }

  console.log(`Sent test email to ${to} via ${host}:${port}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
