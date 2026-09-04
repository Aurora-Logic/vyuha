import { z } from 'zod';

/**
 * The connector agent's wire contract (REQ-Q-01 … Q-05, 09 §5).
 *
 * The agent authenticates with a per-connection credential, never a user
 * token, and holds nothing beyond its own connection. These shapes are shared
 * so the agent binary (Phase 6b, its own build) compiles against the same
 * contract the API enforces.
 */

/**
 * REQ-Q-05: the agent reports the *specific* condition, because "Tally is not
 * running" and "Tally is running with the wrong company open" are different
 * problems with different fixes. The server stores the effective condition on
 * the connection, so an administrator looking at an ERROR knows which problem
 * it is — and it derives `WRONG_COMPANY_OPEN` itself from the reported
 * company GUID, so a confused agent cannot call the wrong books "OK".
 */
export const AGENT_CONDITIONS = [
  'OK',
  'TALLY_NOT_RUNNING',
  'WRONG_COMPANY_OPEN',
  'LICENCE_LAPSED',
] as const;

export type AgentCondition = (typeof AGENT_CONDITIONS)[number];

/**
 * One agent per company, enforced by a lease (09 §3.4). A dead agent must not
 * hold its lease forever, so a rival instance may take over once the current
 * holder's heartbeat is older than this.
 *
 * Five minutes is REQ-Q-04's number, and it is deliberately the single answer
 * to "when do we stop believing the agent is alive": the Integrations
 * screen's STALE label derives from this same constant, so a lease cannot
 * change hands while the screen still calls the connection healthy.
 */
export const AGENT_LEASE_TAKEOVER_MINUTES = 5;

/** Random per install; the lease is held by an instance, not a version. One
 * schema for both routes — the lease compares these values across them, so
 * two hand-copied bounds drifting apart would split one identity in two. */
const agentInstanceIdSchema = z.string().min(8).max(64);

export const agentHeartbeatSchema = z.object({
  agentInstanceId: agentInstanceIdSchema,
  agentVersion: z.string().min(1).max(40),
  tallyVersion: z.string().max(40).optional(),
  /**
   * The GUID of the company Tally actually has open, when Tally is
   * reachable. `min(1)` so "no company open" must be spelled by omission —
   * an empty string would read as a company that differs from every GUID,
   * turning "nothing is open" into "the wrong thing is open", which are
   * different problems with different fixes (REQ-Q-05).
   */
  openCompanyGuid: z.string().min(1).max(80).optional(),
  condition: z.enum(AGENT_CONDITIONS).default('OK'),
});

export type AgentHeartbeatInput = z.infer<typeof agentHeartbeatSchema>;

/**
 * No `leaseHeld` flag: a heartbeat that did not win the lease is a 409, so an
 * ack's existence already carries that bit and a field could only ever be
 * true.
 */
export interface AgentHeartbeatAck {
  readonly connectionId: string;
  /** What the server expects open; null until an administrator binds one. */
  readonly companyGuid: string | null;
  /** The condition the server recorded — the agent's report, or the mismatch it derived. */
  readonly condition: AgentCondition;
  /** Echoed so agent and server cannot quietly disagree about the takeover rule. */
  readonly leaseTakeoverMinutes: number;
}

export const agentClaimSchema = z.object({
  agentInstanceId: agentInstanceIdSchema,
  openCompanyGuid: z.string().min(1).max(80).optional(),
});

export type AgentClaimInput = z.infer<typeof agentClaimSchema>;

export interface ClaimedSyncJob {
  readonly id: string;
  readonly direction: 'PULL' | 'PUSH';
  readonly entityType: string;
  readonly payload: unknown;
  readonly attempts: number;
  /**
   * The server's cursor for this entity type: pull everything above it.
   * Zero after a full re-pull (REQ-R-05 deletes the cursor) and on a first
   * pull. Carried on the claim because the server owns the watermark — an
   * agent that tracked its own could disagree with the one the writer
   * actually committed, and the committed one is the only one that is true.
   */
  readonly fromAlterId: number;
}

export interface AgentClaimResponse {
  /** Null when the queue is empty — the normal answer, not an error. */
  readonly job: ClaimedSyncJob | null;
}

// ------------------------------------------------------------ pull results

/**
 * What a pull job can be about. Free text on the wire and in the tables —
 * the column is text so a later phase attaches without a migration — but a
 * job the API enqueues names one of these, and the results endpoint only
 * ingests kinds it has a writer for.
 */
export const SYNC_ENTITY_TYPES = ['party', 'stock_item', 'price_list', 'bill_allocation'] as const;

