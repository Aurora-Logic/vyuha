import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface SectionHeadingProps {
  /** A glyph the section's subject already wears elsewhere (the flag, the streak), so the heading agrees with the rows. */
  icon?: ReactNode;
  title: string;
  /** One line saying what the section is for. Optional: some need no gloss. */
  note?: string;
  /** Synonym for note, matching other section components. */
  description?: string;
  /** Right-aligned control belonging to this section, not to the page. */
  action?: ReactNode;
  className?: string;
}

/**
 * The heading for a section inside a page (CLAUDE.md §3 rule 4).
 *
 * Four screens had each written their own copy of this — my leave, holidays,
 * profile and the pattern gallery — which is exactly the drift rule 4 exists
 * to stop: four files, one shape, no shared definition, and nothing to change
 * in one place when the shape moves.
 *
 * text-sm rather than the text-base each copy used. The page's own h1 lives in
 * the header breadcrumb at 12px, so a 16px section heading outranked the title
 * of the page it sat in — the document outline said h1 then h2 while the type
 * said the opposite. 14px is still unmistakably a heading against 12px body
 * text and no longer argues with the h1 above it.
 */
export function SectionHeading({ title, note, description, action, icon, className }: SectionHeadingProps) {
  const noteText = note ?? description;
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-x-4 gap-y-1', className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          {icon ? <span aria-hidden className="text-muted-foreground [&_svg]:size-4">{icon}</span> : null}
          {title}
        </h2>
        {noteText ? <p className="text-muted-foreground text-xs">{noteText}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}
