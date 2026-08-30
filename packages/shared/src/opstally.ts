import { z } from 'zod';

/**
 * The OpsTally webhook contract, v1 (the "OpsTally Webhooks" reference).
 *
 * OpsTally Agent runs beside TallyPrime and pushes signed JSON events —
 * stock, ledgers (parties among them), vouchers — to an HTTPS endpoint
 * Vyuha exposes. This file
 * is that contract as Vyuha reads it, field for field from the reference, so
 * that a delivery either validates against exactly what the document
 * promises or is refused for a named reason. Nothing here is Vyuha's own
 * shape: the mapping onto Vyuha's projections lives in the API.
 *
 * Numbers arrive as JSON numbers, not decimal strings — that is OpsTally's
 * choice, recorded here as `z.number()`. They are held, never computed on
 * (D-01); the API stores them into `numeric` columns as they arrived.
 */

/** Header names, exactly as OpsTally sends them. */
export const OPSTALLY_HEADERS = {
  SIGNATURE: 'x-tally-signature',
  EVENT: 'x-tally-event',
  EVENT_ID: 'x-tally-event-id',
} as const;

/** The webhook signing secret's prefix; the reference guarantees it. */
export const OPSTALLY_SECRET_PREFIX = 'whsec_';

export const OPSTALLY_EVENTS = [
  'ping',
  'stock.updated',
  'stock.snapshot',
  'ledger.created',
  'ledger.updated',
  'ledger.snapshot',
  'voucher.created',
  'voucher.updated',
  'voucher.cancelled',
  'voucher.snapshot',
] as const;

export type OpsTallyEventType = (typeof OPSTALLY_EVENTS)[number];

/** Tally's own formatted numbers can be large; the guard is against NaN/Infinity, not size. */
const money = z.number().finite();

/** "Tally's internal numeric id" — documented as string, tolerated as number. */
const masterId = z.union([z.string(), z.number()]).transform((value) => String(value));

export const opsTallyStockItemSchema = z.object({
  guid: z.string().min(1).max(120),
  masterId,
  alterId: z.number().int().min(0),
  name: z.string().min(1).max(200),
  /** Stock group this item belongs to. */
  parent: z.string().max(120).default(''),
  /** Unit of measure — NOS, PCS, KG. */
  baseUnits: z.string().max(40).default(''),
  closingQty: money.default(0),
  closingRate: money.default(0),
  closingValue: money.default(0),
  /** 0 means "no source could resolve it", never "free" (reference §12). */
  salePrice: money.default(0),
  costPrice: money.default(0),
});

export type OpsTallyStockItem = z.infer<typeof opsTallyStockItemSchema>;

/**
 * Every party-detail field below is optional. OpsTally added them in a later
 * Agent build, and an Agent that predates it simply omits them — an install
 * that has not updated must keep delivering, not start failing validation at
 * the door. Absent therefore means "not reported", and the writer holds what
 * it already has rather than clearing it.
 */
export const opsTallyLedgerSchema = z.object({
  guid: z.string().min(1).max(120),
  masterId,
  alterId: z.number().int().min(0),
  name: z.string().min(1).max(200),
  /** Ledger group — Sundry Debtors, Sundry Creditors, Bank Accounts, … */
  parent: z.string().max(120).default(''),
  /** "GSTIN on file for this ledger, when set." */
  gstin: z.string().max(20).nullable().optional(),
  /** Regular / Composition / Unregistered / Consumer. */
  gstRegistrationType: z.string().max(40).nullable().optional(),
  /** 12 REQ-AA-28: the ledger's email and mobile, when OpsTally sends them. */
  email: z.string().max(254).nullable().optional(),
  mobile: z.string().max(40).nullable().optional(),
  /** The landline, distinct from the mobile above. */
  phone: z.string().max(40).nullable().optional(),
  /** Named contact on the ledger. */
  contactPerson: z.string().max(200).nullable().optional(),
  /** Mailing address, one entry per line, in Tally's own order. */
  address: z.array(z.string().max(500)).max(20).nullable().optional(),
  state: z.string().max(120).nullable().optional(),
  country: z.string().max(120).nullable().optional(),
  /** String, not a number — leading zeros are part of a postal code. */
  pincode: z.string().max(20).nullable().optional(),
  /** Tally's sign convention: debit positive, credit negative. */
  openingBalance: money.nullable().optional(),
  /**
   * The party's outstanding, as of the delivery. Tally computes it from the
   * vouchers and does not move the ledger's alterId when it changes, so this
   * arrives on ordinary `ledger.updated` traffic rather than only on master
   * edits. Zero is a real balance here — a settled account — not "unknown",
   * which is why absence and zero mean different things (see above).
   */
  closingBalance: money.nullable().optional(),
  /** 0 means unset, not "no credit". */
  creditLimit: money.nullable().optional(),
  creditPeriodDays: z.number().int().min(0).max(3650).nullable().optional(),
  isBillWiseOn: z.boolean().nullable().optional(),
});

