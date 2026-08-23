import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEFAULT_DOCUMENT_DESIGN, DOCUMENT_PAPERS, documentDesignSchema } from '@vyuha/shared';
import { describe, expect, it } from 'vitest';

/**
 * The stock a document prints on.
 *
 * #E8D3BE is the owner's colour and the default. The hex lives in one place --
 * the stylesheet -- and this checks the stylesheet actually carries it, because
 * a design token nothing paints is just a name.
 */
const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf8');

describe('paper colour', () => {
  it('defaults to the sand the business asked for', () => {
    expect(DEFAULT_DOCUMENT_DESIGN.paper).toBe('sand');
  });

  it('paints sand as #E8D3BE, and every other stock too', () => {
    expect(css).toMatch(/\.a4-paper\[data-paper='sand'\]\s*\{\s*background:\s*#e8d3be/iu);
    for (const paper of DOCUMENT_PAPERS) {
      expect(css, `${paper} has no rule`).toContain(`.a4-paper[data-paper='${paper}']`);
    }
  });

  it('keeps white available, because that is what a printer on plain stock makes', () => {
    expect(DOCUMENT_PAPERS).toContain('white');
  });

  it('reads a design saved before the field existed', () => {
    // Every organisation has one of these stored; parsing must not fail.
    const { paper, ...withoutPaper } = DEFAULT_DOCUMENT_DESIGN;
    expect(paper).toBeDefined();
    const parsed = documentDesignSchema.parse(withoutPaper);
    expect(parsed.paper).toBe('sand');
  });
});

describe('the design rail offers only controls that do something', () => {
  const rail = readFileSync(resolve(__dirname, 'design-rail.tsx'), 'utf8');
  const slip = readFileSync(resolve(__dirname, 'packing-slip-paper.tsx'), 'utf8');

  it('asks the shared list whether this is slip stock, rather than naming the types again', () => {
    expect(rail).toContain('SLIP_PAPER_TYPES.includes(docType)');
  });

  it('hides paper and accent on slip stock, because the slip reads neither', () => {
    // What the slip actually reads from the design. If this grows to include
    // paper or accent, the rail should stop hiding them.
    const used = new Set([...slip.matchAll(/design\.([a-zA-Z]+)/gu)].map((m) => m[1]));
    expect(used.has('paper'), 'the slip now reads paper — unhide it in the rail').toBe(false);
    expect(used.has('accent'), 'the slip now reads accent — unhide it in the rail').toBe(false);
    expect(rail).toMatch(/\{onSlipStock \? null : \(\s*<Field>\s*<FieldLabel>Paper</u);
    expect(rail).toMatch(/\{onSlipStock \? null : \(\s*<Field>\s*<FieldLabel>Accent</u);
  });

  it('still offers them on a document that is drawn on paper', () => {
    // The gate is a condition, not a deletion.
    expect(rail).toContain('<FieldLabel>Paper</FieldLabel>');
    expect(rail).toContain('<FieldLabel>Accent</FieldLabel>');
  });
});
