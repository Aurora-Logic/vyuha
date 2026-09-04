/**
 * Content sniffing by leading bytes.
 *
 * Technical design §7: "Reject uploads over 3MB and anything that isn't a
 * JPEG/PNG **by magic bytes, not extension**." §15 lists file upload abuse
 * against the same control.
 *
 * The reason the extension and the `Content-Type` header are not consulted at
 * all -- not even as a hint -- is that both are supplied by the same party
 * supplying the bytes. A `.jpg` name on a shell script is one line of client
 * code. The only fact that survives an attacker choosing every field is what
 * the bytes actually are.
 *
 * Sniffing on its own is still not sufficient, and it is important to be
 * honest about that: a file can begin with `FF D8 FF` and carry a payload
 * after the image data, and a decoder with a parsing bug does not care what
 * the first three bytes said. That is why nothing reaches storage without
 * being decoded and re-encoded by `sanitizeImage` -- the sniff decides whether
 * to attempt a decode at all, and the re-encode is what makes the stored
 * object safe.
 */

export interface SniffedType {
  /** The canonical media type. Never the one the client claimed. */
  readonly mime: string;
  /** File extension used when building a storage key. No leading dot. */
  readonly extension: string;
  /** Human-readable, for an error the uploader can act on. */
  readonly label: string;
}

interface Signature extends SniffedType {
  readonly offset: number;
  readonly bytes: readonly number[];
  /** A second run of bytes further in, for containers such as RIFF. */
  readonly also?: { readonly offset: number; readonly bytes: readonly number[] };
}

const ascii = (text: string): readonly number[] => [...text].map((c) => c.charCodeAt(0));

/**
 * Ordered longest-prefix-first where two signatures could overlap. The
 * non-image entries earn their place by producing a message that names what
 * was actually uploaded: "that is a PDF" sends someone to the right fix, and
 * "unsupported file type" sends them to support.
 */
const SIGNATURES: readonly Signature[] = [
  { mime: 'image/jpeg', extension: 'jpg', label: 'JPEG image', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  {
    mime: 'image/png',
    extension: 'png',
    label: 'PNG image',
    offset: 0,
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  {
    mime: 'image/webp',
    extension: 'webp',
    label: 'WebP image',
    offset: 0,
    bytes: ascii('RIFF'),
    also: { offset: 8, bytes: ascii('WEBP') },
  },
  { mime: 'image/gif', extension: 'gif', label: 'GIF image', offset: 0, bytes: ascii('GIF8') },
  {
    mime: 'image/tiff',
    extension: 'tiff',
    label: 'TIFF image',
    offset: 0,
    bytes: [0x49, 0x49, 0x2a, 0x00],
  },
  {
    mime: 'image/tiff',
    extension: 'tiff',
    label: 'TIFF image',
    offset: 0,
    bytes: [0x4d, 0x4d, 0x00, 0x2a],
  },
  { mime: 'image/bmp', extension: 'bmp', label: 'BMP image', offset: 0, bytes: ascii('BM') },
  { mime: 'application/pdf', extension: 'pdf', label: 'PDF document', offset: 0, bytes: ascii('%PDF-') },
  {
    mime: 'application/zip',
    extension: 'zip',
    label: 'ZIP archive (or an Office document)',
    offset: 0,
    bytes: [0x50, 0x4b, 0x03, 0x04],
  },
  {
    mime: 'application/gzip',
    extension: 'gz',
    label: 'gzip archive',
    offset: 0,
    bytes: [0x1f, 0x8b],
  },
  {
    mime: 'application/x-executable',
    extension: 'bin',
    label: 'Linux executable',
    offset: 0,
    bytes: [0x7f, ...ascii('ELF')],
  },
  {
    mime: 'application/x-msdownload',
    extension: 'bin',
    label: 'Windows executable',
    offset: 0,
    bytes: ascii('MZ'),
  },
  {
    mime: 'application/x-mach-binary',
    extension: 'bin',
    label: 'macOS executable',
    offset: 0,
    bytes: [0xcf, 0xfa, 0xed, 0xfe],
  },
];

/** The longest signature plus its offset; nothing shorter can be identified. */
const MIN_SNIFFABLE_BYTES = 12;

function matchesAt(input: Buffer, offset: number, bytes: readonly number[]): boolean {
  if (input.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (input[offset + i] !== bytes[i]) return false;
  }
  return true;
}

/** Returns the identified type, or null when nothing matches. */
export function sniffType(input: Buffer): SniffedType | null {
  if (input.length < MIN_SNIFFABLE_BYTES) return null;

  for (const signature of SIGNATURES) {
    if (!matchesAt(input, signature.offset, signature.bytes)) continue;
    if (signature.also !== undefined && !matchesAt(input, signature.also.offset, signature.also.bytes)) {
      continue;
    }
    return { mime: signature.mime, extension: signature.extension, label: signature.label };
  }

  return null;
}

/**
 * What a punch photo or an attachment is allowed to be. WebP is deliberately
 * absent: technical design §7 names JPEG and PNG, and every capture path in
 * the product produces one of those.
 */
export const ACCEPTED_UPLOAD_MIMES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png']);

export function isAcceptedUpload(sniffed: SniffedType | null): boolean {
  return sniffed !== null && ACCEPTED_UPLOAD_MIMES.has(sniffed.mime);
}

/**
 * What a CRM attachment may be (owner, 31 Aug 2026: documents and images).
 *
 * Images travel the punch pipeline, which re-encodes them. The document half
 * is sniffed the same way everything else here is: a PDF by its `%PDF-`
 * header, and an Office file by what it actually is -- a ZIP whose first
 * entry is `[Content_Types].xml`, the marker every OOXML file carries. The
 * extension is never the evidence; a `.docx` that is really a zip of
 * something else fails this check, which is the point of doing it.
 */
export const OOXML_MIME = 'application/vnd.openxmlformats-officedocument';

/** True when a ZIP is an OOXML container (docx, xlsx, pptx). */
export function isOoxmlContainer(input: Buffer): boolean {
  // Local file header: signature(4) version(2) flags(2) method(2) time(4)
  // crc(4) sizes(8) then nameLength(2) at offset 26, the name from offset 30.
  if (input.length < 38) return false;
  const nameLength = input.readUInt16LE(26);
  if (nameLength <= 0 || input.length < 30 + nameLength) return false;
  return input.subarray(30, 30 + nameLength).toString('latin1') === '[Content_Types].xml';
}

export interface AcceptedDocument {
  readonly mime: string;
  readonly extension: string;
  readonly label: string;
}

/**
 * The non-image half of a CRM attachment, or null when the bytes are not
 * something this product agreed to store.
 */
export function sniffDocument(input: Buffer, filename: string): AcceptedDocument | null {
  const sniffed = sniffType(input);
  if (sniffed === null) return null;
  if (sniffed.mime === 'application/pdf') {
    return { mime: sniffed.mime, extension: 'pdf', label: sniffed.label };
  }
  if (sniffed.mime === 'application/zip' && isOoxmlContainer(input)) {
    // Which Office file it is comes from the name, but only after the bytes
    // proved it is an Office file at all.
    const extension = /\.(docx|xlsx|pptx)$/iu.exec(filename)?.[1]?.toLowerCase();
    if (extension === undefined) return null;
    const suffix = extension === 'docx' ? 'wordprocessingml.document' : extension === 'xlsx' ? 'spreadsheetml.sheet' : 'presentationml.presentation';
    return { mime: `${OOXML_MIME}.${suffix}`, extension, label: `Office ${extension.toUpperCase()} document` };
  }
  return null;
}
