import nodemailer from 'nodemailer';

import type { Config } from '../config.js';

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Only kept by the in-memory mailer, so development and tests can read the code. Never sent. */
  code?: string;
}

export interface Mailer {
  readonly kind: 'smtp' | 'memory';
  /** Emails kept in memory (development and tests). Absent when every email really leaves the server. */
  readonly outbox?: MemoryMailer;
  send(mail: Mail): Promise<void>;
}

/** Sends real email through your SMTP provider. */
export class SmtpMailer implements Mailer {
  readonly kind = 'smtp' as const;
  private readonly transport;
  private readonly from: string;

  constructor(mail: NonNullable<Config['mail']>) {
    this.from = mail.from;
    this.transport = nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      auth: mail.user ? { user: mail.user, pass: mail.pass ?? '' } : undefined,
    });
  }

  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: mail.to, subject: mail.subject, html: mail.html, text: mail.text });
  }
}

/** Keeps emails in memory. Used in tests and in development when no SMTP server is configured. */
export class MemoryMailer implements Mailer {
  readonly kind = 'memory' as const;
  readonly outbox = this;
  readonly sent: Mail[] = [];

  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
    if (this.sent.length > 200) {
      this.sent.shift();
    }
  }

  to(email: string): Mail[] {
    return this.sent.filter(m => m.to.toLowerCase() === email.toLowerCase());
  }

  /** The newest verification code sent to this address. */
  lastCode(email: string): string {
    const mail = [...this.to(email)].reverse().find(m => m.code);
    if (!mail?.code) {
      throw new Error(`No code was emailed to ${email}`);
    }
    return mail.code;
  }

  reset() {
    this.sent.length = 0;
  }
}

/** Addresses that can never receive real mail: reserved test domains. */
const FAKE_ADDRESS = /@(?:[^@]*\.)?(?:example\.(?:com|org|net)|[^@.]*\.(?:test|invalid|local|localhost))$/i;

/**
 * Development with SMTP configured: real addresses get a real email, but addresses that cannot exist
 * (`.test`, example.com ...) are kept in memory, so seeded and test accounts can still sign in.
 */
class DevRoutingMailer implements Mailer {
  readonly kind = 'smtp' as const;
  readonly outbox = new MemoryMailer();

  constructor(private readonly smtp: SmtpMailer) {}

  async send(mail: Mail): Promise<void> {
    if (FAKE_ADDRESS.test(mail.to)) {
      return this.outbox.send(mail);
    }
    return this.smtp.send(mail);
  }
}

export function createMailer(config: Config): Mailer {
  if (!config.mail) {
    return new MemoryMailer();
  }
  const smtp = new SmtpMailer(config.mail);
  return config.nodeEnv === 'production' ? smtp : new DevRoutingMailer(smtp);
}
