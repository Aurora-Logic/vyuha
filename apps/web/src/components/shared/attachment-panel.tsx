import {
  FilePdfIcon,
  ImageBrokenIcon,
  ImageIcon,
  PaperclipIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { SectionHeading } from '@/components/shared/section-heading';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { attachmentUrlOnce, useAttachmentUrl } from '@/components/shared/use-attachment-url';
import { formatDate } from '@/lib/format';

/**
 * What is attached to a record, with the pictures actually shown (owner,
 * 1 Sep 2026: "when we open any task or add, image preview shall be there").
 *
 * An image attachment used to be a paperclip and a filename, so seeing the
 * photograph of the damaged crate meant opening a browser tab and coming
 * back. Images now carry a thumbnail in the row and open full size in a
 * dialog, and a picture chosen for upload is on screen while it uploads
 * rather than after.
 *
 * One component for the deal panel and the task panel. They were two files
 * that differed only in their permission, their endpoint and three words of
 * copy, and their own comments said they were meant to stay identical -- two
 * copies is how "identical" quietly stops being true.
 *
 * Bytes are never a durable URL: a link is minted per file at the moment it
 * is needed and is cached for less than its own lifetime (NFR-09).
 */

export interface AttachmentRow {
  readonly id: string;
  readonly filename: string;
  readonly mime: string;
  readonly bytes: number;
  readonly uploadedAt: string;
  /** The deal panel does not carry one; the task panel does. */
  readonly uploadedByName?: string | null;
}

function isImage(mime: string): boolean {
  return mime.startsWith('image/');
}

function sizeOf(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024)).toString()} KB`;
}

function AttachmentIcon({ mime }: { readonly mime: string }) {
  if (isImage(mime)) return <ImageIcon className="text-muted-foreground" />;
  if (mime === 'application/pdf') return <FilePdfIcon className="text-muted-foreground" />;
  return <PaperclipIcon className="text-muted-foreground" />;
}

/** The 64px frame the punch feed already uses, so a thumbnail means one thing across the product. */
function Thumbnail({
  basePath,
  attachment,
  onOpen,
}: {
  readonly basePath: string;
  readonly attachment: AttachmentRow;
  readonly onOpen: () => void;
}) {
  const url = useAttachmentUrl(basePath, attachment.id, true);

  if (url.isPending) return <Skeleton className="size-16 shrink-0" aria-label="Loading the preview" />;
  if (url.isError) {
    return (
      <div
        className="bg-muted text-muted-foreground flex size-16 shrink-0 items-center justify-center border"
        aria-label={`No preview for ${attachment.filename}`}
      >
        <ImageBrokenIcon />
      </div>
    );
  }

  return (
    // Padding and the minimum width are cleared so the frame is the picture
    // rather than a control with a picture inside it. 64px already clears the
    // 44px touch floor.
    <Button
      variant="ghost"
      onClick={onOpen}
      aria-label={`View ${attachment.filename} full size`}
      className="size-16 shrink-0 overflow-hidden border p-0 pointer-coarse:min-w-16"
    >
      <img src={url.data} alt="" className="size-16 object-cover" />
    </Button>
  );
}

function FullImage({ basePath, attachment }: { readonly basePath: string; readonly attachment: AttachmentRow }) {
  const url = useAttachmentUrl(basePath, attachment.id, true);

  if (url.isPending) return <Skeleton className="aspect-video w-full" aria-label="Loading the image" />;
  if (url.isError) {
    return (
      <p className="text-muted-foreground text-sm">
        The image could not be loaded. It may have passed its retention window, or you may not have
        permission to view it.
      </p>
    );
  }
  return (
    <img
      src={url.data}
      alt={attachment.filename}
      className="bg-muted max-h-[70vh] w-full border object-contain"
    />
  );
}

/** The picture that is on its way up, shown from the local file rather than a round trip. */
function UploadingPreview({ file }: { readonly file: File }) {
  // Derived, not stated: setting this from an effect would render once without
  // the picture and again with it, which is the flicker the preview exists to
  // avoid -- and the lint rule against cascading renders is right about it.
  const src = useMemo(() => (isImage(file.type) ? URL.createObjectURL(file) : null), [file]);

  // Revoked on the way out, or every pick leaks a blob for the life of the tab.
  useEffect(() => {
    if (src === null) return;
    return () => {
      URL.revokeObjectURL(src);
    };
  }, [src]);

  if (src === null) return null;
  return (
    <div className="flex items-center gap-3">
      <span className="size-16 shrink-0 overflow-hidden border">
        <img src={src} alt="" className="size-16 object-cover" />
      </span>
      <span className="text-muted-foreground text-sm">Uploading {file.name}</span>
    </div>
  );
}

export function AttachmentPanel({
  title,
  note,
  accept,
  basePath,
  attachments,
  isPending,
  errorSlot,
  canManage,
  uploadLabel,
  onUpload,
  onRemove,
}: {
  readonly title: string;
  readonly note: string;
  readonly accept: string;
  /** Where a file's link is minted, e.g. `/tasks/<id>/attachments`. */
  readonly basePath: string;
  readonly attachments: readonly AttachmentRow[];
  readonly isPending: boolean;
  /** The caller's own error alert; `components/shared` may not reach into a feature for one. */
  readonly errorSlot?: ReactNode;
  readonly canManage: boolean;
  readonly uploadLabel: string;
  readonly onUpload: (file: File) => Promise<unknown>;
  readonly onRemove: (attachmentId: string) => Promise<unknown>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<File | null>(null);
  const [viewing, setViewing] = useState<AttachmentRow | null>(null);

  async function add(file: File | undefined) {
    if (file === undefined) return;
    setUploading(file);
    try {
      await onUpload(file);
      toast.add({ type: 'success', title: `${file.name} attached` });
    } catch (error) {
      toast.add({
        type: 'error',
        title: 'Could not attach that file',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setUploading(null);
      // Cleared so the same file can be chosen twice running: a browser fires
      // no change event when the value has not changed.
      if (input.current !== null) input.current.value = '';
    }
  }

  async function openInTab(attachment: AttachmentRow) {
    try {
      window.open(await attachmentUrlOnce(basePath, attachment.id), '_blank', 'noopener');
    } catch (error) {
      toast.add({
        type: 'error',
        title: 'Could not open the file',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    }
  }

  return (
    <section data-guide="screen.attachments" className="flex flex-col gap-3">
      <SectionHeading title={title} note={note} />

      {/* shadcn's own answer for a file field is its Input with type="file"
          (registry example `input-file`), so that is what this uses rather
          than a hidden control behind a button. */}
      {canManage ? (
        <Input
          ref={input}
          type="file"
          accept={accept}
          disabled={uploading !== null}
          aria-label={uploadLabel}
          onChange={(event) => {
            void add(event.target.files?.[0]);
          }}
        />
      ) : null}

      {uploading === null ? null : <UploadingPreview file={uploading} />}

      {isPending ? <Skeleton className="h-16" /> : null}
      {errorSlot}
      {!isPending && errorSlot === undefined && attachments.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing attached yet.</p>
      ) : null}

      {attachments.length > 0 ? (
        <ul className="flex flex-col divide-y">
          {attachments.map((attachment) => {
            const picture = isImage(attachment.mime);
            return (
              <li key={attachment.id} className="flex min-h-11 items-center gap-3 py-2">
                {picture ? (
                  <Thumbnail
                    basePath={basePath}
                    attachment={attachment}
                    onOpen={() => {
                      setViewing(attachment);
                    }}
                  />
                ) : (
                  <AttachmentIcon mime={attachment.mime} />
                )}
                <span className="flex min-w-0 flex-col">
                  <Button
                    variant="link"
                    className="h-auto justify-start p-0 text-left"
                    onClick={() => {
                      // A picture opens where the reader already is. Anything
                      // else is a document the browser is better at than we are.
                      if (picture) setViewing(attachment);
                      else void openInTab(attachment);
                    }}
                  >
                    <span className="truncate">{attachment.filename}</span>
                  </Button>
                  <span className="text-muted-foreground text-xs">
                    {sizeOf(attachment.bytes)} · {formatDate(attachment.uploadedAt)}
                    {attachment.uploadedByName == null ? '' : ` · ${attachment.uploadedByName}`}
                  </span>
                </span>
                {canManage ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="ml-auto"
                    aria-label={`Remove ${attachment.filename}`}
                    onClick={() => {
                      void onRemove(attachment.id).catch((error: unknown) => {
                        toast.add({
                          type: 'error',
                          title: 'Could not remove it',
                          description: error instanceof Error ? error.message : 'Try again.',
                        });
                      });
                    }}
                  >
                    <TrashIcon />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* A Dialog, not a second Sheet: both panels already live inside one,
          and a sheet sliding out of a sheet loses where the picture came from.
          The same choice the punch feed made. */}
      <Dialog
        open={viewing !== null}
        onOpenChange={(open) => {
          if (!open) setViewing(null);
        }}
      >
        <DialogContent className="block max-w-2xl min-w-0">
          {viewing ? (
            <>
              <DialogTitle className="truncate">{viewing.filename}</DialogTitle>
              <DialogDescription>
                {sizeOf(viewing.bytes)} · {formatDate(viewing.uploadedAt)}
                {viewing.uploadedByName == null ? '' : ` · ${viewing.uploadedByName}`}
              </DialogDescription>
              <div className="mt-3">
                <FullImage basePath={basePath} attachment={viewing} />
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
