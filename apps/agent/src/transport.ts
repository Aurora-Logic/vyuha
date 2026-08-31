import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  SYNC_CHUNK_MAX_ROWS,
  billAllocationPullRowSchema,
  partyPullRowSchema,
  priceListPullRowSchema,
  stockItemPullRowSchema,
  type AgentCondition,
  type BillAllocationPullRow,
  type PartyPullRow,
  type PriceListPullRow,
  type StockItemPullRow,
  type SyncEntityType,
  type VoucherPushPayload,
} from '@vyuha/shared';
import { z } from 'zod';

/**
 * The seam between the loop and TallyPrime (09 §3).
 *
 * The loop upstream of this interface is fully buildable and tested today;
 * the HTTP-XML implementation behind it is **fixture-gated**: the Definition
 * of Done forbids hand-written Tally XML, so `TallyHttpTransport` lands when
 * real exports from the company data exist (10 §8, D-05). Nothing about the
 * loop changes on that day — that is what the seam is for.
 */

export interface TallyProbe {
  readonly condition: AgentCondition;
  /** Present when a company is open and readable. */
  readonly openCompanyGuid?: string;
  readonly tallyVersion?: string;
}

export type PullRow = PartyPullRow | StockItemPullRow | PriceListPullRow | BillAllocationPullRow;

export interface PullChunk {
  readonly rows: PullRow[];
  /** REQ-Q-06: hashes over the raw exchange, computed where the XML is. */
  readonly requestHash: string;
  readonly responseHash: string;
  readonly requestBody?: string;
  readonly responseBody?: string;
}

/** One push, as Tally answered it (09 §3.3). Hashes over the raw exchange, like a pull chunk. */
export interface PushResult {
  readonly outcome: 'accepted' | 'rejected';
  readonly remoteGuid: string | null;
  readonly remoteVoucherNumber: string | null;
  /** Tally's LINEERROR text verbatim (REQ-T-01), on rejection. */
  readonly errorText: string | null;
  readonly requestHash: string;
  readonly responseHash: string;
  readonly requestBody?: string;
  readonly responseBody?: string;
}

export interface TallyTransport {
  /** What the heartbeat reports: is Tally up, which company is open. */
  probe(): Promise<TallyProbe>;
  /** Everything above the cursor, already chunked to the contract's cap. */
  pull(entityType: SyncEntityType, fromAlterId: number): Promise<PullChunk[]>;
  /** One voucher, one request (09 §3.3). */
  push(payload: VoucherPushPayload): Promise<PushResult>;
  /**
   * The idempotency check before a retry: is a voucher carrying this key
   * already in Tally? Present means the previous attempt landed and the
   * agent reports `landed_on_retry`; absent means push again.
   */
  findByIdempotencyKey(key: string): Promise<{ remoteGuid: string; remoteVoucherNumber: string | null } | null>;
}

const fixtureFileSchema = z.object({
  companyGuid: z.string().min(1),
  tallyVersion: z.string().min(1).default('TallyPrime (fixture)'),
  parties: z.array(partyPullRowSchema).default([]),
  stockItems: z.array(stockItemPullRowSchema).default([]),
  priceLists: z.array(priceListPullRowSchema).default([]),
  billAllocations: z.array(billAllocationPullRowSchema).default([]),
});

export type FixtureFile = z.infer<typeof fixtureFileSchema>;

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function chunked<T>(rows: T[]): T[][] {
  if (rows.length === 0) return [[]];
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += SYNC_CHUNK_MAX_ROWS) {
    chunks.push(rows.slice(i, i + SYNC_CHUNK_MAX_ROWS));
  }
  return chunks;
}

/**
 * A transport that reads canned rows from a JSON file instead of Tally.
 *
 * Development and tests only — it exists so the loop, the protocol and the
 * server can be exercised end to end before real Tally XML fixtures arrive.
 * The hashes are real hashes over the serialised rows, so the journal's
 * evidence chain works the same way it will in production.
 */
export class FixtureTransport implements TallyTransport {
  private readonly fixture: FixtureFile;
  /** What the fixture "Tally" has imported, by idempotency key — enough to rehearse the retry rule. */
  private readonly imported = new Map<string, { remoteGuid: string; remoteVoucherNumber: string | null }>();

  constructor(fixturePath: string) {
    const parsed: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'));
    this.fixture = fixtureFileSchema.parse(parsed);
  }

  /**
   * Accepts any voucher whose party the fixture knows and refuses the rest
   * with the sentence Tally uses, so the rejection path is rehearsed with
   * words of the right shape.
   */
  push(payload: VoucherPushPayload): Promise<PushResult> {
    const request = `fixture:push:${payload.idempotencyKey}`;
    const known = this.fixture.parties.some((party) => party.name === payload.partyName);
    if (!known) {
      const errorText = `Ledger '${payload.partyName}' does not exist!`;
      return Promise.resolve({
        outcome: 'rejected',
        remoteGuid: null,
        remoteVoucherNumber: null,
        errorText,
        requestHash: sha256(request),
        responseHash: sha256(errorText),
        requestBody: request,
        responseBody: `<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>${errorText}</LINEERROR></RESPONSE>`,
      });
    }
    const existing = this.imported.get(payload.idempotencyKey);
    const remoteGuid = payload.remoteGuid ?? existing?.remoteGuid ?? `${this.fixture.companyGuid}-${String(this.imported.size + 1).padStart(8, '0')}`;
    const record = { remoteGuid, remoteVoucherNumber: existing?.remoteVoucherNumber ?? String(this.imported.size + 1) };
    this.imported.set(payload.idempotencyKey, record);
    const response = `<RESPONSE><CREATED>${existing === undefined ? '1' : '0'}</CREATED><ALTERED>${existing === undefined ? '0' : '1'}</ALTERED><ERRORS>0</ERRORS></RESPONSE>`;
    return Promise.resolve({
      outcome: 'accepted',
      remoteGuid: record.remoteGuid,
      remoteVoucherNumber: record.remoteVoucherNumber,
      errorText: null,
      requestHash: sha256(request),
      responseHash: sha256(response),
      requestBody: request,
      responseBody: response,
    });
  }

  findByIdempotencyKey(key: string): Promise<{ remoteGuid: string; remoteVoucherNumber: string | null } | null> {
    return Promise.resolve(this.imported.get(key) ?? null);
  }

  probe(): Promise<TallyProbe> {
    return Promise.resolve({
      condition: 'OK',
      openCompanyGuid: this.fixture.companyGuid,
      tallyVersion: this.fixture.tallyVersion,
    });
  }

  pull(entityType: SyncEntityType, fromAlterId: number): Promise<PullChunk[]> {
    const all: PullRow[] =
      entityType === 'party'
        ? this.fixture.parties
        : entityType === 'stock_item'
          ? this.fixture.stockItems
          : entityType === 'price_list'
            ? this.fixture.priceLists
            : this.fixture.billAllocations;
    const above = all.filter((row) => row.alterId > fromAlterId);

    const chunks = chunked(above).map((rows) => {
      const request = `fixture:${entityType}:above:${String(fromAlterId)}`;
      const response = JSON.stringify(rows);
      return {
        rows,
        requestHash: sha256(request),
        responseHash: sha256(response),
        requestBody: request,
        responseBody: response,
      };
    });
    return Promise.resolve(chunks);
  }
}