export type OpsTallyLedger = z.infer<typeof opsTallyLedgerSchema>;

/**
 * How a bank line was settled. OpsTally reports this against the BANK LEDGER'S
 * LINE, not against the voucher, because that is where Tally records it — a
 * voucher's "payment type" is a property of one of its entries. Absent on every
 * non-bank line, and on any Agent older than the field.
 */
export const opsTallyBankAllocationSchema = z.object({
  /** The payment type — "Cheque/DD", "Inter Bank Transfer", "e-Fund Transfer", … */
  transactionType: z.string().max(80).nullable().optional(),
  /** Tally's settlement state, e.g. "Transacted". */
  paymentMode: z.string().max(80).nullable().optional(),
  instrumentNumber: z.string().max(120).nullable().optional(),
  /** Tally's native YYYYMMDD, empty when unset. */
  instrumentDate: z.string().max(20).nullable().optional(),
  bankName: z.string().max(200).nullable().optional(),
  paymentFavouring: z.string().max(200).nullable().optional(),
});

export type OpsTallyBankAllocation = z.infer<typeof opsTallyBankAllocationSchema>;

export const opsTallyLedgerEntrySchema = z.object({
  ledgerName: z.string().max(200),
  amount: money,
  /** Tally's debit/credit convention — true on the debit side. */
  isDeemedPositive: z.boolean(),
  /** Set only on a bank line carrying settlement detail. */
  bankAllocation: opsTallyBankAllocationSchema.nullable().optional(),
});

export const opsTallyInventoryEntrySchema = z.object({
  stockItemName: z.string().max(200),
  /** Tally's own formatted string, may carry a unit suffix. */
  actualQty: z.union([z.string(), z.number()]).transform((value) => String(value)),
  billedQty: z.union([z.string(), z.number()]).transform((value) => String(value)),
  rate: money,
  amount: money,
});

export const opsTallyVoucherSchema = z.object({
  guid: z.string().min(1).max(120),
  masterId,
  alterId: z.number().int().min(0),
  /** Tally's native YYYYMMDD. */
  date: z.string().regex(/^\d{8}$/u),
  /** Configurable per company — free text. */
  voucherType: z.string().max(120),
  voucherNumber: z.string().max(120).default(''),
  party: z.string().max(200).default(''),
  narration: z.string().max(4000).default(''),
  isCancelled: z.boolean(),
  amount: money,
  ledgerEntries: z.array(opsTallyLedgerEntrySchema).default([]),
  inventoryEntries: z.array(opsTallyInventoryEntrySchema).default([]),

  /*
   * Order, terms, dispatch and consignee detail. Every field is optional: an
   * Agent older than these sends none of them, and which of them carry data on
   * a delivery that does is entirely a question of how that company does data
   * entry. Two live companies were measured while this was built — one fills
   * reference/orderRef/terms on nearly every invoice and has never once filled
   * dispatchedThrough; the other is the exact inverse. Never make one of these
   * required on the strength of one company's habits.
   */
  reference: z.string().max(200).nullable().optional(),
  /** Tally's native YYYYMMDD. */
  referenceDate: z.string().max(20).nullable().optional(),
  orderRef: z.string().max(200).nullable().optional(),
  buyerOrderNumber: z.string().max(200).nullable().optional(),
  buyerOrderDate: z.string().max(20).nullable().optional(),
  paymentTerms: z.string().max(500).nullable().optional(),
  deliveryTerms: z.array(z.string().max(500)).max(40).nullable().optional(),
  dispatchedThrough: z.string().max(200).nullable().optional(),
  dispatchDocNo: z.string().max(200).nullable().optional(),
  vehicleNumber: z.string().max(80).nullable().optional(),
  destination: z.string().max(200).nullable().optional(),
  buyerName: z.string().max(200).nullable().optional(),
  buyerAddress: z.array(z.string().max(500)).max(20).nullable().optional(),
  partyMailingName: z.string().max(200).nullable().optional(),
  partyGstin: z.string().max(20).nullable().optional(),
  partyState: z.string().max(120).nullable().optional(),
  partyCountry: z.string().max(120).nullable().optional(),
  placeOfSupply: z.string().max(120).nullable().optional(),
  consigneeName: z.string().max(200).nullable().optional(),
  consigneeState: z.string().max(120).nullable().optional(),
  /** String, not a number — a postal code's leading zero is part of it. */
  consigneePincode: z.string().max(20).nullable().optional(),
  consigneeGstin: z.string().max(20).nullable().optional(),
});

