import { useRef, useState } from 'react';
import { CameraIcon, ImagesIcon, XIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';

import { PHOTO_ACCEPTED_TYPES, isPhotoRejection, preparePhoto, type PreparedPhoto } from './prepare-photo';

/**
 * The camera-or-gallery picker every photographed record uses: a dispatch's
 * boxes and LR (REQ-AA-20/AA-21), a delivery at the door (D-47), and the
 * goods on a return desk (15 REQ-AK-04). It lives here rather than in the
 * sales feature because a return is not a dispatch, and a second copy of a
 * hidden file input is a second place for the same bug.
 */
/**
 * Camera or gallery (REQ-AA-21), through the one sanctioned hidden file
 * input (components/shared/org-logo-dialog.tsx). Two inputs rather than one:
 * `capture` makes a phone open the camera and skip the gallery, and an LR
 * is often a scan that only exists in the gallery.
 */
export function PhotoPicker({
  label,
  hint,
  photos,
  max,
  error,
  disabled,
  onAdd,
  onRemove,
}: {
  label: string;
  hint: string;
  photos: readonly PreparedPhoto[];
  max: number;
  error: string | null;
  disabled: boolean;
  onAdd: (photo: PreparedPhoto) => void;
  onRemove: (index: number) => void;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const full = photos.length >= max;

  async function chosen(files: FileList | null, input: HTMLInputElement) {
    if (files === null || files.length === 0) return;
    setReading(true);
    try {
      for (const file of Array.from(files).slice(0, max - photos.length)) {
        const result = await preparePhoto(file);
        if (isPhotoRejection(result)) {
          toast.add({ type: 'error', title: 'That photograph could not be used', description: result.reason });
        } else {
          onAdd(result);
        }
      }
    } finally {
      setReading(false);
      // Reset so choosing the same file twice still fires a change event.
      input.value = '';
    }
  }

  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        {photos.map((photo, index) => (
          <span key={photo.previewUrl} className="relative size-16 shrink-0 border">
            <img src={photo.previewUrl} alt={`${label} ${String(index + 1)}`} className="size-full object-cover" />
            <Button
              variant="outline"
              size="icon-xs"
              aria-label={`Remove ${label.toLowerCase()} ${String(index + 1)}`}
              className="bg-background absolute -top-2 -right-2"
              disabled={disabled}
              onClick={() => {
                onRemove(index);
              }}
            >
              <XIcon />
            </Button>
          </span>
        ))}
        {/* eslint-disable-next-line no-restricted-syntax */}
        <input
          ref={cameraRef}
          type="file"
          accept={PHOTO_ACCEPTED_TYPES.join(',')}
          capture="environment"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            void chosen(event.target.files, event.currentTarget);
          }}
        />
        {/* eslint-disable-next-line no-restricted-syntax */}
        <input
          ref={galleryRef}
          type="file"
          accept={PHOTO_ACCEPTED_TYPES.join(',')}
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            void chosen(event.target.files, event.currentTarget);
          }}
        />
        <Button variant="outline" size="sm" disabled={disabled || reading || full} onClick={() => cameraRef.current?.click()}>
          {reading ? <Spinner data-icon="inline-start" /> : <CameraIcon data-icon="inline-start" />}
          Camera
        </Button>
        <Button variant="outline" size="sm" disabled={disabled || reading || full} onClick={() => galleryRef.current?.click()}>
          <ImagesIcon data-icon="inline-start" />
          Gallery
        </Button>
      </div>
      {error === null ? <FieldDescription>{hint}</FieldDescription> : <FieldError>{error}</FieldError>}
    </Field>
  );
}
