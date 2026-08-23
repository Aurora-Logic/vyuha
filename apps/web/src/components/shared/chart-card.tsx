import type { ReactNode } from 'react';

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * One question, one picture, one sentence.
 *
 * This is not `ChartPanel` under a new name. That was a bespoke bordered
 * surface with its own caption and note markup; this is shadcn's Card parts
 * composed and nothing else, which is what the reports dashboard already drew
 * and what every chart surface in the product now shares. A chart sits in a
 * Card, on the page, and the sentence its series supports sits under it.
 *
 * Four screens were each about to grow their own copy of that composition.
 */
export function ChartCard({
  title,
  description,
  icon,
  action,
  insight,
  footnote,
  pending,
  empty,
  emptyNote,
  wide,
  children,
}: {
  title: string;
  description?: string;
  /** The glyph the card's subject wears elsewhere, so the title agrees with the rows. */
  icon?: ReactNode;
  action?: ReactNode;
  /** The sentence the series supports, or null when the data does not support one. */
  insight?: string | null;
  footnote?: ReactNode;
  pending?: boolean;
  empty?: boolean;
  emptyNote?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <Card className={wide === true ? 'lg:col-span-2' : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 [&_svg]:size-4">
          {icon === undefined ? null : (
            <span aria-hidden className="text-muted-foreground">
              {icon}
            </span>
          )}
          {title}
        </CardTitle>
        {description === undefined ? null : <CardDescription>{description}</CardDescription>}
        {action}
      </CardHeader>
      {/*
        Never `flex` on this element. ChartContainer measures itself through a
        Recharts ResponsiveContainer, and a flex child with no basis resolves
        to zero width -- four charts once rendered as empty cards with a
        correct header and footer around nothing. Centre with `mx-auto` on the
        container instead.
      */}
      <CardContent>
        {pending === true ? <Skeleton className="aspect-video w-full" /> : null}
        {pending !== true && empty === true ? (
          <p className="text-muted-foreground py-8 text-sm">
            {emptyNote ?? 'Nothing in this period.'}
          </p>
        ) : null}
        {pending !== true && empty !== true ? children : null}
      </CardContent>
      {/*
        `leading-snug` below, not `leading-none`. These are sentences, not the
        three-word labels shadcn's example footers carry, and at 360px they
        wrap -- at line-height 1 the second line sits on top of the first.
      */}
      {insight == null && footnote === undefined ? null : (
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          {insight == null ? null : <p className="leading-snug font-medium text-pretty">{insight}</p>}
          {footnote === undefined ? null : (
            <div className="text-muted-foreground leading-snug text-pretty">{footnote}</div>
          )}
        </CardFooter>
      )}
    </Card>
  );
}
