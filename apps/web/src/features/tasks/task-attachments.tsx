import { PERMISSIONS } from '@vyuha/shared';

import { AttachmentPanel } from '@/components/shared/attachment-panel';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { usePermission } from '@/lib/session/permissions';

import { useTaskAttachmentActions, useTaskAttachments } from './use-tasks';

/**
 * REQ-V-12 (owner, 31 Aug 2026): what is attached to a task -- a drawing, a
 * signed challan, a photograph of what arrived damaged.
 *
 * The panel itself is `components/shared/attachment-panel`, shared with the
 * deal sheet, so a person who has attached a quotation to a deal meets the
 * same control attaching a challan to a task -- and it stays the same control
 * because it is one, not because two files agree today.
 */

const ACCEPT = '.pdf,.docx,.xlsx,.pptx,image/jpeg,image/png';

export function TaskAttachments({ taskId }: { taskId: string }) {
  const canManage = usePermission(PERMISSIONS.CRM_TASK_MANAGE);
  const query = useTaskAttachments(taskId);
  const { upload, remove } = useTaskAttachmentActions(taskId);

  return (
    <AttachmentPanel
      title="Attachments"
      note="Drawings, challans and photographs. PDF, Word, Excel, PowerPoint or an image, up to 3 MB."
      accept={ACCEPT}
      basePath={`/tasks/${taskId}/attachments`}
      attachments={query.data ?? []}
      isPending={query.isPending}
      {...(query.error
        ? {
            errorSlot: (
              <QueryErrorAlert
                error={query.error}
                subject="attachments"
                onRetry={() => {
                  void query.refetch();
                }}
              />
            ),
          }
        : {})}
      canManage={canManage}
      uploadLabel="Attach a file to this task"
      onUpload={upload}
      onRemove={remove}
    />
  );
}
