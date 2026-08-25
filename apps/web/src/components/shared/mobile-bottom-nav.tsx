import { useMemo, useState } from 'react';
import {
  ArrowCounterClockwiseIcon,
  DotsThreeIcon,
  SlidersHorizontalIcon,
  XIcon,
} from '@phosphor-icons/react';
import { NavLink, useLocation, useNavigate } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { Button } from '@/components/ui/button';
import { Item, ItemContent, ItemGroup, ItemTitle } from '@/components/ui/item';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { ADMIN_GROUPS, MODULES, TOP_BAR_ITEMS, findModuleForPath, moduleVisibleFor, type NavItem } from '@/lib/nav';
import { BOTTOM_NAV_SLOTS, useNavPreferencesStore } from '@/lib/nav-preferences-store';
import { usePermissions } from '@/lib/session/permissions';
import { cn } from '@/lib/utils';

/**
 * The phone's primary navigation (mobile-first, PRD §6.5).
 *
 * A sidebar behind a hamburger is a desktop pattern wearing a phone costume:
 * it puts every destination two taps away and none of them in reach of a
 * thumb. A bottom bar puts the four things this person actually does where
 * their thumb already is, and everything else one tap away under More.
 *
 * Which four is a preference rather than a guess. A shop-floor employee opens
 * Punch and nothing else; HR lives in Approvals and Reports. Both are the same
 * role in some deployments, so the bar is chosen per person and per device.
 *
 * This is an addition to the PRD §6.1 navigation model, which describes only
 * the sidebar. Recorded as P0-8.
 */
