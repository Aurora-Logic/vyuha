/**
 * The five-factor growth bridge (brief D1), pure. Last year's net becomes
 * this year's through volume, price, mix, new customers and lost customers —
 * and the factors MUST sum to the actual change exactly, or the bridge is
 * decorative and must not ship (Q1.6 rule five, the acceptance test).
 *
 * Grain: customer × SKU. Price here is net realisation (net ÷ qty) — the
 * pocket-price version arrives with the valuation decision (M1), and the
 * definition panel says which one a bridge used.
 *
 * The residual definition makes the tie exact by construction:
 * - a customer with no last-year revenue is NEW, whole;
 * - a customer with no this-year revenue is LOST, whole;
 * - inside retained customers, SKUs priced in both years carry volume and
 *   price effects, and everything else those customers did — new lines,
 *   dropped lines, ledger-only movements — is MIX, computed as the retained
 *   change minus volume minus price, never independently.
 */

export interface BridgeRow {
  readonly customerKey: string;
  readonly itemKey: string;
  /** Base-UOM quantity; 0 for ledger-only rows, where realisation is undefined. */
  readonly qty: number;
  readonly net: number;
}

export interface GrowthBridge {
  readonly lastYear: number;
  readonly thisYear: number;
  readonly change: number;
  readonly volumeEffect: number;
  readonly priceEffect: number;
  readonly mixEffect: number;
  readonly newCustomerEffect: number;
  readonly lostCustomerEffect: number;
  /** |sum of factors − change|; anything above a paisa is a defect. */
  readonly reconciliationError: number;
}

const r2 = (value: number): number => Math.round(value * 100) / 100;

export function growthBridge(thisYear: readonly BridgeRow[], lastYear: readonly BridgeRow[]): GrowthBridge {
  const byCustomer = (rows: readonly BridgeRow[]): Map<string, Map<string, { qty: number; net: number }>> => {
    const map = new Map<string, Map<string, { qty: number; net: number }>>();
    for (const row of rows) {
      const items = map.get(row.customerKey) ?? new Map<string, { qty: number; net: number }>();
      const item = items.get(row.itemKey) ?? { qty: 0, net: 0 };
      item.qty += row.qty;
      item.net += row.net;
      items.set(row.itemKey, item);
      map.set(row.customerKey, items);
    }
    return map;
  };

  const ty = byCustomer(thisYear);
  const ly = byCustomer(lastYear);
  const totalOf = (map: Map<string, Map<string, { qty: number; net: number }>>): number => {
    let total = 0;
    for (const items of map.values()) for (const item of items.values()) total += item.net;
    return total;
  };
  const tyTotal = totalOf(ty);
  const lyTotal = totalOf(ly);

  let newEffect = 0;
  let lostEffect = 0;
  let volume = 0;
  let price = 0;
  let retainedTy = 0;
  let retainedLy = 0;

  for (const [customer, items] of ty) {
    if (!ly.has(customer)) {
      for (const item of items.values()) newEffect += item.net;
    }
  }
  for (const [customer, items] of ly) {
    if (!ty.has(customer)) {
      for (const item of items.values()) lostEffect -= item.net;
    }
  }

  for (const [customer, tyItems] of ty) {
    const lyItems = ly.get(customer);
    if (lyItems === undefined) continue;
    for (const item of tyItems.values()) retainedTy += item.net;
    for (const item of lyItems.values()) retainedLy += item.net;
    for (const [itemKey, tyItem] of tyItems) {
      const lyItem = lyItems.get(itemKey);
      if (lyItem === undefined || tyItem.qty <= 0 || lyItem.qty <= 0) continue;
      const pTy = tyItem.net / tyItem.qty;
      const pLy = lyItem.net / lyItem.qty;
      volume += (tyItem.qty - lyItem.qty) * pLy;
      price += (pTy - pLy) * tyItem.qty;
    }
  }

  // The residual: everything retained customers did that the volume and
  // price terms could not price — new lines, dropped lines, ledger-only.
  const mix = retainedTy - retainedLy - volume - price;

  const change = tyTotal - lyTotal;
  const sum = volume + price + mix + newEffect + lostEffect;

  return {
    lastYear: r2(lyTotal),
    thisYear: r2(tyTotal),
    change: r2(change),
    volumeEffect: r2(volume),
    priceEffect: r2(price),
    mixEffect: r2(mix),
    newCustomerEffect: r2(newEffect),
    lostCustomerEffect: r2(lostEffect),
    reconciliationError: Math.abs(r2(sum) - r2(change)),
  };
}
