import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findBreadcrumbs } from './nav';

/**
 * Every screen under the shell must have a name. A route that renders
 * perfectly while the header announces "Not found" has happened four times
 * (the off-nav table and the detail table in nav.ts each record one), most
 * recently for the packing slip and, after the fulfilment entries were
 * folded into one, the stage screens themselves. So the routes are read
 * from App.tsx rather than listed here, and each one is asked its crumbs.
 */
const OUTSIDE_THE_SHELL = new Set(['print/:kind/:id', 'print/close-pack', 'patterns', '*']);

function shellRoutes(): string[] {
  const source = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
  return [...source.matchAll(/path="([^"]+)"/gu)].map((m) => m[1] ?? '').filter((p) => p !== '' && !OUTSIDE_THE_SHELL.has(p));
}

describe('findBreadcrumbs', () => {
  it('names every shell route in App.tsx', () => {
    const routes = shellRoutes();
    expect(routes.length).toBeGreaterThan(40);
    const nameless = routes.filter((route) => {
      const crumbs = findBreadcrumbs(`/${route.replace(/:[a-z]+/gu, 'x')}`);
      return crumbs.some((c) => c.label === 'Not found');
    });
    expect(nameless).toEqual([]);
  });

  it('names each fulfilment stage, the delivered screen, and the packing slip under Packed', () => {
    expect(findBreadcrumbs('/sales/packs/abc').map((c) => c.label)).toEqual(['Fulfilment', 'Packed', 'Packing slip']);
    expect(findBreadcrumbs('/sales/delivered').at(-1)?.label).toBe('Delivered');
    expect(findBreadcrumbs('/sales/dispatches/abc').map((c) => c.label)).toEqual(['Fulfilment', 'Dispatches', 'Dispatch']);
    expect(findBreadcrumbs('/sales/awaiting-invoice').at(-1)?.label).toBe('Awaiting invoice');
  });
});
