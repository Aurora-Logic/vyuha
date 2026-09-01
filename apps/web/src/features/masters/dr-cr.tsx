import { cn } from '@/lib/utils';

/**
 * Debit and credit, told apart by colour (owner, 1 Sep 2026: "every document
 * that carried it credit debit use colour and in table view").
 *
 * They were both `text-muted-foreground`, so reading a voucher meant reading
 * two-letter words down a column. A ledger is scanned, not read, and the one
 * thing the eye is scanning for is which side an entry fell on.
 *
 * **Two neutral hues, deliberately not red and green.** A debit is not bad and
 * a credit is not good -- which is which depends entirely on whose ledger it
 * is, and on a customer's account the "bad" one is the opposite of a
 * supplier's. Painting them with the status colours would make the screen
 * assert something about the money that is not true. `--tint-1` and `--tint-3`
 * are distinguishable and mean nothing else in this product.
 *
 * The letters stay whatever the colour does. Colour is never the only carrier
 * of a fact here -- the same rule the charts follow -- so this reads correctly
 * in monochrome, in high contrast, and to anyone who cannot separate the hues.
 */

const DEBIT = 'bg-tint-1/12 text-tint-1';
const CREDIT = 'bg-tint-3/12 text-tint-3';

const PILL = 'rounded-none px-1 py-px text-[0.6875rem] font-medium';

/**
 * Tally's own flag: `true` is the debit side, `false` the credit side, and
 * `null` is a line the pull could not attribute -- which is shown as nothing
 * rather than guessed at.
 */
export function DrCr({ isDeemedPositive }: { readonly isDeemedPositive: boolean | null }) {
  if (isDeemedPositive === null) return null;
  const debit = isDeemedPositive;
  return (
    <span
      className={cn(PILL, debit ? DEBIT : CREDIT)}
      // The two-letter form is what a Tally user reads; the long word is what
      // a screen reader should say.
      aria-label={debit ? 'Debit' : 'Credit'}
    >
      {debit ? 'Dr' : 'Cr'}
    </span>
  );
}

/**
 * A voucher type, tinted when it is one of the two the owner asked for.
 *
 * Only Credit Note and Debit Note are coloured. Tinting every type would make
 * the column a rainbow in which nothing stands out, which is the opposite of
 * what colour is for; these two are the pair somebody scans a register to
 * find, because they are the ones that move money back.
 */
export function VoucherTypeLabel({ type }: { readonly type: string }) {
  const normalised = type.trim().toLowerCase();
  const tone = normalised === 'debit note' ? DEBIT : normalised === 'credit note' ? CREDIT : null;
  if (tone === null) return <span>{type}</span>;
  return <span className={cn(PILL, tone)}>{type}</span>;
}