export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

/**
 * An exact decimal as text. Credit limits and opening balances are Tally's
 * figures held as a projection (D-01); a float would silently reshape them,
 * and a figure that no longer matches Tally to the paisa is the trust
 * failure REQ-S-05 reconciles against. Stored in `numeric` columns, never
 * computed on.
 */
const decimalString = z.string().regex(/^-?\d{1,15}(\.\d{1,6})?$/u, 'an exact decimal number');

/**
 * One party, as the agent read it out of Tally (REQ-R-01). The agent owns
 * the XML: it parses TallyPrime's export — malformed by strict standards,
 * which is why parsing happens where `fast-xml-parser` is — and posts rows
 * in this shape. The API never sees Tally XML on the pull path.
 */
export const partyPullRowSchema = z.object({
  guid: z.string().min(1).max(80),
  alterId: z.number().int().min(0),
  name: z.string().min(1).max(200),
  alias: z.string().min(1).max(200).optional(),
  /** Sundry Debtors / Sundry Creditors, verbatim from the parent group. */
  parentGroup: z.string().min(1).max(120),
  gstin: z.string().min(1).max(20).optional(),
  /** Regular / Composition / Unregistered / Consumer, verbatim. */
  gstRegistrationType: z.string().min(1).max(40).optional(),
  /** The mailing address as one block; a multi-line source joins on newlines. */
  address: z.string().min(1).max(1000).optional(),
  state: z.string().min(1).max(120).optional(),
  country: z.string().min(1).max(120).optional(),
  /** Text, not a number: a postal code's leading zero is part of it. */
  pincode: z.string().min(1).max(20).optional(),
  /** 12 REQ-AA-28: the ledger's email and mobile, where the company keeps them. */
  email: z.string().min(3).max(254).optional(),
  phone: z.string().min(6).max(40).optional(),
  contactPerson: z.string().min(1).max(200).optional(),
  creditLimit: decimalString.optional(),
  creditDays: z.number().int().min(0).max(3650).optional(),
  openingBalance: decimalString.optional(),
  /**
   * The outstanding as the source last saw it. Held, never computed on
   * (D-01), and never the basis of a payable or receivable Vyuha asserts on
   * its own: Tally is the ledger of record and this is a projection of it.
   * Unlike a price, zero is meaningful — a settled account — so the writer
   * lands a zero rather than keeping a stored non-zero over it.
   */
  closingBalance: decimalString.optional(),
  billWiseTracking: z.boolean().optional(),
});

export type PartyPullRow = z.infer<typeof partyPullRowSchema>;

/**
 * One stock item (REQ-R-02): name, alias, unit, group, and GST rate — the
 * PRD's list exactly, no more. The GST rate is a percentage held as an exact
 * decimal, because 2.5 must stay 2.5.
 */
export const stockItemPullRowSchema = z.object({
  guid: z.string().min(1).max(80),
  alterId: z.number().int().min(0),
  name: z.string().min(1).max(200),
  alias: z.string().min(1).max(200).optional(),
  /** The base unit, verbatim — "Nos", "Kg", whatever Tally says. */
  unit: z.string().min(1).max(40),
  /** The stock group, verbatim from the parent. */
  parentGroup: z.string().min(1).max(120),
  gstRate: decimalString.optional(),
  /**
   * Held figures a source may carry (OpsTally does; Tally XML pulls need
   * not). Exact decimals as text, stored, never computed on (D-01). A sale
   * or cost price of "0" means the source could not resolve one, and the
   * writer keeps a stored non-zero figure over it — zero is not "free".
   */
  closingQty: decimalString.optional(),
  salePrice: decimalString.optional(),
  costPrice: decimalString.optional(),
});

export type StockItemPullRow = z.infer<typeof stockItemPullRowSchema>;

/**
 * One price-list rate (REQ-R-03). Tally gives a price *level* (the per-party-
 * group list this requirement exists for) and rates per stock item under it;
 * the entry has no GUID of its own, so its identity is the pair — the writer
 * upserts on (item, level) rather than through `external_refs`. `alterId`
 * rides on the owning stock item's alteration, which is what moves when a
 * rate is edited.
 */
export const priceListPullRowSchema = z.object({
  alterId: z.number().int().min(0),
  stockItemGuid: z.string().min(1).max(80),
  priceLevel: z.string().min(1).max(120),
  rate: decimalString,
  /** The unit the rate is quoted per, when Tally states one. */
  unit: z.string().min(1).max(40).optional(),
});

export type PriceListPullRow = z.infer<typeof priceListPullRowSchema>;

