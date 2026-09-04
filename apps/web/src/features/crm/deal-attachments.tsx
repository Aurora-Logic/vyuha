import { PERMISSIONS } from '@vyuha/shared';

import { AttachmentPanel } from '@/components/shared/attachment-panel';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { usePermission } from '@/lib/session/permissions';

import { useDealAttachmentActions, useDealAttachments } from './use-deals';

/**
 * REQ-U-05 (owner, 31 Aug 2026): what is attached to a deal -- a quotation,
 * a drawing, a photograph from a site visit.
 *
 * The panel itself is `components/shared/attachment-panel`, shared with the
 * task sheet. This file is what is particular to a deal: which permission
 * lets you attach, which endpoint holds the files, and what to call them.
 */

const ACCEPT = '.pdf,.docx,.xlsx,.pptx,image/jpeg,image/png';

export function DealAttachments({ dealId }: { dealId: string }) {
  const canManage = usePermission(PERMISSIONS.CRM_DEAL_MANAGE);
  const query = useDealAttachments(dealId);
  const { upload, remove } = useDealAttachmentActions(dealId);

  return (
    <AttachmentPanel
      title="Attachments"
      note="Quotations, drawings and photographs. PDF, Word, Excel, PowerPoint or an image, up to 3 MB."
      accept={ACCEPT}
      basePath={`/crm/deals/${dealId}/attachments`}
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
      uploadLabel="Attach a file to this deal"
      onUpload={upload}
      onRemove={remove}
    />
  );
}
