/**
 * P4 import: pasted rows become class assignments only after a preview.
 * The text is what a spreadsheet gives on copy -- one customer per line,
 * tab-separated (Excel) or comma-separated, as name, class, optional
 * reason. Names may themselves contain commas, so the class column is
 * found by looking for a known class code, not by counting fields.
 */

export interface ImportLine {
  /** 1-based line number in the pasted text, for pointing at problems. */
  readonly line: number;
  readonly raw: string;
  readonly party: string;
  readonly tierCode: string | null;
  readonly reason: string;
}

/** Collapse runs of whitespace so a name pasted with double spaces still matches. */
export function normaliseName(name: string): string {
  return name.trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function parseClassImport(text: string, knownCodes: readonly string[]): ImportLine[] {
  const codes = new Map(knownCodes.map((code) => [code.toUpperCase(), code]));
  const lines = text.split(/\r?\n/u);
  const out: ImportLine[] = [];
  lines.forEach((raw, index) => {
    if (raw.trim() === '') return;
    const fields = (raw.includes('\t') ? raw.split('\t') : raw.split(',')).map((f) => f.trim());
    // The class column is the first field after the name that is a known
    // code; everything before it is the name, everything after the reason.
    let at = -1;
    for (let i = 1; i < fields.length; i += 1) {
      if (codes.has((fields[i] ?? '').toUpperCase())) { at = i; break; }
    }
    // A header row ("Customer, Class, Reason") names the columns instead of
    // filling them; it is dropped, not reported as an unknown customer.
    if (at === -1 && index === 0 && fields.some((f) => /^(class|tier|customer|party|name|reason)$/iu.test(f))) return;
    out.push({
      line: index + 1,
      raw,
      party: (at === -1 ? fields : fields.slice(0, at)).join(', ').trim(),
      tierCode: at === -1 ? null : (codes.get((fields[at] ?? '').toUpperCase()) ?? null),
      reason: at === -1 ? '' : fields.slice(at + 1).join(', ').trim(),
    });
  });
  return out;
}
