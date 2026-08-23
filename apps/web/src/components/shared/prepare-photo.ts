/**
 * REQ-AA-20/AA-21: a dispatch photograph from the camera or the gallery,
 * made ready to send.
 *
 * A gallery photograph from a phone is 4–8 MB; the files service refuses
 * anything over 3 MB and would re-encode to a 1600px edge anyway. So the
 * bytes are decoded and re-encoded here first, to the same edge, which
 * keeps the upload under the limit without lowering what the server keeps.
 * Decoding is also what proves the file is an image before it is sent.
 *
 * The preview is an object URL, minted here and revoked by the caller when
 * the thumbnail goes — a data URL of a 1600px JPEG is a megabyte of string
 * held in React state for nothing.
 */

export const PHOTO_ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

export interface PreparedPhoto {
  readonly file: File;
  readonly previewUrl: string;
}

export interface PhotoRejection {
  readonly reason: string;
}

export function isPhotoRejection(value: PreparedPhoto | PhotoRejection): value is PhotoRejection {
  return 'reason' in value;
}

export async function preparePhoto(file: File): Promise<PreparedPhoto | PhotoRejection> {
  if (!PHOTO_ACCEPTED_TYPES.includes(file.type as (typeof PHOTO_ACCEPTED_TYPES)[number])) {
    return { reason: 'Choose a JPEG, PNG or WebP photograph.' };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { reason: 'That file could not be read as an image.' };
  }

  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return { reason: 'This browser could not process the image.' };
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
    });
    if (blob === null) return { reason: 'This browser could not encode the image.' };
    if (blob.size > MAX_UPLOAD_BYTES) return { reason: 'That photograph is too large even after resizing. Try a smaller one.' };

    const name = `${file.name.replace(/\.[^.]+$/u, '') || 'photo'}.jpg`;
    const prepared = new File([blob], name, { type: 'image/jpeg' });
    return { file: prepared, previewUrl: URL.createObjectURL(blob) };
  } finally {
    bitmap.close();
  }
}
