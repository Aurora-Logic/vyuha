import { uuidv7 } from '@vyuha/shared';
import { createTransport } from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { waitForMessage } from '../../test-support/mailpit.js';
import { env } from '../common/env.js';
import { LogMailer } from './mailer.js';
import { SmtpMailer, smtpRequiresTls } from './smtp-mailer.js';

/**
 * Sends real mail over a real socket and reads it back out of the receiving
 * server. Nothing here is stubbed, because a stub could only prove that
 * `sendMail` was called -- which was already true when the transport did not
 * exist.
 *
 * Mailpit is required, not optional, in the same way the rest of the suite
 * requires Postgres and MinIO. A test that quietly skips when the dependency
 * is missing reports green for a transport nobody exercised.
 */

describe('SMTP mailer against Mailpit', () => {
  it('requires TLS for remote SMTP and all production delivery', () => {
    expect(smtpRequiresTls('smtp.example.test', 'development')).toBe(true);
    expect(smtpRequiresTls('localhost', 'production')).toBe(true);
    expect(smtpRequiresTls('127.0.0.1', 'test')).toBe(false);
    expect(smtpRequiresTls('localhost', 'development')).toBe(false);
  });
  let mailer: SmtpMailer;

  beforeAll(() => {
    mailer = new SmtpMailer();
  });

  afterAll(() => {
    mailer.onApplicationShutdown();
  });

  it('delivers a message the receiving server can produce in full', async () => {
    // Unique per run: Mailpit keeps history, and matching on a fixed subject
    // would pass against a message left behind by an earlier run.
    const subject = `Invitation probe ${uuidv7()}`;
    const actionUrl = `${env.WEB_BASE_URL}/accept-invitation/probe-token-${uuidv7()}`;

    await mailer.send({
      to: 'probe@vyuha.test',
      subject,
      body: 'An administrator has created an account for you.',
      actionUrl,
    });

    const captured = await waitForMessage(subject);
    expect(captured).not.toBeNull();
    expect(captured?.to).toContain('probe@vyuha.test');
    expect(captured?.text).toContain('An administrator has created an account for you.');
    // The link is the whole point of the message; a body that arrives without
    // it is a delivered invitation nobody can accept.
    expect(captured?.text).toContain(actionUrl);
    // Generous, and deliberately larger than `waitForMessage`'s own budget:
    // otherwise the test times out first and reports "timed out" for what is
    // actually "Mailpit was slow", which sends the reader to the wrong file.
  }, 30_000);

  it('rejects rather than resolving when the server cannot be reached', async () => {
    const unreachable = new SmtpMailer();
    // Port 1 is reserved and nothing listens on it, so this exercises the
    // connect failure path rather than a protocol-level rejection.
    Reflect.set(
      unreachable,
      'transport',
      createTransport({ host: '127.0.0.1', port: 1, connectionTimeout: 1_000 }),
    );

    await expect(
      unreachable.send({ to: 'nobody@vyuha.test', subject: 'unreachable', body: 'x' }),
    ).rejects.toThrow(/SMTP delivery to nobody@vyuha\.test failed/u);

    unreachable.onApplicationShutdown();
  });
});

describe('log mailer', () => {
  it('still resolves, so it remains usable as the offline transport', async () => {
    await expect(
      new LogMailer().send({ to: 'nobody@vyuha.test', subject: 'logged', body: 'x' }),
    ).resolves.toBeUndefined();
  });
});
