import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';

import type { Database } from '../db/db.provider.js';
import { notificationOutbox } from '../db/schema/index.js';

type Outcome = 'SENDING' | 'SENT' | 'FAILED' | 'UNCERTAIN';

/** Durable, fenced progress for a single notification envelope (REQ-K-02). */
export class DeliveryProgress {
  private constructor(
    private readonly db: Database,
    private readonly orgId: string,
    readonly id: string,
    private readonly token: string,
    private readonly outcomes: Record<string, Outcome>,
  ) {}

  static async claim(db: Database, orgId: string, id: string): Promise<DeliveryProgress | null> {
    const token = randomUUID();
    const rows = await db.update(notificationOutbox).set({
      claimToken: token,
      claimUntil: sql`now() + interval '5 minutes'`,
      updatedAt: new Date(),
    }).where(and(
      eq(notificationOutbox.orgId, orgId),
      eq(notificationOutbox.id, id),
      sql`${notificationOutbox.state} IN ('PENDING', 'ENQUEUED')`,
      sql`(${notificationOutbox.claimUntil} IS NULL OR ${notificationOutbox.claimUntil} < now())`,
    )).returning({ progress: notificationOutbox.progress });
    const row = rows[0];
    if (row === undefined) return null;
    const raw = row.progress;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid durable notification progress. Operator recovery required.');
    }
    const outcomes: Record<string, Outcome> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!['SENDING', 'SENT', 'FAILED', 'UNCERTAIN'].includes(String(value))) {
        throw new Error('Unknown durable notification outcome. Operator recovery required.');
      }
      outcomes[key] = value as Outcome;
    }
    return new DeliveryProgress(db, orgId, id, token, outcomes);
  }

  outcome(key: string): Outcome | undefined { return this.outcomes[key]; }

  async record(key: string, outcome: Outcome): Promise<void> {
    this.outcomes[key] = outcome;
    await this.update({
      progress: { ...this.outcomes },
      claimUntil: sql`now() + interval '5 minutes'`,
    });
  }

  async finish(failed: number): Promise<void> {
    const uncertain = Object.values(this.outcomes).some((value) => value === 'UNCERTAIN');
    await this.update({
      state: failed > 0 ? 'PENDING' : uncertain ? 'ATTENTION' : 'DELIVERED',
      runAfter: sql`now() + interval '30 seconds'`,
      claimToken: null,
      claimUntil: null,
    });
  }

  private async update(values: PgUpdateSetSource<typeof notificationOutbox>): Promise<void> {
    const rows = await this.db.update(notificationOutbox).set({ ...values, updatedAt: new Date() })
      .where(and(
        eq(notificationOutbox.orgId, this.orgId),
        eq(notificationOutbox.id, this.id),
        eq(notificationOutbox.claimToken, this.token),
      )).returning({ id: notificationOutbox.id });
    if (rows.length === 0) throw new Error('Notification delivery lease was reclaimed.');
  }
}
