import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type SMTPPool from 'nodemailer/lib/smtp-pool/index.js';

import { env } from '../common/env.js';
import { describeError } from '../common/errors.js';
import { Mailer, type OutboundMail } from './mailer.js';

/**
 * The real transport (REQ-L-04). Selected by `MAIL_TRANSPORT`; `LogMailer`
 * stays the other half of that switch.
 *
 * Plain text, deliberately. REQ-L-04 is a configurable SMTP server with a test
 * send, not a template system: an HTML template needs a layout, an inliner, a
 * text fallback, and a preview -- infrastructure with no requirement behind it
 * yet, and a second place for the org logo to be wrong. A body and a link on
 * its own line is what an invitation actually needs.
 *
 * **Nothing here logs the link.** `actionUrl` carries a live single-use
 * invitation or reset token (REQ-B-03, REQ-B-04), and a token in a log
 * aggregator is a token in the hands of anyone who can read logs. `LogMailer`
 * prints it because printing it *is* its delivery mechanism, and it refuses to
 * do so in production.
 */

/** Bounds a wedged or tarpitting server; a hung send would hang the request. */
const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

/** Local development mail sinks may be plaintext; remote delivery must not downgrade. */
export function smtpRequiresTls(host: string, nodeEnv: string): boolean {
  return nodeEnv === 'production' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host.toLowerCase());
}

@Injectable()
export class SmtpMailer extends Mailer implements OnApplicationShutdown {
  private readonly logger = new Logger('Mailer');
  /**
   * The generic matters: `Transporter` defaults to `Transporter<any>`, and
   * everything read off `sendMail`'s result would then be an unchecked `any`
   * -- including `rejected`, which is what the delivery check below turns on.
   */
  private readonly transport: Transporter<SMTPPool.SentMessageInfo, SMTPPool.Options>;

  constructor() {
    super();
    this.transport = createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      requireTLS: smtpRequiresTls(env.SMTP_HOST, env.NODE_ENV),
      tls: { minVersion: 'TLSv1.2' },
      // Mailpit accepts unauthenticated mail. Passing an `auth` object with an
      // empty user makes nodemailer attempt AUTH anyway, which Mailpit refuses.
      ...(env.SMTP_USER === undefined
        ? {}
        : { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } }),
      // One connection reused across an invitation batch rather than a TCP
      // handshake and a TLS negotiation per recipient.
      pool: true,
      maxConnections: 3,
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
    });
  }

  async send(mail: OutboundMail): Promise<void> {
    const text =
      mail.actionUrl === undefined ? `${mail.body}\n` : `${mail.body}\n\n${mail.actionUrl}\n`;

    try {
      const info = await this.transport.sendMail({
        from: env.MAIL_FROM,
        to: mail.to,
        subject: mail.subject,
        text,
        ...(mail.html === undefined ? {} : { html: mail.html }),
        ...(mail.replyTo === undefined ? {} : { replyTo: mail.replyTo }),
      });

      // A server can accept the envelope and reject a recipient inside it. That
      // is a delivery failure and reads as success unless it is checked.
      if (info.rejected.length > 0) {
        throw new Error(`the server rejected ${String(info.rejected.length)} recipient(s)`);
      }

      this.logger.log({
        msg: 'Mail accepted by the SMTP server',
        to: mail.to,
        subject: mail.subject,
        messageId: info.messageId,
      });
    } catch (error: unknown) {
      // Rethrown with context rather than swallowed. Whether a caller may let
      // that reach the client is the caller's decision -- see `AuthService`,
      // where two paths deliberately absorb it because the difference between
      // "sent" and "failed" would say whether an account exists.
      throw new Error(
        `SMTP delivery to ${mail.to} failed: ${describeError(error)}`,
        { cause: error },
      );
    }
  }

  onApplicationShutdown(): void {
    // Pooled connections keep the event loop alive; without this `pnpm dev`
    // hangs on reload and a container ignores SIGTERM until it is killed.
    this.transport.close();
  }
}
