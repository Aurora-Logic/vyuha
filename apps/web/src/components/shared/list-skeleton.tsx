import { Skeleton } from '@/components/ui/skeleton';

interface ListSkeletonProps {
  /** How many placeholder rows: about as many as the loaded list will show. */
  rows?: number;
  /** What is loading, as the status region's name: "Loading roles". */
  label?: string;
  /**
   * A heading line above the rows, for a list that sits under a section
   * heading once it has loaded, so the placeholder occupies the same height.
   */
  heading?: boolean;
}

/**
 * The loading state of a register (CLAUDE.md §3 rule 4).
 *
 * Nine screens each declared their own copy of this shape, differing only in
 * cell widths a few rem apart and the row count -- the drift rule 4 exists to
 * stop. One row shape here; only the count and the announced label vary,
 * because those are the two things a reader could notice.
 *
 * The rows mirror `RecordTable`'s: one bordered stack of hairline-divided lines
 * at the same 36px minimum, so the table replacing it does not jump. Two cells
 * hide at the breakpoints the table drops its secondary columns at.
 */
export function ListSkeleton({ rows = 5, label = 'Loading', heading = false }: ListSkeletonProps) {
  const lines = Array.from({ length: rows }, (_, index) => (
    <div
      key={index}
      aria-hidden
      data-slot="list-skeleton-row"
      className="flex min-h-9 items-center gap-4 border-b px-3 py-2.5 last:border-b-0"
    >
      <Skeleton className="h-3 w-32 shrink-0" />
      <Skeleton className="hidden h-3 w-16 shrink-0 sm:block" />
      <Skeleton className="hidden h-3 w-28 shrink-0 xl:block" />
      <Skeleton className="ml-auto h-4 w-16 shrink-0" />
    </div>
  ));

  if (!heading) {
    return (
      <div role="status" aria-busy="true" aria-label={label} data-slot="list-skeleton" className="border">
        {lines}
      </div>
    );
  }

  return (
    <div role="status" aria-busy="true" aria-label={label} data-slot="list-skeleton" className="flex flex-col gap-3">
      <Skeleton aria-hidden data-slot="list-skeleton-heading" className="h-4 w-40" />
      <div className="border">{lines}</div>
    </div>
  );
}