/**
 * One voucher as a source read it out of Tally (09 §4.3, Phase 6c). Vyuha's
 * own shape — OpsTally's payload maps onto it in the API, and the pull agent
 * will produce it directly. Lines carry no identity: they are the voucher's
 * and are replaced wholesale on every upsert.
 */
export const voucherLinePullSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ledger'),
    ledgerName: z.string().max(200),
    amount: decimalString,
    /** Tally's debit/credit convention — true on the debit side. */
    isDeemedPositive: z.boolean(),
    /*
     * Bank settlement, on the line rather than the voucher, because that is
     * where Tally records it. Kept on the line deliberately: flattening it onto
     * the header would be easier to query but would assert something Tally does
     * not — that a voucher has one settlement. A contra with two bank lines has
     * two, and the projection mirrors the books rather than reshaping them.
     */
    settlementType: z.string().min(1).max(80).optional(),
    settlementMode: z.string().min(1).max(80).optional(),
    instrumentNumber: z.string().min(1).max(120).optional(),
    /** ISO date (YYYY-MM-DD); sources convert from Tally's YYYYMMDD. */
    instrumentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
    bankName: z.string().min(1).max(200).optional(),
    paymentFavouring: z.string().min(1).max(200).optional(),
  }),
  z.object({
    kind: z.literal('inventory'),
    stockItemName: z.string().max(200),
    /** Tally's formatted quantity strings, unit suffix and all. */
    actualQty: z.string().max(80),
    billedQty: z.string().max(80),
    rate: decimalString.optional(),
    amount: decimalString,
  }),
]);

export type VoucherLinePull = z.infer<typeof voucherLinePullSchema>;

export const voucherPullRowSchema = z.object({
  guid: z.string().min(1).max(120),
  masterId: z.string().max(80).optional(),
  alterId: z.number().int().min(0),
  /** ISO date (YYYY-MM-DD). Sources convert from Tally's YYYYMMDD. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  voucherType: z.string().min(1).max(120),
  voucherNumber: z.string().max(120).optional(),
  partyName: z.string().max(200).optional(),
  narration: z.string().max(4000).optional(),
  isCancelled: z.boolean(),
  amount: decimalString,
  lines: z.array(voucherLinePullSchema).max(2000),

  /*
   * Order, terms, dispatch and consignee detail, where the source carries it.
   * All optional — a source that omits one is saying "not reported", which is
   * why the writer COALESCEs rather than assigns. Which fields a company fills
   * varies wildly between companies; none of these may be treated as reliable.
   */
  reference: z.string().min(1).max(200).optional(),
  /** ISO date (YYYY-MM-DD). */
  referenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  orderRef: z.string().min(1).max(200).optional(),
  buyerOrderNumber: z.string().min(1).max(200).optional(),
  buyerOrderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  paymentTerms: z.string().min(1).max(500).optional(),
  /** Terms of delivery as one block; a multi-line source joins on newlines. */
  deliveryTerms: z.string().min(1).max(2000).optional(),
  dispatchedThrough: z.string().min(1).max(200).optional(),
  dispatchDocNo: z.string().min(1).max(200).optional(),
  vehicleNumber: z.string().min(1).max(80).optional(),
  destination: z.string().min(1).max(200).optional(),
  buyerName: z.string().min(1).max(200).optional(),
  /** Buyer address as one block; a multi-line source joins on newlines. */
  buyerAddress: z.string().min(1).max(1000).optional(),
  partyGstin: z.string().min(1).max(20).optional(),
  partyState: z.string().min(1).max(120).optional(),
  placeOfSupply: z.string().min(1).max(120).optional(),
  consigneeName: z.string().min(1).max(200).optional(),
  consigneeState: z.string().min(1).max(120).optional(),
  consigneePincode: z.string().min(1).max(20).optional(),
  consigneeGstin: z.string().min(1).max(20).optional(),
});

export type VoucherPullRow = z.infer<typeof voucherPullRowSchema>;

/**
 * One bill allocation (REQ-AJ-02, owner decision 28 Aug 2026). Tally keeps
 * bill-wise detail inside a voucher's ledger entries; the agent flattens it
 * to rows so ageing and a promise-to-pay's kept state can be derived from
 * the projection. The row names its voucher by GUID — the writer resolves
 * it through the same mapping the voucher upsert anchored — and `alterId`
 * rides on that voucher's alteration, the way a price entry rides its item's.
 */
