import { FileTextIcon, PlusIcon } from '@phosphor-icons/react';
import { Link, useNavigate } from 'react-router';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useEstimates } from '@/features/sales/use-estimates';
import { formatDate, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { SALES_DOCUMENT_STATUS_LABELS, PERMISSIONS } from '@vyuha/shared';

import type { Deal } from './types';

/**
 * REQ-U-06: a deal links to the sales documents raised against it. The
 * estimate is the first such document; sales orders and invoices join this
 * list as their slices land. Raising one from here carries the deal, its
 * company and its party into the estimate, so the link is made at creation
 * and never typed twice.
 */
export function DealDocuments({ deal }: { deal: Deal }) {
  const canViewSelf = usePermission(PERMISSIONS.SALES_DOCUMENT_VIEW_SELF);
  const canViewAll = usePermission(PERMISSIONS.SALES_DOCUMENT_VIEW_ALL);
  const canView = canViewSelf || canViewAll;
  const canCreate = usePermission(PERMISSIONS.SALES_DOCUMENT_CREATE);
  const navigate = useNavigate();
  const estimates = useEstimates({ page: 1, dealId: deal.id }, { enabled: canView });
  if (!canView) return null;
  const rows = estimates.data?.data ?? [];

  const params = new URLSearchParams({ deal: deal.id });
  if (deal.companyId !== null) params.set('company', deal.companyId);
  if (deal.partyId !== null) params.set('party', deal.partyId);

  return (
    <section aria-label="Documents" className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <FileTextIcon className="text-muted-foreground" />
          Documents
        </h3>
        {canCreate ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void navigate(`/sales/estimates/new?${params.toString()}`);
            }}
          >
            <PlusIcon data-icon="inline-start" />
            Estimate
          </Button>
        ) : null}
      </div>
      {estimates.isPending ? (
        <div role="status" aria-busy="true" aria-label="Loading documents">
          <Skeleton className="h-3 w-48" />
        </div>
      ) : null}
      {estimates.isSuccess && rows.length === 0 ? <p className="text-muted-foreground text-sm">No estimate raised against this deal yet.</p> : null}
      {rows.length > 0 ? (
        <ul className="divide-y border text-sm">
          {rows.map((estimate) => (
            <li key={estimate.id} className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-2">
              <Link to={`/sales/estimates/${estimate.id}`} className="font-medium tabular-nums underline-offset-4 hover:underline">
                Estimate {estimate.number}
              </Link>
              <span className="text-muted-foreground flex items-center gap-2 text-xs">
                <span className="tabular-nums">{formatDate(estimate.date)}</span>
                <Badge variant={estimate.status === 'ACCEPTED' ? 'default' : 'outline'}>{SALES_DOCUMENT_STATUS_LABELS[estimate.status]}</Badge>
                <span className="tabular-nums">{formatMoney(estimate.grandTotal)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
