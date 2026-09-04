import { describe, expect, it } from 'vitest';

import { isAcceptedUpload, sniffDocument, sniffType } from './magic-bytes.js';

/**
 * Written as attacks, because that is what this function is for. Every case is
 * a payload whose extension and declared content type would say "image".
 */

function withHeader(header: readonly number[], tail = 64): Buffer {
  return Buffer.concat([Buffer.from(header), Buffer.alloc(tail, 0x41)]);
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

describe('magic byte sniffing', () => {
  it('identifies the two formats the product accepts', () => {
    expect(sniffType(withHeader([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe('image/jpeg');
    expect(sniffType(withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.mime).toBe(
      'image/png',
    );
  });

  it('refuses payloads that are not images however they are labelled', () => {
    const hostile: Record<string, number[]> = {
      'ELF executable': [0x7f, ...ascii('ELF'), 0x02, 0x01, 0x01, 0x00],
      'Windows executable': ascii('MZ\x90\x00\x03\x00\x00\x00'),
      'PDF document': ascii('%PDF-1.7\n%????'),
      'ZIP archive': [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00],
      'shell script': ascii('#!/bin/sh\nrm -rf /\n'),
      'HTML with script': ascii('<html><script>alert(1)</script>'),
      'SVG': ascii('<svg xmlns="http://www.w3.org/2000/svg">'),
    };

    for (const [label, bytes] of Object.entries(hostile)) {
      expect(isAcceptedUpload(sniffType(withHeader(bytes))), label).toBe(false);
    }
  });

  it('refuses image formats outside the accepted set, so the list is a whitelist', () => {
    // Each of these is genuinely an image and genuinely identified as one --
    // and still refused, which is the difference between "is it an image" and
    // "is it a format we chose to accept".
    expect(sniffType(withHeader(ascii('GIF89a')))?.mime).toBe('image/gif');
    expect(isAcceptedUpload(sniffType(withHeader(ascii('GIF89a'))))).toBe(false);

    const webp = Buffer.concat([
      Buffer.from(ascii('RIFF')),
      Buffer.from([0x20, 0x00, 0x00, 0x00]),
      Buffer.from(ascii('WEBPVP8 ')),
      Buffer.alloc(32),
    ]);
    expect(sniffType(webp)?.mime).toBe('image/webp');
    expect(isAcceptedUpload(sniffType(webp))).toBe(false);
  });

  it('does not mistake a RIFF container that is not WebP for one', () => {
    const wav = Buffer.concat([
      Buffer.from(ascii('RIFF')),
      Buffer.from([0x20, 0x00, 0x00, 0x00]),
      Buffer.from(ascii('WAVEfmt ')),
      Buffer.alloc(32),
    ]);
    expect(sniffType(wav)).toBeNull();
  });

  it('refuses input too short to identify rather than guessing', () => {
    expect(sniffType(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
    expect(sniffType(Buffer.alloc(0))).toBeNull();
  });

  it('is not fooled by image magic bytes appearing later in the file', () => {
    // The classic near-miss: a payload with a JPEG header a few bytes in, so a
    // sniffer that searches rather than anchors would accept it.
    const buried = Buffer.concat([
      Buffer.from(ascii('GARBAGE!')),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(64),
    ]);
    expect(sniffType(buried)).toBeNull();
  });
});

describe('CRM attachment sniffing (owner, 31 Aug 2026)', () => {
  /** A minimal ZIP local file header naming its first entry. */
  const zipNaming = (entry: string): Buffer => {
    const name = Buffer.from(entry, 'latin1');
    const header = Buffer.alloc(30 + name.length + 8);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(name.length, 26);
    name.copy(header, 30);
    return header;
  };

  it('accepts a real PDF', () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7', 'latin1'), Buffer.alloc(64)]);
    expect(sniffDocument(pdf, 'quote.pdf')?.mime).toBe('application/pdf');
  });

  it('accepts an Office file for what is inside it, not for its name', () => {
    const docx = zipNaming('[Content_Types].xml');
    expect(sniffDocument(docx, 'quote.docx')?.extension).toBe('docx');
    expect(sniffDocument(docx, 'sheet.xlsx')?.mime).toContain('spreadsheetml.sheet');
    // A plain zip wearing a .docx name is refused: the marker is missing.
    expect(sniffDocument(zipNaming('payload.exe'), 'quote.docx')).toBeNull();
    // A real Office file under a name this product does not accept.
    expect(sniffDocument(docx, 'quote.zip')).toBeNull();
  });

  it('refuses an executable, a script and an empty buffer', () => {
    expect(sniffDocument(Buffer.from('MZ' + 'A'.repeat(20), 'latin1'), 'a.pdf')).toBeNull();
    expect(sniffDocument(Buffer.from('<script>alert(1)</script>xxxx', 'latin1'), 'a.pdf')).toBeNull();
    expect(sniffDocument(Buffer.alloc(0), 'a.pdf')).toBeNull();
  });

  it('refuses a file that only claims to be a PDF further in', () => {
    const disguised = Buffer.concat([Buffer.alloc(16, 0x41), Buffer.from('%PDF-1.7', 'latin1')]);
    expect(sniffDocument(disguised, 'a.pdf')).toBeNull();
  });
});
