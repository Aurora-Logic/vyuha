import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { crc32, storeZip } from './store-zip.js';

describe('the store-only zip writer', () => {
  it('computes the standard CRC-32', () => {
    // The check value every CRC-32 implementation must produce.
    expect(crc32(Buffer.from('123456789', 'ascii')).toString(16)).toBe('cbf43926');
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('produces an archive a real unzip accepts, byte for byte', () => {
    const zip = storeZip(
      [
        { name: 'a.txt', bytes: Buffer.from('hello zip') },
        { name: 'nested/b.txt', bytes: Buffer.from('second entry') },
      ],
      new Date(2026, 7, 28, 10, 30, 0),
    );
    // Structure: local header signature first, end-of-central-directory last.
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);

    // The honest check: the platform's own unzip must list and verify it.
    const dir = mkdtempSync(join(tmpdir(), 'store-zip-'));
    const file = join(dir, 'probe.zip');
    writeFileSync(file, zip);
    const listing = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
    expect(listing).toContain('a.txt');
    expect(listing).toContain('nested/b.txt');
    expect(listing).toContain('No errors detected');
  });
});
