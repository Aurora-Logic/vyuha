import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DOCUMENT_DESIGN,
  DOCUMENT_TEMPLATE_IDS,
  SLIP_TEMPLATE_IDS,
  documentDesignSchema,
} from './documents.js';

describe('the document template set', () => {
  it('no longer offers Modern, and offers the three new templates', () => {
    expect(DOCUMENT_TEMPLATE_IDS).not.toContain('modern');
    for (const id of ['formal', 'compact', 'executive'] as const) {
      expect(DOCUMENT_TEMPLATE_IDS).toContain(id);
    }
  });

  it('has three slip layouts, barcode first', () => {
    expect([...SLIP_TEMPLATE_IDS]).toEqual(['barcode', 'label', 'list']);
  });
});

describe('documentDesignSchema migration and defaults', () => {
  it('carries a saved Modern design over to Tally', () => {
    expect(documentDesignSchema.parse({ ...DEFAULT_DOCUMENT_DESIGN, templateId: 'modern' }).templateId).toBe('tally');
  });

  it('carries the older Bold and Classic ids to their successors', () => {
    expect(documentDesignSchema.parse({ ...DEFAULT_DOCUMENT_DESIGN, templateId: 'bold' }).templateId).toBe('tally');
    expect(documentDesignSchema.parse({ ...DEFAULT_DOCUMENT_DESIGN, templateId: 'classic' }).templateId).toBe('bordered');
  });

  it('rejects a template that is neither current nor retired', () => {
    expect(() => documentDesignSchema.parse({ ...DEFAULT_DOCUMENT_DESIGN, templateId: 'nonexistent' })).toThrow();
  });

  it('defaults slipTemplate to barcode for a design saved before it existed', () => {
    const { slipTemplate: _omit, ...withoutSlip } = DEFAULT_DOCUMENT_DESIGN;
    expect(documentDesignSchema.parse(withoutSlip).slipTemplate).toBe('barcode');
  });

  it('keeps an explicit slipTemplate', () => {
    expect(documentDesignSchema.parse({ ...DEFAULT_DOCUMENT_DESIGN, slipTemplate: 'label' }).slipTemplate).toBe('label');
  });
});
