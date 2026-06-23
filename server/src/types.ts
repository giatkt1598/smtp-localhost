export type MessageSource = 'smtp' | 'sendgrid-api';

export type AttachmentRecord = {
  filename: string;
  type?: string;
  content?: string;
  contentId?: string;
  disposition?: string;
  size: number;
};

export type StoredMessage = {
  id: string;
  source: MessageSource;
  createdAt: string;
  isRead: boolean;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  headers: Record<string, string>;
  text: string;
  html: string;
  raw: string;
  attachments: AttachmentRecord[];
  replyTo?: string;
  envelopeFrom?: string;
  envelopeTo: string[];
};

export type MessageSummary = Pick<
  StoredMessage,
  'id' | 'source' | 'createdAt' | 'isRead' | 'from' | 'to' | 'subject' | 'text' | 'html' | 'raw' | 'attachments'
>;

export type MessageListResponse = {
  items: MessageSummary[];
  total: number;
};
