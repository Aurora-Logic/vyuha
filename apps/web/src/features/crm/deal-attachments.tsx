import { useRef, useState } from 'react';
import { FilePdfIcon, ImageIcon, PaperclipIcon, TrashIcon } from '@phosphor-icons/react';
import { PERMISSIONS } from '@vyuha/shared';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { SectionHeading } from '@/components/shared/section-heading';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { apiRequest } from '@/lib/api/client';
import { formatDate } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import { useDealAttachmentActions, useDealAttachments, type DealAttachment } from './use-deals';

/**
 * REQ-U-05 (owner, 31 Aug 2026): what is attached to a deal -- a quotation,
 * a drawing, a photograph from a site visit.
 *
 * The list shows the name the person uploaded, never the storage key. A file
 * is opened through a short-lived signed link minted at the moment of the
 * click, so nothing durable in this page is a URL to private bytes.
 */

const ACCEPT = '.pdf,.docx,.xlsx,.pptx,image/jpeg,image/png';

function sizeOf(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024)).toString()} KB`;
}

function AttachmentIcon({ mime }: { mime: string }) {
  if (mime.startsWith('image/')) return <ImageIcon className="text-muted-foreground" />;
  if (mime === 'application/pdf') return <FilePdfIcon className="text-muted-foreground" />;
  return <PaperclipIcon className="text-muted-foreground" />;
}

export function DealAttachments({ dealId }: { dealId: string }) {
  const canManage = usePermission(PERMISSIONS.CRM_DEAL_MANAGE);
  const query = useDealAttachments(dealId);
  const { upload, remove } = useDealAttachmentActions(dealId);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function open(attachment: DealAttachment) {
    try {
      const link = await apiRequest<{ url: string }>(`/crm/deals/${dealId}/attachments/${attachment.id}/url`);
      window.open(link.url, '_blank', 'noopener');
    } catch (error) {
      toast.add({ type: 'error', title: 'Could not open the file', description: error instanceof Error ? error.message : 'Try again.' });
    }
  }

  async function add(file: File | undefined) {
    if (file === undefined) return;
    setBusy(true);
    try {
      await upload(file);
      toast.add({ type: 'success', title: `${file.name} attached` });
    } catch (error) {
      toast.add({ type: 'error', title: 'Could not attach that file', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setBusy(false);
      if (input.current !== null) input.current.value = '';
    }
  }

  const rows = query.data ?? [];

  return (
    <section className="flex flex-col gap-3">
      <SectionHeading
        title="Attachments"
        note="Quotations, drawings and site photographs. PDF, Word, Excel, PowerPoint or an image, up to 3 MB."
      />

      {/* shadcn's own answer for a file field is its Input with type="file"
          (registry example `input-file`), so that is what this uses rather
          than a hidden control behind a button. */}
      {canManage ? (
        <Input
          ref={input}
          type="file"
          accept={ACCEPT}
          disabled={busy}
          aria-label="Attach a file to this deal"
          onChange={(event) => { void add(event.target.files?.[0]); }}
        />
      ) : null}

      {query.isPending ? <Skeleton className="h-16" /> : null}
      {query.error ? <QueryErrorAlert error={query.error} subject="attachments" onRetry={() => void query.refetch()} /> : null}
      {query.isSuccess && rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing attached yet.</p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="flex flex-col divide-y">
          {rows.map((attachment) => (
            <li key={attachment.id} className="flex min-h-11 items-center gap-3 py-2">
              <AttachmentIcon mime={attachment.mime} />
              <span className="flex min-w-0 flex-col">
                <Button
                  variant="link"
                  className="h-auto justify-start p-0 text-left"
                  onClick={() => { void open(attachment); }}
                >
                  <span className="truncate">{attachment.filename}</span>
                </Button>
                <span className="text-muted-foreground text-xs">
                  {sizeOf(attachment.bytes)} · {formatDate(attachment.uploadedAt)}
                </span>
              </span>
              {canManage ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto"
                  aria-label={`Remove ${attachment.filename}`}
                  onClick={() => {
                    void remove(attachment.id).catch((error: unknown) => {
                      toast.add({ type: 'error', title: 'Could not remove it', description: error instanceof Error ? error.message : 'Try again.' });
                    });
                  }}
                >
                  <TrashIcon />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
