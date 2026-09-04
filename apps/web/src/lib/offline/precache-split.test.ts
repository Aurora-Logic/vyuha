import { describe, expect, it } from 'vitest';

import { splitPrecache, type BuiltFile } from './precache-split';

/** A build the way Rollup describes one: an entry, shared vendor chunks, one lazy route per feature. */
const chunk = (over: Partial<BuiltFile>): BuiltFile => ({ type: 'chunk', imports: [], facadeModuleId: null, ...over });

const bundle: Record<string, BuiltFile> = {
  'index.html': { type: 'asset' },
  'sw.js': { type: 'asset' },
  'assets/index-a1.css': { type: 'asset' },
  'assets/index-a1.js': chunk({ isEntry: true, imports: ['assets/react-vendor-b2.js', 'assets/ui-c3.js', 'assets/app-lib-d4.js'] }),
  'assets/react-vendor-b2.js': chunk({}),
  'assets/ui-c3.js': chunk({ imports: ['assets/react-vendor-b2.js'] }),
  'assets/app-lib-d4.js': chunk({ imports: ['assets/react-vendor-b2.js'] }),
  'assets/punch-e5.js': chunk({ facadeModuleId: '/repo/apps/web/src/features/punch/index.ts', imports: ['assets/ui-c3.js', 'assets/camera-f6.js'] }),
  'assets/camera-f6.js': chunk({}),
  'assets/reports-g7.js': chunk({ facadeModuleId: '/repo/apps/web/src/features/reports/index.ts', imports: ['assets/ui-c3.js', 'assets/charts-h8.js'] }),
  'assets/charts-h8.js': chunk({}),
  'icons/icon-192.png': { type: 'asset' },
};

describe('splitPrecache', () => {
  const { critical, optional } = splitPrecache(bundle);

  it('installs the entry, what it imports, every stylesheet and the punch screen atomically', () => {
    expect(critical).toEqual([
      '/assets/app-lib-d4.js',
      '/assets/camera-f6.js',
      '/assets/index-a1.css',
      '/assets/index-a1.js',
      '/assets/punch-e5.js',
      '/assets/react-vendor-b2.js',
      '/assets/ui-c3.js',
    ]);
  });

  it('leaves the other routes, and their own chunks, to be fetched as they can', () => {
    expect(optional).toEqual(['/assets/charts-h8.js', '/assets/reports-g7.js', '/icons/icon-192.png']);
  });

  it('never lists index.html or the worker itself', () => {
    expect([...critical, ...optional]).not.toContain('/index.html');
    expect([...critical, ...optional]).not.toContain('/sw.js');
  });
});