export function MobileBottomNav() {
  const granted = usePermissions();
  const location = useLocation();
  const navigate = useNavigate();
  const chosen = useNavPreferencesStore((s) => s.bottomNavRoutes);

  const [moreOpen, setMoreOpen] = useState(false);
  const [customiseOpen, setCustomiseOpen] = useState(false);

  const module = findModuleForPath(location.pathname);

  const permits = (item: NavItem) => !item.permission || granted.has(item.permission);
  const moduleItems = useMemo(
    () => module.groups.flatMap((group) => group.items).filter(permits),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- permits closes over granted, which is the real dependency
    [module, granted],
  );
  const visibleModules = useMemo(() => MODULES.filter((m) => moduleVisibleFor(m, granted)), [granted]);
  const elsewhere = useMemo(() => {
    // Administration and the inbox sit beside the modules, not inside one;
    // one entry per pathname, however many doors lead to it.
    const seen = new Set(moduleItems.map((item) => item.to.split('?')[0]));
    return [...TOP_BAR_ITEMS, ...ADMIN_GROUPS.flatMap((group) => group.items)].filter((item) => {
      const pathname = item.to.split('?')[0] ?? item.to;
      if (seen.has(pathname) || !permits(item)) return false;
      seen.add(pathname);
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- permits closes over granted
  }, [moduleItems, granted]);

  // D-20: the picker spans everything this person can reach -- every module's
  // destinations plus the administration and inbox doors -- one entry per
  // pathname, however many doors lead to it.
  const sections = useMemo(() => {
    const seen = new Set<string>();
    const claim = (item: NavItem) => {
      const pathname = item.to.split('?')[0] ?? item.to;
      if (seen.has(pathname) || !permits(item)) return false;
      seen.add(pathname);
      return true;
    };
    const ofModules = visibleModules
      .map((m) => ({ label: m.label, items: m.groups.flatMap((g) => g.items).filter(claim) }))
      .filter((section) => section.items.length > 0);
    const admin = [...TOP_BAR_ITEMS, ...ADMIN_GROUPS.flatMap((g) => g.items)].filter(claim);
    return admin.length > 0 ? [...ofModules, { label: 'Administration and inbox', items: admin }] : ofModules;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- claim closes over granted via permits
  }, [visibleModules, granted]);
  const allDestinations = useMemo(() => sections.flatMap((section) => section.items), [sections]);

  const primary = useMemo(() => {
    if (chosen !== null) {
      // A stored route the person can no longer reach is dropped rather than
      // rendered as a dead tab: permissions change, and a bar remembered from
      // a wider role must not outlive the access that justified it.
      return chosen
        .map((route) => allDestinations.find((i) => i.to === route))
        .filter((i): i is NavItem => Boolean(i))
        .slice(0, BOTTOM_NAV_SLOTS);
    }
    // Never chosen: the bar follows the module -- its phone default first
    // (what a hand on the floor needs), then the first screens fill in.
    const preferred = (module.phoneBar ?? [])
      .map((route) => moduleItems.find((i) => i.to === route))
      .filter((i): i is NavItem => Boolean(i));
    const rest = moduleItems.filter((i) => !preferred.includes(i));
    return [...preferred, ...rest].slice(0, BOTTOM_NAV_SLOTS);
  }, [chosen, allDestinations, moduleItems, module.phoneBar]);

  const primaryRoutes = new Set(primary.map((i) => i.to));
  const overflow = moduleItems.filter((item) => !primaryRoutes.has(item.to));

  if (moduleItems.length === 0 && elsewhere.length === 0) return null;

  return (
    <>
      {/*
        Fixed rather than sticky so it survives a scrolling content region, and
        padded by the safe-area inset so the home indicator on a modern phone
        does not sit on top of the tab labels.
      */}
      <nav
        aria-label="Primary"
        // The phone's stand-in for the sidebar anchor, so the tour's first step
        // points at the navigation that actually exists at this width.
        data-guide="nav.bottom-bar"
        className="bg-background/95 supports-backdrop-filter:bg-background/80 reduced-transparency:bg-background reduced-transparency:backdrop-blur-none fixed inset-x-0 bottom-0 z-30 border-t pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
      >
        <ul className="flex items-stretch justify-around">
          {primary.map((item) => (
            <li key={item.to} className="min-w-0 flex-1">
              <NavLink
                to={item.to}
                aria-current={location.pathname === item.to ? 'page' : undefined}
                className={cn(
                  // h-full as well as min-h-14: the unlayered 44px touch floor
                  // in index.css outranks min-h-* on an anchor, so the links
                  // measured 52.5px beside the 56px More button and every icon
                  // sat 2px higher than its neighbour. Filling the stretched
                  // row centres all five identically.
                  'flex h-full min-h-14 flex-col items-center justify-center gap-1 px-1 py-1.5 text-[0.6875rem]',
                  location.pathname === item.to
                    ? 'text-primary font-medium'
                    : 'text-muted-foreground',
                )}
              >
                <item.icon aria-hidden className="size-5 shrink-0" />
                <span className="w-full truncate text-center">{item.shortLabel ?? item.label}</span>
              </NavLink>
            </li>
          ))}

          <li className="min-w-0 flex-1">
            <Button
              variant="ghost"
              aria-label="More destinations"
              aria-expanded={moreOpen}
              onClick={() => {
                setMoreOpen(true);
              }}
              // h-auto because the tab is two stacked lines, not the single
              // row the button variant sizes for.
              className="text-muted-foreground h-auto min-h-14 w-full flex-col gap-1 rounded-none px-1 py-1.5 text-[0.6875rem] font-normal"
            >
              <DotsThreeIcon aria-hidden className="size-5 shrink-0" />
              <span className="w-full truncate text-center">More</span>
            </Button>
          </li>
        </ul>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        {/* The sheet itself no longer scrolls. It is a flex column whose middle
            band scrolls, which pins the title and the action to the top and
            bottom edges instead of letting them slide away — on a phone the
            close control and the primary action are the two things that must
            never require scrolling back to find. */}
        <SheetContent side="bottom" className="max-h-[80vh] gap-0">
          <SheetHeader className="shrink-0 border-b">
            <SheetTitle>{module.label}</SheetTitle>
            <SheetDescription>Everything your access allows, and the other modules.</SheetDescription>
          </SheetHeader>

          {/* min-h-0 is load-bearing: a flex child defaults to min-height:auto,
              which refuses to shrink below its content and would push the
              footer off the sheet instead of scrolling. */}
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {visibleModules.length > 1 ? (
              <div className="mb-4 flex flex-col gap-2">
                <p className="text-muted-foreground text-xs font-medium">Modules</p>
                {/*
                  One line, scrolling sideways. Never two rows: a second row
                  moves everything under it down the sheet, and the owner
                  asked for the row to stay a row.

                  The fade on the right edge is what makes that honest. The
                  original complaint was that Attendance sat off-screen with
                  nothing to say so -- the scrollbar was hidden and the row
                  ended in clean whitespace, which reads as "that is all of
                  them". A soft edge reads as "there is more", which is the
                  only affordance a sideways scroll gets on a phone.

                  It is drawn only while the row actually overflows: an
                  organisation with three modules gets a plain row rather than
                  a gradient promising something that is not there.
                */}
                <div className="relative">
                  <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
                    {visibleModules.map((m) => (
                      <Button
                        key={m.id}
                        variant={m.id === module.id ? 'default' : 'ghost'}
                        size="sm"
                        className="shrink-0"
                        aria-current={m.id === module.id ? 'true' : undefined}
                        onClick={() => {
                          setMoreOpen(false);
                          if (m.id !== module.id) void navigate(m.home);
                        }}
                      >
                        <m.icon data-icon="inline-start" />
                        {m.label}
                      </Button>
                    ))}
                  </div>
                  {visibleModules.length > 4 ? (
                    <span
                      aria-hidden
                      className="from-background pointer-events-none absolute inset-y-0 -right-4 w-8 bg-gradient-to-l to-transparent"
                    />
                  ) : null}
                </div>
              </div>
            ) : null}
            {/* A grid of tiles rather than a single column of rows. One row per
                destination pushed the last few below the fold on a phone and
                wasted the full width on a 20px icon; two columns fit twelve
                destinations in a glance. Three from sm, where the tile can be
                wide enough for "Roles and permissions" without wrapping. The
                tile is a 44px row with the icon on the left: stacking the icon
                over the label made an 80px slab of each. */}
            <ItemGroup role="presentation" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {overflow.map((item) => (
                <Item
                  key={item.to}
                  variant="outline"
                  render={<NavLink to={item.to} />}
                  onClick={() => {
                    setMoreOpen(false);
                  }}
                  className="min-h-11 gap-2 px-2 py-1.5"
                >
                  <item.icon aria-hidden className="size-4 shrink-0" />
                  <ItemContent className="min-w-0">
                    {/* line-clamp-2 rather than the default 1: "Roles and
                        permissions" needs two lines in a 360px column. */}
                    <ItemTitle className="line-clamp-2 leading-tight">
                      {item.label}
                    </ItemTitle>
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
            {elsewhere.length > 0 ? (
              <div className="mt-4 flex flex-col gap-2">
                <p className="text-muted-foreground text-xs font-medium">Administration and inbox</p>
                <ItemGroup role="presentation" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {elsewhere.map((item) => (
                    <Item
                      key={item.to}
                      variant="outline"
                      render={<NavLink to={item.to} />}
                      onClick={() => {
                        setMoreOpen(false);
                      }}
                      className="min-h-11 gap-2 px-2 py-1.5"
                    >
                      <item.icon aria-hidden className="size-4 shrink-0" />
                      <ItemContent className="min-w-0">
                        <ItemTitle className="line-clamp-2 leading-tight">{item.label}</ItemTitle>
                      </ItemContent>
                    </Item>
                  ))}
                </ItemGroup>
              </div>
            ) : null}
          </div>

          <SheetFooter className="shrink-0 border-t">
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                setMoreOpen(false);
                setCustomiseOpen(true);
              }}
            >
              <SlidersHorizontalIcon data-icon="inline-start" />
              Customise this bar
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <CustomiseSheet
        open={customiseOpen}
        onOpenChange={setCustomiseOpen}
        sections={sections}
        current={primary.map((i) => i.to)}
        onNavigateHome={() => {
          void navigate(module.home);
        }}
      />
    </>
  );
}

interface CustomiseSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sections: readonly { label: string; items: NavItem[] }[];
  current: string[];
  onNavigateHome: () => void;
}

function CustomiseSheet({
  open,
  onOpenChange,
  sections,
  current,
  onNavigateHome,
}: CustomiseSheetProps) {
  const setBottomNavRoutes = useNavPreferencesStore((s) => s.setBottomNavRoutes);
  const resetBottomNav = useNavPreferencesStore((s) => s.resetBottomNav);
  const [draft, setDraft] = useState<string[]>(current);

  // Reopening after a change should show what is stored, not what was being
  // edited last time the sheet was dismissed.
  const [seededFor, setSeededFor] = useState(current.join('|'));
  if (open && seededFor !== current.join('|')) {
    setSeededFor(current.join('|'));
    setDraft(current);
  }

  const full = draft.length >= BOTTOM_NAV_SLOTS;

  function toggle(route: string, checked: boolean) {
    setDraft((prev) => {
      if (checked) return prev.includes(route) ? prev : [...prev, route];
      return prev.filter((r) => r !== route);
    });
  }

  return (
    // A bottom Sheet rather than a centred Dialog, because this opens from the
    // More sheet and replaces it: two modals on the same phone, one arriving
    // from the bottom and the next from the middle, read as two unrelated
    // surfaces. CLAUDE.md §3.1 asks for a Sheet on small screens anyway, and
    // this component never renders above md.
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[80vh] gap-0">
        <SheetHeader className="shrink-0 border-b">
          <SheetTitle>Customise the bar</SheetTitle>
          <SheetDescription>
            Pick up to {BOTTOM_NAV_SLOTS} destinations from any module. The bar stays the same on every screen; everything else waits under More.
          </SheetDescription>
        </SheetHeader>

        {/* Only this band scrolls, so the title above and the three actions
            below stay put while the tiles move past. */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="flex flex-col gap-4">
            {sections.map((section) => (
              <div key={section.label} className="flex flex-col gap-2">
                {/* One section per module, named, so "Dispatches" found under
                    Logistics reads as the same screen the sidebar offers there. */}
                {sections.length > 1 ? (
                  <p className="text-muted-foreground text-xs font-medium">{section.label}</p>
                ) : null}
                {/* Same grid, same tile size, same columns as the More sheet:
                    this chooser and the list it edits show the same
                    destinations, so they should not disagree about what a
                    destination looks like. */}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {section.items.map((item) => {
                    const checked = draft.includes(item.to);
                    // A full bar disables the unchosen tiles rather than
                    // silently ignoring the tap, so the limit is visible
                    // before it is hit.
                    const disabled = !checked && full;
                    return (
                      <Button
                        key={item.to}
                        type="button"
                        variant={checked ? 'default' : 'outline'}
                        aria-pressed={checked}
                        disabled={disabled}
                        onClick={() => {
                          toggle(item.to, !checked);
                        }}
                        className="h-auto min-h-11 justify-start gap-2 px-2 py-1.5 text-left whitespace-normal"
                      >
                        <item.icon aria-hidden className="size-4 shrink-0" />
                        <span className="min-w-0 flex-1 text-[0.75rem] leading-tight">{item.label}</span>
                      </Button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Outside the scrolling band: this is the count against a hard limit,
            and it is worth nothing if it scrolls away while tiles are being
            tapped. It carries the divider so the fixed bottom block reads as
            one piece rather than two stacked rules. */}
        <p className="text-muted-foreground shrink-0 border-t px-4 pt-3 text-xs" aria-live="polite">
          {draft.length} of {BOTTOM_NAV_SLOTS} chosen
        </p>

        {/* SheetFooter stacks into a column, which turned three short actions
            into three full-width bars and pushed Save furthest from the thumb.
            They fit one row at 360px, so they stay in one row and share the
            width evenly. Each carries an icon, so the action is readable
            before the label is. */}
        <SheetFooter className="shrink-0 flex-row justify-end gap-2 pt-3">
          <Button
            variant="ghost"
            className="flex-1 sm:flex-none"
            onClick={() => {
              resetBottomNav();
              onOpenChange(false);
            }}
          >
            <ArrowCounterClockwiseIcon data-icon="inline-start" />
            Reset
          </Button>
          <Button
            variant="outline"
            className="flex-1 sm:flex-none"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            <XIcon data-icon="inline-start" />
            Cancel
          </Button>
          <Button
            className="flex-1 sm:flex-none"
            onClick={() => {
              setBottomNavRoutes(draft);
              onOpenChange(false);
              // If the current screen just left the bar entirely, the person is
              // standing somewhere they can no longer see; take them home.
              if (draft.length === 0) onNavigateHome();
            }}
          >
            <ACTION_ICONS.save data-icon="inline-start" />
            Save
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