export const billAllocationPullRowSchema = z.object({
  alterId: z.number().int().min(0),
  /** The voucher the allocation was read from. */
  voucherGuid: z.string().min(1).max(120),
  /** The party ledger the bill belongs to, verbatim — Tally's own reference. */
  partyName: z.string().min(1).max(200),
  /** Tally's bill reference — the invoice number as the customer knows it. */
  billName: z.string().min(1).max(200),
  /**
   * How the row relates to the bill, Tally's own four: `new` raises it,
   * `against` settles some of it, `advance` is money before a bill exists,
   * `on_account` names no bill at all.
   */
  refType: z.enum(['new', 'against', 'advance', 'on_account']),
  /** ISO date (YYYY-MM-DD). Omitted on `on_account`, which has no bill to date. */
  billDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  /** Tally's credit period on the bill, when the company sets one. */
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  /** Signed against the party: positive raises, negative settles (D-01). */
  amount: decimalString,
});

export type BillAllocationPullRow = z.infer<typeof billAllocationPullRowSchema>;

/** Chunk bounds: small enough to commit fast, large enough not to chatter. */
export const SYNC_CHUNK_MAX_ROWS = 500;

/**
 * REQ-Q-06 fields shared by every results post: the journal keeps hashes of
 * what was actually exchanged with Tally, computed by the agent over the raw
 * XML. The hash is the evidence; the optional bodies are bulk the D-20
 * sweep clears after 30 days.
 */
const resultsCommon = {
  agentInstanceId: agentInstanceIdSchema,
  /** Required on results: rows must come from the books they claim to. */
  openCompanyGuid: z.string().min(1).max(80),
  jobId: z.uuid(),
  requestHash: z.string().min(1).max(128),
  responseHash: z.string().min(1).max(128),
  requestBody: z.string().max(512_000).optional(),
  responseBody: z.string().max(512_000).optional(),
  durationMs: z.number().int().min(0).optional(),
  /** True on the last chunk: the job completes and the cursor is final. */
  final: z.boolean(),
} as const;

/**
 * Discriminated on `entityType`, so a chunk of stock items claiming to be
 * parties fails validation at the door instead of reaching a writer that
 * would read `unit` where `parentGroup` should be.
 */
export const agentResultsSchema = z.discriminatedUnion('entityType', [
  z.object({
    ...resultsCommon,
    entityType: z.literal('party'),
    rows: z.array(partyPullRowSchema).max(SYNC_CHUNK_MAX_ROWS),
  }),
  z.object({
    ...resultsCommon,
    entityType: z.literal('stock_item'),
    rows: z.array(stockItemPullRowSchema).max(SYNC_CHUNK_MAX_ROWS),
  }),
  z.object({
    ...resultsCommon,
    entityType: z.literal('price_list'),
    rows: z.array(priceListPullRowSchema).max(SYNC_CHUNK_MAX_ROWS),
  }),
  z.object({
    ...resultsCommon,
    entityType: z.literal('bill_allocation'),
    rows: z.array(billAllocationPullRowSchema).max(SYNC_CHUNK_MAX_ROWS),
  }),
  /**
   * The outcome of one push (09 §3.3), reported by the agent and never
   * inferred (REQ-W-06). `accepted` carries what Tally answered with;
   * `rejected` carries LINEERROR verbatim (REQ-T-01); `landed_on_retry` is
   * the idempotency case — the previous attempt timed out, the agent found
   * the key in Tally, and no second voucher was created.
   */
  z.object({
    ...resultsCommon,
    entityType: z.literal('voucher_push'),
    outcome: z.enum(['accepted', 'landed_on_retry', 'rejected']),
    remoteGuid: z.string().min(1).max(80).optional(),
    remoteVoucherNumber: z.string().max(80).optional(),
    errorText: z.string().trim().min(1).max(8_000).optional(),
    rows: z.array(z.never()).max(0).default([]),
  }),
]);

export type AgentResultsInput = z.infer<typeof agentResultsSchema>;

export interface AgentResultsAck {
  readonly jobId: string;
  readonly written: number;
  /**
   * Rows the writer counted out rather than wrote — an allocation whose
   * voucher has not arrived yet. Present only when something was skipped.
   */
  readonly skipped?: number | undefined;
  /** The cursor after this chunk committed — what the next pull filters above. */
  readonly lastAlterId: number;
  readonly jobState: 'CLAIMED' | 'DONE';
}

// ------------------------------------------------------------- exceptions

/**
 * Who raised the exception, which decides what "resolve" can mean (REQ-T-01).
 * An open set the way `entity_type` is: conflict (REQ-T-02) and drift
 * (REQ-T-08) producers arrive in later slices and add their kinds here.
 */
