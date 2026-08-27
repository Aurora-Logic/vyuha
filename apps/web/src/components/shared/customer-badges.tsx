import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * Two gradings that must never share a visual language (CFO brief P1): the
 * customer class (A+ to D, a person's judgment, a square wearing the
 * class's own token) and the payment grade (A to E, the system's reading
 * of behaviour, a circle in neutral ink). The letter always shows; colour
 * is never the only carrier. Shown side by side wherever a customer is
 * named, so a Class A+ with payment grade D is visible at a glance.
 */

const TOKEN_CLASSES: Record<string, string> = {
  'fresh-1': 'bg-[color-mix(in_oklab,var(--fresh-1)_22%,transparent)] border-[var(--fresh-1)]',
  'fresh-2': 'bg-[color-mix(in_oklab,var(--fresh-2)_22%,transparent)] border-[var(--fresh-2)]',
  'fresh-3': 'bg-[color-mix(in_oklab,var(--fresh-3)_22%,transparent)] border-[var(--fresh-3)]',
  'fresh-4': 'bg-[color-mix(in_oklab,var(--fresh-4)_22%,transparent)] border-[var(--fresh-4)]',
  'fresh-5': 'bg-[color-mix(in_oklab,var(--fresh-5)_22%,transparent)] border-[var(--fresh-5)]',
};

export function ClassBadge({ code, label, token, className }: { code: string | null; label?: string; token?: string; className?: string }) {
  const body = (
    <span
      className={cn(
        'inline-flex h-6 min-w-6 items-center justify-center rounded-sm border px-1 text-xs font-semibold tabular-nums',
        code === null ? 'text-muted-foreground border-dashed' : (TOKEN_CLASSES[token ?? ''] ?? 'bg-muted'),
        className,
      )}
      aria-label={code === null ? 'No customer class' : `Customer class ${code}${label ? `, ${label}` : ''}`}
    >
      {code ?? '–'}
    </span>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={body} />
      <TooltipContent>{code === null ? 'Customer class: not set' : `Customer class ${code}${label ? ` — ${label}` : ''}`}</TooltipContent>
    </Tooltip>
  );
}

export function GradeBadge({ grade, risk, className }: { grade: string | null; risk?: number; className?: string }) {
  const trouble = grade === 'D' || grade === 'E';
  const body = (
    <span
      className={cn(
        'inline-flex size-6 items-center justify-center rounded-full border text-xs font-medium tabular-nums',
        grade === null ? 'text-muted-foreground border-dashed' : trouble ? 'border-destructive text-destructive' : 'border-foreground/40',
        className,
      )}
      aria-label={grade === null ? 'No payment grade' : `Payment grade ${grade}`}
    >
      {grade ?? '–'}
    </span>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={body} />
      <TooltipContent>
        {grade === null ? 'Payment grade: not enough history' : `Payment grade ${grade}${risk === undefined ? '' : ` — risk ${String(risk)} of 100`}`}
      </TooltipContent>
    </Tooltip>
  );
}
