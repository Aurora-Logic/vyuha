/**
 * The open-bill ledger over projected vouchers: a bill raises on its own
 * date, a settlement reduces the oldest open bill first unless it carries a
 * Tally bill mark, and what exceeds every open bill becomes an advance the
 * next bill consumes before it ages at all.
 *
 * This lives in platform because two modules read the same books — interest
 * prices the daily balances (D-22), the Virtual CFO photographs the open
 * bills (D-23) — and modules may not import each other; the arithmetic lives
 * where both may reach it. The interest-specific rate and day-basis pricing
 * stays in `modules/interest/interest-math.ts`: only the billing/settlement
 * construction is shared. Everything here is deterministic over its inputs —
 * nothing reads a clock, a database or a setting.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Calendar days as an integer epoch, so date arithmetic cannot drift with a timezone. */
export function epochDay(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / MS_PER_DAY);
}

export function isoOfEpochDay(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

export interface BillEvent {
  /** YYYY-MM-DD. */
  readonly date: string;
  /** Positive rupees. */
  readonly amount: number;
  /** The bill's name: Tally's `new` allocation mark, or the voucher number at voucher grain. */
  readonly key?: string;
}

export interface SettlementEvent {
  readonly date: string;
  /** Positive rupees. */
  readonly amount: number;
  /** Tally's `against` mark; FIFO oldest-first when absent (D-22 rule 5). */
  readonly billKey?: string;
}

export interface PartyDay {
  readonly date: string;
  readonly closing: number;
  readonly withinCredit: number;
  readonly overdue: number;
}

interface OpenBill {
  readonly day: number;
  readonly key: string | null;
  /** What the bill was raised for, before any settlement. */
  readonly amount: number;
  remaining: number;
}

interface OpenBillLedger {
  readonly open: readonly OpenBill[];
  raise(day: number, amount: number, key: string | null): void;
  settle(amount: number, billKey: string | undefined): void;
  advance(): number;
}

function openBillLedger(): OpenBillLedger {
  // Insertion order is FIFO: callers raise bills chronologically.
  const open: OpenBill[] = [];
  let advance = 0;
  return {
    open,
    raise(day, amount, key) {
      let remaining = amount;
      if (advance > 0) {
        const applied = Math.min(advance, remaining);
        advance -= applied;
        remaining -= applied;
      }
      if (remaining > 0) open.push({ day, key, amount, remaining });
    },
    settle(amount, billKey) {
      let left = amount;
      if (billKey !== undefined) {
        const target = open.find((bill) => bill.key === billKey && bill.remaining > 0);
        if (target !== undefined) {
          const applied = Math.min(target.remaining, left);
          target.remaining -= applied;
          left -= applied;
        }
      }
      for (const bill of open) {
        if (left <= 0) break;
        const applied = Math.min(bill.remaining, left);
        bill.remaining -= applied;
        left -= applied;
      }
      if (left > 0) advance += left;
    },
    advance: () => advance,
  };
}

function groupByDay<T extends { readonly date: string }>(events: readonly T[]): Map<number, T[]> {
  const byDay = new Map<number, T[]>();
  for (const event of events) {
    const day = epochDay(event.date);
    const list = byDay.get(day) ?? [];
    list.push(event);
    byDay.set(day, list);
  }
  return byDay;
}

/**
 * The voucher-grain daily series for one party (D-22 rule 7): each bill is
 * within credit through its date plus the credit days, overdue from the day
 * after. Settlements reduce the oldest bill first unless they carry a Tally
 * bill mark; what exceeds every open bill becomes an advance, which the next
 * bill consumes before it ages at all. A party in advance closes negative,
 * and the negative rides in `overdue` — interest gained, never clamped —
 * so the loss column is the one honest number either way.
 *
 * Part payments, credit notes and backdated entries need no special arms:
 * each is an event on its own date, and the series only ever reads events
 * up to the day being closed.
 */
export function buildPartyDailySeries(input: {
  readonly seriesStart: string;
  readonly to: string;
  /** Seeds a bill (positive) or an advance (negative) at `seriesStart` (D-22 rule 6). */
  readonly openingBalance: number;
  readonly creditDays: number;
  readonly bills: readonly BillEvent[];
  readonly settlements: readonly SettlementEvent[];
}): PartyDay[] {
  const startDay = epochDay(input.seriesStart);
  const endDay = epochDay(input.to);
  if (endDay < startDay) return [];

  const billsByDay = groupByDay(input.bills);
  const settlementsByDay = groupByDay(input.settlements);

  const ledger = openBillLedger();
  if (input.openingBalance > 0) ledger.raise(startDay, input.openingBalance, null);
  else if (input.openingBalance < 0) ledger.settle(-input.openingBalance, undefined);

  const series: PartyDay[] = [];
  for (let day = startDay; day <= endDay; day += 1) {
    for (const bill of billsByDay.get(day) ?? []) ledger.raise(day, bill.amount, bill.key ?? null);
    for (const settlement of settlementsByDay.get(day) ?? []) ledger.settle(settlement.amount, settlement.billKey);

    let withinCredit = 0;
    let overdue = 0;
    for (const bill of ledger.open) {
      if (bill.remaining <= 0) continue;
      // Within credit while the bill's age has not passed the credit days;
      // overdue from the day after due, in calendar days with no holiday
      // exclusion — money costs interest on a Sunday too.
      if (day - bill.day <= input.creditDays) withinCredit += bill.remaining;
      else overdue += bill.remaining;
    }
    // An advance can only be positive while no bill remains (a new bill
    // consumes it first), so the negative lands whole in `overdue`.
    overdue -= ledger.advance();
    series.push({ date: isoOfEpochDay(day), closing: withinCredit + overdue, withinCredit, overdue });
  }
  return series;
}

export interface OpenBillState {
  /** The bill's own date, YYYY-MM-DD. */
  readonly date: string;
  readonly key: string | null;
  /** What the bill was raised for. */
  readonly amount: number;
  /** What is still open on it, always positive. */
  readonly outstanding: number;
}

/**
 * The open book at the end of `through`: every bill still carrying a balance
 * after the raises and settlements up to that day have been replayed, bills
 * before settlements within a day, exactly as the daily series walks them.
 * A party wholly in advance returns no bills — the advance is real money,
 * but not an open bill, and it has no date to age from.
 *
 * `opening` is D-22 rule 6, exactly as `buildPartyDailySeries` applies it:
 * a positive amount is a keyless bill of `opening.date`, a negative one an
 * advance from before the books begin. Left out, receipts that in truth
 * settle the opening balance would read as advances and consume later
 * bills before they age — the open book would understate itself.
 */
export function openBillsThrough(input: {
  readonly through: string;
  readonly opening?: { readonly date: string; readonly amount: number };
  readonly bills: readonly BillEvent[];
  readonly settlements: readonly SettlementEvent[];
}): OpenBillState[] {
  const endDay = epochDay(input.through);
  const billsByDay = groupByDay(input.bills);
  const settlementsByDay = groupByDay(input.settlements);

  const days = [...new Set([...billsByDay.keys(), ...settlementsByDay.keys()])]
    .filter((day) => day <= endDay)
    .sort((a, b) => a - b);

  const ledger = openBillLedger();
  if (input.opening !== undefined && epochDay(input.opening.date) <= endDay) {
    if (input.opening.amount > 0) ledger.raise(epochDay(input.opening.date), input.opening.amount, null);
    else if (input.opening.amount < 0) ledger.settle(-input.opening.amount, undefined);
  }
  for (const day of days) {
    for (const bill of billsByDay.get(day) ?? []) ledger.raise(day, bill.amount, bill.key ?? null);
    for (const settlement of settlementsByDay.get(day) ?? []) ledger.settle(settlement.amount, settlement.billKey);
  }

  return ledger.open
    .filter((bill) => bill.remaining > 0)
    .map((bill) => ({ date: isoOfEpochDay(bill.day), key: bill.key, amount: bill.amount, outstanding: bill.remaining }));
}