export const SYNC_EXCEPTION_KINDS = ['AGENT_ERROR', 'CONFLICT', 'REJECTION', 'DRIFT'] as const;

export type SyncExceptionKind = (typeof SYNC_EXCEPTION_KINDS)[number];

export const SYNC_EXCEPTION_STATES = ['OPEN', 'RESOLVED'] as const;

export type SyncExceptionState = (typeof SYNC_EXCEPTION_STATES)[number];

/**
 * The agent's failure report (09 §5). Deliberately *not* required to name the
 * open company: the error being reported may be exactly that the wrong books
 * are open, and a report the server refuses for describing the problem is a
 * report that never arrives.
 */
export const agentErrorSchema = z.object({
  agentInstanceId: agentInstanceIdSchema,
  /** The job that failed, when there was one; an errored heartbeat has none. */
  jobId: z.uuid().optional(),
  entityType: z.enum(SYNC_ENTITY_TYPES).optional(),
  /** The agent's own classification — HTTP status, Tally LINEERROR, timeout. */
  errorCode: z.string().trim().min(1).max(80).optional(),
  /** Tally's verbatim words. A paraphrase cannot be acted on (REQ-T-01). */
  errorText: z.string().trim().min(1).max(8_000),
  /** Same evidence rules as results: hashes prove, bodies expire (REQ-Q-06). */
  requestHash: z.string().min(1).max(128).optional(),
  responseHash: z.string().min(1).max(128).optional(),
  requestBody: z.string().max(512_000).optional(),
  responseBody: z.string().max(512_000).optional(),
  durationMs: z.number().int().min(0).optional(),
});

export type AgentErrorInput = z.infer<typeof agentErrorSchema>;

export interface AgentErrorAck {
  readonly exceptionId: string;
  /** Whether the named job was moved to FAILED by this report. */
  readonly jobFailed: boolean;
}

export interface SyncExceptionView {
  readonly id: string;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly kind: SyncExceptionKind;
  readonly entityType: string | null;
  readonly tallyError: string;
  readonly state: SyncExceptionState;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly resolutionNote: string | null;
}

/**
 * A resolution must say what was done. "Resolved" with no note is how the
 * same exception returns in a month with nobody remembering the first round.
 */
export const resolveSyncExceptionSchema = z.object({
  note: z.string().trim().min(3).max(2_000),
});

export type ResolveSyncExceptionInput = z.infer<typeof resolveSyncExceptionSchema>;

// ---------------------------------------------------------- administration

export const createIntegrationConnectionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** Bound later if unknown at creation; jobs are refused until it is. */
  companyGuid: z.string().trim().min(1).max(80).optional(),
  companyName: z.string().trim().min(1).max(120).optional(),
});

export type CreateIntegrationConnectionInput = z.infer<typeof createIntegrationConnectionSchema>;

export interface IssuedAgentToken {
  readonly connectionId: string;
  /**
   * Shown exactly once. Only its hash is stored, so there is no endpoint that
   * can show it again — reissue rotates it and the old one stops working.
   */
  readonly token: string;
}

/**
 * What the agent accepts as an answer from the server. Typed against the
 * interfaces above, so a field added to one must be added to the other. The
 * agent used to cast the parsed body to the type and trust it, so a proxy
 * error page or a half-deployed server reached the loop as a claim (H-11).
 */
export const agentHeartbeatAckSchema: z.ZodType<AgentHeartbeatAck> = z.object({
  connectionId: z.string(),
  companyGuid: z.string().nullable(),
  condition: z.enum(AGENT_CONDITIONS),
  leaseTakeoverMinutes: z.number(),
});

export const claimedSyncJobSchema: z.ZodType<ClaimedSyncJob> = z.object({
  id: z.string(),
  direction: z.enum(['PULL', 'PUSH']),
  entityType: z.string(),
  payload: z.unknown(),
  attempts: z.number(),
  fromAlterId: z.number(),
});

export const agentClaimResponseSchema: z.ZodType<AgentClaimResponse> = z.object({
  job: claimedSyncJobSchema.nullable(),
});

export const agentResultsAckSchema: z.ZodType<AgentResultsAck> = z.object({
  jobId: z.string(),
  written: z.number(),
  skipped: z.number().optional(),
  lastAlterId: z.number(),
  jobState: z.enum(['CLAIMED', 'DONE']),
});

export const agentErrorAckSchema: z.ZodType<AgentErrorAck> = z.object({
  exceptionId: z.string(),
  jobFailed: z.boolean(),
});
