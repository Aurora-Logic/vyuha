import { useMemo, useState } from 'react';
import {
  ArrowsClockwiseIcon,
  DownloadSimpleIcon,
  LockKeyIcon,
  MagnifyingGlassIcon,
  PackageIcon,
} from '@phosphor-icons/react';
import { CATEGORIES, PERMISSIONS } from '@vyuha/shared';

import { ListSkeleton } from '@/components/shared/list-skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { formatDate, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import { useStockInterestReport, type StockInterestReportItem } from './use-interest';

/**
 * Granular Stock Interest and Exposure Report (D-22):
 * Displays detailed holding and transit advance payment interest calculations
 * across stock items on hand with layer-by-layer details.
 */
export function StockInterestPage() {
  const canView = usePermission(PERMISSIONS.INTEREST_VIEW);
  const [asOf, setAsOf] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [search, setSearch] = useState<string>('');
  const [onlyNonMoving, setOnlyNonMoving] = useState<boolean>(false);

  const queryParams = useMemo(
    () => ({
      asOf,
      category: selectedCategory !== 'all' ? selectedCategory : undefined,
      search: search.trim() ? search.trim() : undefined,
      isNonMoving: onlyNonMoving ? true : undefined,
    }),
    [asOf, selectedCategory, search, onlyNonMoving],
  );

  const query = useStockInterestReport(queryParams, { enabled: canView });

  if (!canView) {
    return (
      <>
        <PageHeader description="Granular stock interest and transit advance cost breakdown." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view interest reports</EmptyTitle>
            <EmptyDescription>
              This screen requires the interest_cost.view permission.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const data = query.data;
  const items = data?.items ?? [];

  function exportCsv() {
    if (!items.length) return;
    const headers = [
      'Stock Item',
      'Category',
      'Product Group',
      'Inward Date',
      'Quantity',
      'Unit',
      'Purchase Rate',
      'Closing Value',
      'Advance Amount',
      'Transit Days',
      'Transit Interest',
      'Shelf Age (Days)',
      'Free Holding Days',
      'Holding Interest',
      'Total Interest',
      'Is Non-Moving',
    ];

    const rows = items.map((item) => [
      `"${item.stockItemName.replace(/"/g, '""')}"`,
      `"${(item.category ?? '').replace(/"/g, '""')}"`,
      `"${(item.parentGroup ?? '').replace(/"/g, '""')}"`,
      item.inwardDate,
      item.quantity,
      item.unit,
      item.purchaseRate,
      item.closingValue,
      item.advanceAmount,
      item.advanceTransitDays,
      item.transitInterestAmount,
      item.shelfDays,
      item.holdingPeriodDays,
      item.holdingInterestAmount,
      item.totalInterestAmount,
      item.isNonMoving ? 'Yes' : 'No',
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `stock-interest-${asOf}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  const columns: RecordColumn<StockInterestReportItem>[] = [
    {
      key: 'item',
      header: 'Stock Item',
      cell: (row) => (
        <div className="flex flex-col">
          <span className="font-medium text-foreground">{row.stockItemName}</span>
          <span className="text-muted-foreground text-xs">
            {row.category ?? 'Other'} {row.parentGroup ? `· ${row.parentGroup}` : ''}
          </span>
        </div>
      ),
    },
    {
      key: 'inward',
      header: 'Inward Date',
      cell: (row) => formatDate(row.inwardDate),
    },
    {
      key: 'qty',
      header: 'Qty on Hand',
      cell: (row) => `${row.quantity} ${row.unit}`,
      numeric: true,
    },
    {
      key: 'rate',
      header: 'Purchase Rate',
      cell: (row) => formatMoney(row.purchaseRate),
      numeric: true,
    },
    {
      key: 'closingValue',
      header: 'Closing Value',
      cell: (row) => <span className="font-semibold">{formatMoney(row.closingValue)}</span>,
      numeric: true,
    },
    {
      key: 'transit',
      header: 'Transit Cost',
      cell: (row) =>
        row.advanceTransitDays > 0 ? (
          <div className="flex flex-col text-right">
            <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
              +{formatMoney(row.transitInterestAmount)}
            </span>
            <span className="text-muted-foreground text-[11px]">
              {row.advanceTransitDays} transit days
            </span>
          </div>
        ) : (
          <span className="text-muted-foreground text-xs">₹0.00</span>
        ),
      numeric: true,
    },
    {
      key: 'shelfDays',
      header: 'Shelf Age',
      cell: (row) => (
        <div className="flex flex-col text-right">
          <span className="font-medium">{row.shelfDays} days</span>
          <span className="text-muted-foreground text-[11px]">
            {row.shelfDays > row.holdingPeriodDays ? (
              <span className="text-destructive font-medium">
                +{row.shelfDays - row.holdingPeriodDays} days overdue
              </span>
            ) : (
              `${row.holdingPeriodDays - row.shelfDays} free days left`
            )}
          </span>
        </div>
      ),
      numeric: true,
    },
    {
      key: 'holdingInterest',
      header: 'Holding Interest',
      cell: (row) => (
        <span
          className={
            Number(row.holdingInterestAmount) > 0
              ? 'font-medium text-destructive'
              : 'text-muted-foreground'
          }
        >
          {formatMoney(row.holdingInterestAmount)}
        </span>
      ),
      numeric: true,
    },
    {
      key: 'totalInterest',
      header: 'Total Interest',
      cell: (row) => (
        <span className="font-bold text-foreground">
          {formatMoney(row.totalInterestAmount)}
        </span>
      ),
      numeric: true,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) =>
        row.isNonMoving ? (
          <Badge variant="destructive" className="text-xs">
            Non-moving
          </Badge>
        ) : (
          <Badge variant="secondary" className="text-xs">
            Active
          </Badge>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        description="Detailed stock exposure, transit advance payment cost, and holding interest accrued on unsold stock."
      />

      {/* Filter and Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border p-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Refresh"
            disabled={query.isFetching}
            onClick={() => {
              void query.refetch();
            }}
          >
            <ArrowsClockwiseIcon />
          </Button>

          <Field className="w-36">
            <FieldLabel htmlFor="report-as-of" className="sr-only">
              As of Date
            </FieldLabel>
            <Input
              id="report-as-of"
              type="date"
              value={asOf}
              onChange={(e) => {
                setAsOf(e.target.value);
              }}
            />
          </Field>

          <Field className="w-40">
            <Select
              value={selectedCategory}
              onValueChange={(val: string | null) => {
                if (val) setSelectedCategory(val);
              }}
            >
              <SelectTrigger id="filter-category" className="w-full">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">All Categories</SelectItem>
                  {CATEGORIES.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <div className="relative w-48 sm:w-64">
            <MagnifyingGlassIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input
              placeholder="Search items..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
              }}
              className="pl-8"
            />
          </div>

          <div className="flex items-center gap-2 pl-2">
            <Switch
              id="non-moving-toggle"
              checked={onlyNonMoving}
              onCheckedChange={setOnlyNonMoving}
            />
            <label htmlFor="non-moving-toggle" className="cursor-pointer text-xs font-medium">
              Only Non-moving
            </label>
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          disabled={!items.length || query.isPending}
          onClick={exportCsv}
        >
          <DownloadSimpleIcon data-icon="inline-start" />
          Export CSV
        </Button>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
              Total Stock Value
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <p className="text-xl font-bold tracking-tight">
              {data ? formatMoney(data.totalStockValue) : '—'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
              Funded Stock Value
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <p className="text-xl font-bold tracking-tight text-amber-600 dark:text-amber-400">
              {data ? formatMoney(data.fundedStockValue) : '—'}
            </p>
            <p className="text-muted-foreground text-[11px]">Age &gt; 90 days</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
              Transit Interest
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <p className="text-xl font-bold tracking-tight text-amber-600 dark:text-amber-400">
              {data ? formatMoney(data.totalTransitInterest) : '—'}
            </p>
            <p className="text-muted-foreground text-[11px]">On advance payment</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
              Holding Interest
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <p className="text-xl font-bold tracking-tight text-destructive">
              {data ? formatMoney(data.totalHoldingInterest) : '—'}
            </p>
            <p className="text-muted-foreground text-[11px]">Day 91 onwards</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
              Total Interest Cost
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <p className="text-xl font-bold tracking-tight text-destructive">
              {data ? formatMoney(data.totalAccumulatedInterest) : '—'}
            </p>
            <p className="text-muted-foreground text-[11px]">Transit + Holding</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
              Non-Moving Items
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <p className="text-xl font-bold tracking-tight text-foreground">
              {data ? data.nonMovingItemsCount : '—'}
            </p>
            <p className="text-muted-foreground text-[11px]">Zero outward movement</p>
          </CardContent>
        </Card>
      </div>

      {query.isPending ? <ListSkeleton rows={6} label="Calculating stock interest" /> : null}

      {query.isError ? (
        <QueryErrorAlert
          error={query.error}
          subject="stock interest report"
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : null}

      {query.isSuccess ? (
        <div className="flex flex-col gap-3">
          {items.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PackageIcon />
                </EmptyMedia>
                <EmptyTitle>No matching stock items</EmptyTitle>
                <EmptyDescription>
                  There are no unsold stock layers matching the selected criteria.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <RecordTable
              columns={columns}
              rows={items}
              rowKey={(row) => `${row.stockItemId}-${row.inwardDate}`}
              mobilePrimary={(row) => row.stockItemName}
              mobileStatus={(row) =>
                row.isNonMoving ? (
                  <Badge variant="destructive">Non-moving</Badge>
                ) : (
                  <Badge variant="secondary">Active</Badge>
                )
              }
              mobileSupporting={(row) =>
                `${row.quantity} ${row.unit} · Val: ${formatMoney(row.closingValue)} · Int: ${formatMoney(
                  row.totalInterestAmount,
                )}`
              }
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
