import {
  CheckCircleIcon,
  CircleDashedIcon,
  ClockCounterClockwiseIcon,
  CloudCheckIcon,
  CloudSlashIcon,
  HandGrabbingIcon,
  HourglassMediumIcon,
  type Icon,
  MinusCircleIcon,
  PackageIcon,
  PaperPlaneTiltIcon,
  PencilSimpleIcon,
  ProhibitIcon,
  ReceiptIcon,
  SealCheckIcon,
  TruckIcon,
  XCircleIcon,
} from '@phosphor-icons/react';

/**
 * One place that decides a status's colour, so a state reads the same on every
 * screen (CLAUDE.md §3 rule 4: one hierarchy across the whole app). The tone is
 * the meaning, not the palette — amber waits, blue is in flight, green is done,
 * red is refused, grey has ended, plain has not begun. It is keyed by the raw
 * state value, which is unique enough across the document lives (a shared DRAFT
 * or CONFIRMED means the same in each), so an estimate, a sales order, a
 * purchase order, the Tally sync and the fulfilment all speak one colour.
 *
 * Colour is never the only signal: the label is always the word beside it, so a
 * status stays legible to a colour-blind reader and in a greyscale print.
 *
 * Kept apart from the StatusBadge component so a fast-refresh boundary holds and
 * a plain <Badge> can borrow the tone when its text is composed.
 */

export type StatusTone = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'info';

const STATUS_TONE: Record<string, StatusTone> = {
  // Nothing has happened yet — a draft, a document not sent to Tally, an order
  // whose fulfilment has not begun.
  DRAFT: 'outline',
  draft: 'outline',
  NOT_PUSHED: 'outline',
  open: 'outline',

  // Waiting on someone or something to act.
  QUEUED: 'warning',
  PENDING_APPROVAL: 'warning',
  awaiting_invoice: 'warning',
  // 15 REQ-AK-05: the receipt is made and Tally's credit note has not come.
  awaiting_credit_note: 'warning',
  // 15 REQ-AJ: a promise taken and not yet due reads like any other wait.
  pending_approval: 'warning',

  // In flight — accepted into a process and moving.
  SENT: 'info',
  CONFIRMED: 'info',
  ordered: 'info',
  picking: 'info',
  ready_to_dispatch: 'info',
  partially_dispatched: 'info',
  partially_received: 'info',
  shipped: 'info',

  // Done, and well.
  PUSHED: 'success',
  // 15 REQ-AK-06: Tally's credit note arrived and linked.
  credited: 'success',
  // 15 REQ-AL-03: a customer link that works today.
  active: 'success',
  kept: 'success',
  // 15 REQ-AN-10: the version in force.
  approved: 'success',
  ACCEPTED: 'success',
  closed: 'success',
  received: 'success',
  delivered: 'success',

  // Refused or stopped.
  FAILED: 'destructive',
  REJECTED: 'destructive',
  CANCELLED: 'destructive',
  // 15 REQ-AK-03: the line is written off rather than put back on the shelf.
  scrap: 'destructive',
  broken: 'destructive',

  // Ended, but not the happy ending.
  EXPIRED: 'secondary',
  short_closed: 'secondary',
  // 15 Area AK/AL: a receipt written in error, a link withdrawn, a link that
  // simply ran out. All three are over; none of them is a failure.
  cancelled: 'secondary',
  revoked: 'secondary',
  expired: 'secondary',
  superseded: 'secondary',
  partially_kept: 'warning',

  // 15 REQ-AK-03: goods going back on the shelf is the ordinary outcome, so
  // it reads as plain rather than as good news.
  restock: 'outline',

  /*
   * 15 REQ-AO-10: a duplicate cluster's states are qualified, because `open`
   * is the one raw value this table cannot key on its own. An open promise is
   * a promise not yet due and reads calm; an open duplicate cluster is two
   * records for one company and reads as a problem. The screen passes
   * `duplicate_<state>` so both keep their meaning and neither screen picks
   * its own palette.
   */
  duplicate_open: 'destructive',
  duplicate_sent_to_tally: 'secondary',
  duplicate_dismissed: 'outline',
  duplicate_resolved: 'success',

  /*
   * The Pareto bands. Deliberately not red-amber-green: the tail of a Pareto
   * is not a failure, it is the shape every business has, and colouring it
   * destructive would make a normal distribution look like an alarm. The head
   * is emphasised, the middle is quieter, the tail is quietest.
   */
  'Top 50%': 'info',
  'Next 30%': 'outline',
  Tail: 'secondary',
};

/** The tone a raw status value wears; unmapped states read as neutral. */
export function statusTone(state: string): StatusTone {
  return STATUS_TONE[state] ?? 'outline';
}

/**
 * The glyph a state wears beside its word, so a status is known by shape as
 * well as colour — a pencil is a draft, an hourglass waits, a truck is on the
 * road, a seal is done, a cross is refused. Shape carries the meaning where
 * colour cannot: to a colour-blind reader, and in a greyscale print.
 */
export const STATUS_ICONS: Record<string, Icon> = {
  DRAFT: PencilSimpleIcon,
  NOT_PUSHED: CloudSlashIcon,
  open: CircleDashedIcon,

  QUEUED: HourglassMediumIcon,
  PENDING_APPROVAL: HourglassMediumIcon,
  awaiting_invoice: ReceiptIcon,

  SENT: PaperPlaneTiltIcon,
  CONFIRMED: CheckCircleIcon,
  ordered: CheckCircleIcon,
  picking: HandGrabbingIcon,
  ready_to_dispatch: PackageIcon,
  partially_dispatched: TruckIcon,
  partially_received: TruckIcon,
  shipped: TruckIcon,

  PUSHED: CloudCheckIcon,
  ACCEPTED: SealCheckIcon,
  closed: SealCheckIcon,
  received: PackageIcon,
  delivered: CheckCircleIcon,

  FAILED: XCircleIcon,
  REJECTED: XCircleIcon,
  CANCELLED: ProhibitIcon,

  EXPIRED: ClockCounterClockwiseIcon,
  short_closed: MinusCircleIcon,
};

