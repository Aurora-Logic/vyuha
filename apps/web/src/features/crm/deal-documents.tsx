import { FileTextIcon, PlusIcon } from '@phosphor-icons/react';
import { Link, useNavigate } from 'react-router';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useEstimates, useSalesOrders } from '@/features/sales/use-estimates';
import { useInvoices } from '@/features/sales/use-invoices';
import { formatDate, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { SALES_DOCUMENT_STATUS_LABELS, PERMISSIONS } from '@vyuha/shared';

import type { Deal } from './types';

/**
 * REQ-U-06 and REQ-U-12: every document raised against a deal, and the two
 * buttons that raise the next one.
 *
 * All three kinds, not just estimates. A deal that had been ordered and
 * invoiced showed neither, so the screen that exists to answer "where has
 * this got to" answered only the first third of it.
 *
 * Raising carries the deal, its company and its party into the new document,
 * so the link is made at creation and never typed twice — and an order
 * raised here is why a deal can be invoiced at all.
 */

interface DocumentRow {
  readonly id: string;
  readonly number: string;
  readonly date: string;
  readonly status: string;
  readonly grandTotal: string;
  readonly kind: 'Estimate' | 'Sales order' | 'Invoice';
  readonly href: string;
}

export function DealDocuments({ deal }: { deal: Deal }) {
  const canViewSelf = usePermission(PERMISSIONS.SALES_DOCUMENT_VIEW_SELF);
  const canViewAll = usePermission(PERMISSIONS.SALES_DOCUMENT_VIEW_ALL);
  const canView = canViewSelf || canViewAll;
  const canCreate = usePermission(PERMISSIONS.SALES_DOCUMENT_CREATE);
  const navigate = useNavigate();

  const estimates = useEstimates({ page: 1, dealId: deal.id }, { enabled: canView });
  const orders = useSalesOrders({ page: 1, dealId: deal.id }, { enabled: canView });
  const invoices = useInvoices({ page: 1, dealId: deal.id }, { enabled: canView });

  if (!canView) return null;

  const rows: DocumentRow[] = [
    ...(estimates.data?.data ?? []).map((row) => ({ ...row, kind: 'Estimate' as const, href: `/sales/estimates/${row.id}` })),
    ...(orders.data?.data ?? []).map((row) => ({ ...row, kind: 'Sales order' as const, href: `/sales/orders/${row.id}` })),
    ...(invoices.data?.data ?? []).map((row) => ({ ...row, kind: 'Invoice' as const, href: `/sales/invoices/${row.id}` })),
    // Newest first across all three: the reader is asking what happened
    // last, not which kind of paper it was on.
  ].sort((a, b) => (a.date === b.date ? a.number.localeCompare(b.number) : b.date.localeCompare(a.date)));

  const pending = estimates.isPending || orders.isPending || invoices.isPending;
  const settled = estimates.isSuccess && orders.isSuccess && invoices.isSuccess;

  const params = new URLSearchParams({ deal: deal.id });
  if (deal.companyId !== null) params.set('company', deal.companyId);
  if (deal.partyId !== null) params.set('party', deal.partyId);
  const query = params.toString();

  return (
    <section aria-label="Documents" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <FileTextIcon className="text-muted-foreground" />
          Documents
        </h3>
        {canCreate ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void navigate(`/sales/estimates/new?${query}`);
              }}
            >
              <PlusIcon data-icon="inline-start" />
              Estimate
            </Button>
            {/* The order is where items and rates are chosen, and the one
                place that computes them. A deal carries no lines of its own
                (owner, 31 Aug 2026). */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void navigate(`/sales/orders/new?${query}`);
              }}
            >
              <PlusIcon data-icon="inline-start" />
              Sales order
            </Button>
          </div>
        ) : null}
      </div>

      {pending ? (
        <div role="status" aria-busy="true" aria-label="Loading documents">
          <Skeleton className="h-3 w-48" />
        </div>
      ) : null}

      {settled && rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing raised against this deal yet.</p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="divide-y border text-sm">
          {rows.map((row) => (
            <li key={`${row.kind}-${row.id}`} className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-2">
              <Link to={row.href} className="font-medium tabular-nums underline-offset-4 hover:underline">
                {row.kind} {row.number}
              </Link>
              <span className="text-muted-foreground flex items-center gap-2 text-xs">
                <span className="tabular-nums">{formatDate(row.date)}</span>
                <Badge variant={row.status === 'ACCEPTED' || row.status === 'CONFIRMED' ? 'default' : 'outline'}>
                  {SALES_DOCUMENT_STATUS_LABELS[row.status as keyof typeof SALES_DOCUMENT_STATUS_LABELS] ?? row.status}
                </Badge>
                <span className="tabular-nums">{formatMoney(row.grandTotal)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
