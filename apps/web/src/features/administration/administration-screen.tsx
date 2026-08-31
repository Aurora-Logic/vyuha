import { Link } from 'react-router';
import { CaretRightIcon } from '@phosphor-icons/react';

import { PageHeader } from '@/components/shared/page-header';
import { SectionHeading } from '@/components/shared/section-heading';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { adminRailFor } from '@/lib/nav';
import { usePermissions } from '@/lib/session/permissions';

/**
 * The workspace's own screens, in one place (REQ-O-02).
 *
 * These used to sit in the attendance sidebar, which was the wrong shelf:
 * there is one audit log for the whole system, one recycle bin and one set of
 * roles, and CRM will not be getting copies of them.
 *
 * A directory, not a settings surface of its own: each destination already
 * has a screen, and the rail beside this one (AdminShell) lists the same
 * entries. The directory earns its place on a phone, where there is no rail
 * and this is what the bottom bar's Administration tab lands on, and it says
 * one line more than the rail can -- what each screen decides. Shaped like
 * Supabase's add-ons list: one bordered list per group, a row per screen.
 */
export function AdministrationScreen() {
  const granted = usePermissions();
  const groups = adminRailFor(granted);

  return (
    <>
      {/* No title: the breadcrumb in the app header states the page's name
          once, and PageHeader carries only what belongs to the screen. */}
      <PageHeader description="Settings, people and records that belong to the whole workspace rather than to one module." />

      {groups.length === 0 ? (
        /*
         * Reachable: the route is not permission-gated, because gating it would
         * mean a person following a link from an older bookmark gets "not
         * found" rather than an explanation. Every destination inside is gated
         * individually, server-side as well.
         */
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CaretRightIcon />
            </EmptyMedia>
            <EmptyTitle>Nothing here for your account</EmptyTitle>
            <EmptyDescription>
              These screens need administration permissions. Ask an administrator if you need one of
              them.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-8">
          {groups.map((group) => (
            <section key={group.label} aria-label={group.label} className="flex flex-col gap-3">
              <SectionHeading title={group.label} />
              <ItemGroup className="gap-0 divide-y border">
                {group.items.map((item) => (
                  <Item
                    key={item.to}
                    size="sm"
                    className="min-h-11 border-0"
                    render={<Link to={item.to} />}
                  >
                    <ItemMedia variant="icon">
                      <item.icon />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{item.label}</ItemTitle>
                      {item.blurb ? <ItemDescription>{item.blurb}</ItemDescription> : null}
                    </ItemContent>
                    <ItemActions>
                      <CaretRightIcon aria-hidden className="text-muted-foreground size-4" />
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
