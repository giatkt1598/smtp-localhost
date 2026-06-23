import { EventEmitter } from 'node:events';
import type { MessageSummary } from './types.js';

export type MailEvent =
  | { kind: 'new-message'; message: MessageSummary }
  | { kind: 'inbox-updated' };

class MailEventBus extends EventEmitter {
  publish(event: MailEvent) {
    this.emit('mail', event);
  }
}

export const mailEvents = new MailEventBus();
