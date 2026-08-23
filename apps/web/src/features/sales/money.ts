/**
 * Kept as a forwarding module, not a second implementation.
 *
 * This file used to define its own `formatMoney` that called `formatAmount`
 * and stopped there -- no currency symbol -- and seventeen files across sales,
 * purchase, CRM and documents imported it. Ninety-three figures rendered as
 * "12,34,567.50" while the canonical formatter in `@/lib/format` was right
 * there, and nothing caught it because a number without its symbol is still a
 * number.
 *
 * The importers move over as the files they live in are next touched; this
 * re-export means none of them is wrong in the meantime.
 */
export { formatMoney } from '@/lib/format';
