/**
 * `%` and `_` typed by a user are characters, not wildcards. Every ILIKE
 * over user input escapes through here (with `ESCAPE '\'` on the clause):
 * unescaped, `ledgerName=%` matched every ledger and the ledger extract
 * summed them all into one running balance that read as one ledger's
 * statement -- a figure that is wrong without looking wrong.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
}
