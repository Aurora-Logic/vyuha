import type { InterestDayBasis } from '@vyuha/shared';

/**
 * The one formula of D-22, as pure functions: interest for a period is the
 * SUM of the daily closing balance series times the annual rate over the day
 * basis — never invoice-date arithmetic. Everything here is deterministic
 * over its inputs so the hand-worked examples in `interest-math.test.ts` can
 * pin exact numbers; nothing reads a clock, a database or a setting.
 *
 * Rounding: none. Sums are carried at full precision and the callers round
 * at display (the snapshot writer stores the daily balances at the paisa,
 * which is the grain of the ledger itself, not a display rounding).
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Calendar days as an integer epoch, so date arithmetic cannot drift with a timezone. */
export function epochDay(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / MS_PER_DAY);
}

export function isoOfEpochDay(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** A party override beats the org rate; that is the whole precedence. */
export function resolveAnnualRatePct(orgRatePct: number, overridePct: number | null): number {
  return overridePct ?? orgRatePct;
}

/**
 * SUM(daily closing balance) x annual_rate / day_basis. The sum is in
 * rupee-days; the result is rupees, unrounded.
 */
export function interestOnRupeeDays(
  sumOfDailyClosings: number,
  annualRatePct: number,
  dayBasis: InterestDayBasis,
): number {
  return (sumOfDailyClosings * annualRatePct) / 100 / dayBasis;
}

// ------------------------------------------------------------- receivables

export interface BillEvent {
  /** YYYY-MM-DD. */
  readonly date: string;
  /** Positive rupees. */
  readonly amount: number;
  /** Tally's bill name, when the voucher carried a `new` allocation. */
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
  remaining: number;
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

  const billsByDay = new Map<number, BillEvent[]>();
  for (const bill of input.bills) {
    const day = epochDay(bill.date);
    const list = billsByDay.get(day) ?? [];
    list.push(bill);
    billsByDay.set(day, list);
  }
  const settlementsByDay = new Map<number, SettlementEvent[]>();
  for (const settlement of input.settlements) {
    const day = epochDay(settlement.date);
    const list = settlementsByDay.get(day) ?? [];
    list.push(settlement);
    settlementsByDay.set(day, list);
  }

  // Insertion order is FIFO: bills are pushed chronologically below.
  const open: OpenBill[] = [];
  let advance = 0;

  const raise = (day: number, amount: number, key: string | null): void => {
    let remaining = amount;
    if (advance > 0) {
      const applied = Math.min(advance, remaining);
      advance -= applied;
      remaining -= applied;
    }
    if (remaining > 0) open.push({ day, key, remaining });
  };

  const settle = (amount: number, billKey: string | undefined): void => {
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
  };

  if (input.openingBalance > 0) raise(startDay, input.openingBalance, null);
  else if (input.openingBalance < 0) advance = -input.openingBalance;

  const series: PartyDay[] = [];
  for (let day = startDay; day <= endDay; day += 1) {
    for (const bill of billsByDay.get(day) ?? []) raise(day, bill.amount, bill.key ?? null);
    for (const settlement of settlementsByDay.get(day) ?? []) settle(settlement.amount, settlement.billKey);

    let withinCredit = 0;
    let overdue = 0;
    for (const bill of open) {
      if (bill.remaining <= 0) continue;
      // Within credit while the bill's age has not passed the credit days;
      // overdue from the day after due, in calendar days with no holiday
      // exclusion — money costs interest on a Sunday too.
      if (day - bill.day <= input.creditDays) withinCredit += bill.remaining;
      else overdue += bill.remaining;
    }
    // An advance can only be positive while no bill remains (a new bill
    // consumes it first), so the negative lands whole in `overdue`.
    overdue -= advance;
    series.push({ date: isoOfEpochDay(day), closing: withinCredit + overdue, withinCredit, overdue });
  }
  return series;
}

// ------------------------------------------------------------------- stock

export interface StockEvent {
  readonly date: string;
  readonly kind: 'inward' | 'outward';
  /** Positive units. */
  readonly quantity: number;
  /** Inward only: the purchase rate per unit (purchase cost basis, D-22 rule 3). */
  readonly rate?: number;
  /** Inward only: the vendor's credit days for this layer's funding clock. */
  readonly creditDays?: number;
}

export interface StockDay {
  readonly date: string;
  readonly quantity: number;
  readonly closingValue: number;
  readonly fundedValue: number;
}

interface StockLayer {
  readonly day: number;
  readonly creditDays: number;
  remaining: number;
}

/**
 * The daily stock series for one item. Closing value is quantity on hand at
 * the running weighted-average purchase rate. Funded value implements the
 * D-22 clock: each day's funded value is the value of stock whose age since
 * its inward exceeds that inward's vendor credit days — until then the
 * vendor's money is holding the shelf, not ours. Layers age individually
 * and outward movement consumes the oldest layer first, so a fresh delivery
 * cannot reset the clock on old stock; returns to vendor are outward events
 * on the return's own date and reduce the series from there forward.
 */
export function buildStockDailySeries(input: {
  readonly seriesStart: string;
  readonly to: string;
  readonly events: readonly StockEvent[];
}): StockDay[] {
  const startDay = epochDay(input.seriesStart);
  const endDay = epochDay(input.to);
  if (endDay < startDay) return [];

  const eventsByDay = new Map<number, StockEvent[]>();
  for (const event of input.events) {
    const day = epochDay(event.date);
    const list = eventsByDay.get(day) ?? [];
    list.push(event);
    eventsByDay.set(day, list);
  }

  const layers: StockLayer[] = [];
  let quantity = 0;
  let value = 0;

  const series: StockDay[] = [];
  for (let day = startDay; day <= endDay; day += 1) {
    for (const event of eventsByDay.get(day) ?? []) {
      if (event.kind === 'inward') {
        quantity += event.quantity;
        value += event.quantity * (event.rate ?? 0);
        layers.push({ day, creditDays: event.creditDays ?? 0, remaining: event.quantity });
      } else {
        const rate = quantity > 0 ? value / quantity : 0;
        quantity -= event.quantity;
        value -= event.quantity * rate;
        let toConsume = event.quantity;
        for (const layer of layers) {
          if (toConsume <= 0) break;
          const consumed = Math.min(layer.remaining, toConsume);
          layer.remaining -= consumed;
          toConsume -= consumed;
        }
      }
    }

    const wavgRate = quantity > 0 ? value / quantity : 0;
    let fundedQty = 0;
    for (const layer of layers) {
      if (layer.remaining <= 0) continue;
      if (day - layer.day > layer.creditDays) fundedQty += layer.remaining;
    }
    series.push({
      date: isoOfEpochDay(day),
      quantity,
      closingValue: quantity * wavgRate,
      fundedValue: fundedQty * wavgRate,
    });
  }
  return series;
}

/**
 * Non-moving (D-22): zero outward movement for the threshold. An item whose
 * last outward was exactly N days ago has had N movement-free days and is
 * flagged; one at N-1 is not. Null means no outward in the whole series,
 * which is the most non-moving an item can be.
 */
export function isNonMoving(daysSinceOutward: number | null, thresholdDays: number): boolean {
  return daysSinceOutward === null || daysSinceOutward >= thresholdDays;
}
