import { Suspense, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { CaretUpDownIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { activeRailItem, adminRailFor, type NavGroup, type NavItem } from '@/lib/nav';
import { usePermissions } from '@/lib/session/permissions';
import { cn } from '@/lib/utils';

/**
 * The administration shell (owner, 27 Aug 2026: "redesign the administration
 * and settings part for layouting from Supabase"). Supabase's settings area
 * is a narrow secondary rail -- eyebrow-grouped, text only, the open page
 * quietly filled -- beside a content column of sections. Every workspace
 * screen renders inside it, so leaving Settings for Roles does not mean going
 * back to a directory first: the rail stays put and the column changes.
 *
 * Below `lg` there is no room for a second column. The rail becomes one row
 * naming where the reader is and opens the same groups as a bottom sheet: a
 * menu of twenty rows belongs at the thumb, not in a popover at the top
 * corner. The directory at /administration remains the index a phone lands
 * on from the bottom bar.
 */
export function AdminShell() {
  const granted = usePermissions();
  const location = useLocation();
  const groups = adminRailFor(granted);
  const active = activeRailItem(groups, location.pathname, location.search);

  if (groups.length === 0) return <Outlet />;

  return (
    <div className="flex min-w-0 flex-col gap-6 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start lg:gap-x-10">
      <Rail groups={groups} active={active} />
      <RailSheet groups={groups} active={active} />
      <div className="flex min-w-0 flex-col gap-6">
        {/* The page's chunk arrives inside the column, so the rail is already
            there while it does; suspending the whole shell would blank the
            rail on every first visit to a screen. */}
        <Suspense fallback={<ColumnFallback />}>
          <Outlet />
        </Suspense>
      </div>
    </div>
  );
}

function Rail({ groups, active }: { groups: NavGroup[]; active: NavItem | undefined }) {
  // top-20 = the sticky 3.5rem app header plus the page's 1.5rem inset, so
  // the rail parks under the header rather than sliding beneath it.
  return (
    <nav aria-label="Administration" className="hidden lg:sticky lg:top-20 lg:flex lg:flex-col lg:gap-6 lg:self-start">
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-1">
          <p className="text-muted-foreground px-2 text-[11px] font-medium tracking-wider uppercase">{group.label}</p>
          <ul className="flex flex-col">
            {group.items.map((item) => {
              const current = item === active;
              return (
                <li key={item.to}>
                  {/* Link, not NavLink: NavLink decides "active" by pathname,
                      which would light every settings page at once. The rail
                      knows which one is open (activeRailItem) and says so. */}
                  <Link
                    to={item.to}
                    aria-current={current ? 'page' : undefined}
                    className={cn(
                      'focus-visible:ring-ring flex h-8 min-w-0 items-center px-2 text-sm outline-none transition-colors duration-100 focus-visible:ring-2',
                      current
                        ? 'bg-muted text-foreground font-medium'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )}
                  >
                    <span className="truncate">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function RailSheet({ groups, active }: { groups: NavGroup[]; active: NavItem | undefined }) {
  const [open, setOpen] = useState(false);
  const groupLabel = groups.find((group) => group.items.some((item) => item === active))?.label;

  // Choosing a row closes the sheet from the row's click: a keyboard Enter on
  // a link fires click as well, so a tap and a keypress arrive at the same
  // place, and the sheet gets its exit rather than being torn down mid-way.
  const close = () => {
    setOpen(false);
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={<Button variant="outline" className="w-full justify-between lg:hidden" aria-label="Administration sections" />}
      >
        <span className="min-w-0 truncate">
          {active ? (
            <>
              <span className="text-muted-foreground">{groupLabel} / </span>
              {active.label}
            </>
          ) : (
            'Administration'
          )}
        </span>
        <CaretUpDownIcon data-icon="inline-end" />
      </SheetTrigger>
      <SheetContent side="bottom" className="max-h-[85svh]">
        <SheetHeader>
          <SheetTitle>Administration</SheetTitle>
          <SheetDescription>Settings and the workspace's own screens.</SheetDescription>
        </SheetHeader>
        {/* min-h-0 is what lets this scroll instead of pushing the header off
            the sheet: a flex child otherwise refuses to be shorter than its
            content. */}
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4">
          {groups.map((group) => (
            <div key={group.label} className="flex flex-col gap-1.5">
              <p className="text-muted-foreground px-1 text-[11px] font-medium tracking-wider uppercase">{group.label}</p>
              <ItemGroup className="gap-0 divide-y border">
                {group.items.map((item) => {
                  const current = item === active;
                  return (
                    <Item
                      key={item.to}
                      size="sm"
                      variant={current ? 'muted' : 'default'}
                      className="min-h-11 border-0"
                      render={<Link to={item.to} aria-current={current ? 'page' : undefined} onClick={close} />}
                    >
                      <ItemMedia variant="icon">
                        <item.icon />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{item.label}</ItemTitle>
                        {item.blurb ? <ItemDescription>{item.blurb}</ItemDescription> : null}
                      </ItemContent>
                    </Item>
                  );
                })}
              </ItemGroup>
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ColumnFallback() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" className="flex flex-col gap-6">
      <Skeleton className="h-4 w-2/3 max-w-md" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  );
}
