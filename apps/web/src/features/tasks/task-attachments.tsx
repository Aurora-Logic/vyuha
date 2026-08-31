import { FilePdfIcon, ImageIcon, PaperclipIcon, TrashIcon } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import { PERMISSIONS } from '@vyuha/shared';

import { SectionHeading } from '@/components/shared/section-heading';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { apiRequest } from '@/lib/api/client';
import { formatDate } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import { useTaskAttachmentActions, useTaskAttachments, type TaskAttachment } from './use-tasks';

/**
 * REQ-V-12 (owner, 31 Aug 2026): what is attached to a task — a drawing, a
 * signed challan, a photograph of what arrived damaged.
 *
 * The deal panel's shape exactly, and deliberately so: the two surfaces do
 * the same job, and a person who has attached a quotation to a deal should
 * not have to learn a second control to attach a challan to a task.
 *
 * The list shows the name the person uploaded, never the storage key. A file
 * opens through a short-lived signed link minted at the moment of the click,
 * so nothing durable on this page is a URL to private bytes.
 */

const ACCEPT = '.pdf,.docx,.xlsx,.pptx,image/jpeg,image/png';

function sizeOf(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024)).toString()} KB`;
}

function AttachmentIcon({ mime }: { mime: string }) {
  if (mime.startsWith('image/')) return <ImageIcon className="text-muted-foreground" />;
  if (mime === 'application/pdf') return <FilePdfIcon className="text-muted-foreground" />;
  return <PaperclipIcon className="text-muted-foreground" />;
}

export function TaskAttachments({ taskId }: { taskId: string }) {
  const canManage = usePermission(PERMISSIONS.CRM_TASK_MANAGE);
  const query = useTaskAttachments(taskId);
  const { upload, remove } = useTaskAttachmentActions(taskId);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function open(attachment: TaskAttachment) {
    try {
      const link = await apiRequest<{ url: string }>(`/tasks/${taskId}/attachments/${attachment.id}/url`);
      window.open(link.url, '_blank', 'noopener');
    } catch (error) {
      toast.add({
        type: 'error',
        title: 'Could not open the file',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    }
  }

  async function add(file: File | undefined) {
    if (file === undefined) return;
    setBusy(true);
    try {
      await upload(file);
      toast.add({ type: 'success', title: `${file.name} attached` });
    } catch (error) {
      toast.add({
        type: 'error',
        title: 'Could not attach that file',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setBusy(false);
      // Cleared so the same file can be chosen twice running: a browser fires
      // no change event when the value has not changed.
      if (input.current !== null) input.current.value = '';
    }
  }

  const rows = query.data ?? [];

  return (
    <section className="flex flex-col gap-3">
      <SectionHeading
        title="Attachments"
        note="Drawings, challans and photographs. PDF, Word, Excel, PowerPoint or an image, up to 3 MB."
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
          aria-label="Attach a file to this task"
          onChange={(event) => {
            void add(event.target.files?.[0]);
          }}
        />
      ) : null}

      {query.isPending ? <Skeleton className="h-16" /> : null}
      {query.error ? (
        <QueryErrorAlert
          error={query.error}
          subject="attachments"
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : null}
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
                  onClick={() => {
                    void open(attachment);
                  }}
                >
                  <span className="truncate">{attachment.filename}</span>
                </Button>
                <span className="text-muted-foreground text-xs">
                  {sizeOf(attachment.bytes)} · {formatDate(attachment.uploadedAt)}
                  {attachment.uploadedByName === null ? '' : ` · ${attachment.uploadedByName}`}
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
          ))}
        </ul>
      ) : null}
    </section>
  );
}
