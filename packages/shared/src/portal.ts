import { z } from 'zod';

/**
 * Area AL — the customer portal (15 REQ-AL-01…AL-11).
 *
 * Everything it shows already exists; the work is access. One link per
 * party (REQ-AL-01), read-only (REQ-AL-02), reached by a random key with an
 * expiry that any Admin or Accounts holder can withdraw on the spot
 * (REQ-AL-03/AL-07). There is no portal login and no portal account: the
 * key is the credential, and it names exactly one party.
 */

/** D-53: ninety days, per party, rotating. Long enough to outlive an order, short enough that a forwarded link dies. */
export const PORTAL_KEY_DAYS = 90;

export const issuePortalKeySchema = z.object({
  partyId: z.uuid(),
  /** Days from today; the default is D-53's ninety. */
  days: z.number().int().min(1).max(365).optional(),
  note: z.string().trim().max(200).nullish(),
});
export type IssuePortalKeyInput = z.infer<typeof issuePortalKeySchema>;

export const revokePortalKeySchema = z.object({ reason: z.string().trim().min(3).max(500) });
export type RevokePortalKeyInput = z.infer<typeof revokePortalKeySchema>;

/**
 * What staff see about a key. The key itself is **never** here: it is
 * returned once, by the call that issues it, and stored only as a hash.
 * A list that could show the key would make every leak of the list a leak
 * of every customer's portal.
 */
export interface PortalKeyView {
  readonly id: string;
  readonly partyId: string;
  readonly partyName: string;
  readonly issuedAt: string;
  readonly issuedByName: string | null;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly revokedByName: string | null;
  readonly revokeReason: string | null;
  readonly lastUsedAt: string | null;
  readonly viewCount: number;
  readonly note: string | null;
  /** Derived, so a screen never has to compare dates to decide what to say. */
  readonly state: PortalKeyState;
}

export const PORTAL_KEY_STATES = ['active', 'expired', 'revoked'] as const;
export type PortalKeyState = (typeof PORTAL_KEY_STATES)[number];
export const PORTAL_KEY_STATE_LABELS: Record<PortalKeyState, string> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Withdrawn',
};

/** The one moment the key exists in the clear: the reply to the call that made it. */
export interface IssuedPortalKey extends PortalKeyView {
  readonly key: string;
  /** Ready to paste into a message; the server knows its own public address. */
  readonly url: string;
}

// ------------------------------------------------------------------ the portal itself

export interface PortalOrderView {
  readonly number: string;
  readonly date: string;
  readonly status: string;
  readonly grandTotal: string;
  /** REQ-AL-01: "orders with balances" — what is still to go out, in lines and quantity. */
  readonly linesOpen: number;
  readonly quantityOrdered: string;
  readonly quantityDispatched: string;
  readonly fulfilment: string;
}

export interface PortalDispatchView {
  readonly number: string;
  readonly orderNumber: string;
  readonly dispatchedAt: string;
  readonly mode: string;
  readonly lrNumber: string | null;
  readonly transporterName: string | null;
  readonly vehicleNumber: string | null;
  readonly expectedDeliveryDate: string | null;
  readonly deliveredAt: string | null;
  readonly receivedBy: string | null;
  readonly lines: readonly { readonly description: string; readonly quantity: string; readonly unit: string | null }[];
  /** REQ-AL-08: ids only. The bytes come from a short-lived signed link, minted per request. */
  readonly photos: readonly { readonly fileId: string; readonly kind: string }[];
}

export interface PortalInvoiceView {
  readonly voucherNumber: string;
  readonly date: string;
  readonly amount: string;
  readonly reference: string | null;
}

export interface PortalStatementRow {
  readonly date: string;
  readonly voucherType: string;
  readonly voucherNumber: string;
  readonly narration: string | null;
  readonly debit: string | null;
  readonly credit: string | null;
  readonly running: string;
}

export interface PortalPromiseView {
  readonly promisedDate: string;
  readonly amount: string;
  readonly receivedAmount: string;
  readonly state: string;
}

/** The whole portal in one reply: a phone on a slow connection should fetch once. */
export interface PortalView {
  readonly partyName: string;
  readonly organisationName: string;
  readonly expiresAt: string;
  readonly asOf: string;
  readonly orders: readonly PortalOrderView[];
  readonly dispatches: readonly PortalDispatchView[];
  readonly invoices: readonly PortalInvoiceView[];
  readonly statement: readonly PortalStatementRow[];
  readonly outstanding: string;
  readonly promises: readonly PortalPromiseView[];
}
