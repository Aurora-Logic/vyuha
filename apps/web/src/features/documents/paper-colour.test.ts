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