export type OpsTallyVoucher = z.infer<typeof opsTallyVoucherSchema>;

/**
 * Every delivery: the same five envelope fields; only `payload` varies. A
 * discriminated union on `event`, so a `stock.updated` carrying a ledger
 * body fails at the door with the field named, instead of reaching a writer.
 */
const envelope = {
  /** Unique event id, prefixed evt_ — the idempotency key. */
  id: z.string().min(1).max(120),
  created_at: z.string().min(1),
  /** Exact Tally company name this data came from. */
  company: z.string().min(1).max(200),
  /** Stable per Agent installation, minted once on first run. */
  install_id: z.string().min(1).max(120),
} as const;

export const opsTallyEventSchema = z.discriminatedUnion('event', [
  z.object({ ...envelope, event: z.literal('ping'), payload: z.object({ message: z.string().default('') }) }),
  z.object({ ...envelope, event: z.literal('stock.updated'), payload: opsTallyStockItemSchema }),
  z.object({
    ...envelope,
    event: z.literal('stock.snapshot'),
    payload: z.object({
      items: z.array(opsTallyStockItemSchema).max(500),
      chunk: z.number().int().min(1),
      total_chunks: z.number().int().min(1),
    }),
  }),
  z.object({ ...envelope, event: z.literal('ledger.created'), payload: opsTallyLedgerSchema }),
  z.object({ ...envelope, event: z.literal('ledger.updated'), payload: opsTallyLedgerSchema }),
  z.object({
    ...envelope,
    event: z.literal('ledger.snapshot'),
    payload: z.object({
      ledgers: z.array(opsTallyLedgerSchema).max(500),
      chunk: z.number().int().min(1),
      total_chunks: z.number().int().min(1),
    }),
  }),
  z.object({ ...envelope, event: z.literal('voucher.created'), payload: opsTallyVoucherSchema }),
  z.object({ ...envelope, event: z.literal('voucher.updated'), payload: opsTallyVoucherSchema }),
  z.object({ ...envelope, event: z.literal('voucher.cancelled'), payload: opsTallyVoucherSchema }),
  z.object({
    ...envelope,
    event: z.literal('voucher.snapshot'),
    payload: z.object({
      vouchers: z.array(opsTallyVoucherSchema).max(500),
      chunk: z.number().int().min(1),
      total_chunks: z.number().int().min(1),
    }),
  }),
]);

export type OpsTallyEvent = z.infer<typeof opsTallyEventSchema>;

/** What Vyuha answers. Only the status matters to the Agent; the body is for people. */
export interface OpsTallyAck {
  readonly ok: true;
  readonly eventId: string;
  /** True when this id had already been accepted — the retry was a no-op. */
  readonly duplicate: boolean;
  /** What Vyuha did with it, in one line, for the journal and for a person reading the reply. */
  readonly result: string;
}

/** The admin's half: paste the whsec_ secret OpsTally generated. */
export const setWebhookSecretSchema = z.object({
  secret: z.string().trim().startsWith(OPSTALLY_SECRET_PREFIX).min(16).max(256),
});

export type SetWebhookSecretInput = z.infer<typeof setWebhookSecretSchema>;
