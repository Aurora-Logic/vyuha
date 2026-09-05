import {
  CalculatorIcon,
  CompassIcon,
  InfoIcon,
  KeyboardIcon,
  MagnifyingGlassIcon,
  MapPinIcon,
  MegaphoneIcon,
  MonitorIcon,
  MoonIcon,
  QuestionIcon,
  SignOutIcon,
  SunIcon,
  UserCircleIcon,
} from '@phosphor-icons/react';
import { Suspense, useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';

import { BreadcrumbTrail } from '@/components/shared/breadcrumb-trail';
import { HeaderTooltip } from '@/components/shared/header-tooltip';
import { ErrorBoundary } from '@/components/shared/error-boundary';
import { Skeleton } from '@/components/ui/skeleton';
import { useTheme } from '@/components/theme-provider';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { AppearanceEffect } from '@/components/shared/appearance-effect';
import { ThemeToggleGroup } from '@/components/shared/theme-toggle-group';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Toaster, toast } from '@/components/ui/toast';
import { CalculatorButton, CalculatorPanel, useCalculatorStore } from '@/features/calculator';
import { GuideOverlay } from '@/features/guide';
import { NotificationBell } from '@/features/notifications';
import { hasUnread } from '@/features/updates';
import { useIsMobile } from '@/hooks/use-mobile';
import { useGuideStore } from '@/lib/guide-store';
import { ShortcutLayer } from '@/lib/keyboard/registry';
import { findBreadcrumbs } from '@/lib/nav';
import { useSessionStore } from '@/lib/session/session-store';
import { useLogout, useMe } from '@/lib/session/use-session';
import { useUiStore } from '@/lib/ui-store';
import { employeeDisplayName, SYSTEM_ROLES, type SystemRoleName } from '@vyuha/shared';

import { MobileBottomNav } from '@/components/shared/mobile-bottom-nav';

import { GoToPalette } from '../goto-palette';
import { ShortcutDialog } from '../shortcut-dialog';
import { AppSidebar } from './app-sidebar';

/**
 * Theme choice, as a section of the account menu rather than a control of its
 * own. It was a second icon button sitting beside the avatar, which is a lot
 * of permanent header real estate for something a person sets once and then
 * leaves alone; it belongs with the other things that are about them rather
 * than about the page.
 *
 * The label lives inside the radio group: Base UI reads its group context and
 * throws outright if a label is rendered loose in the popup, which takes the
 * whole menu down with it.
 */
function ThemeSection() {
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenuRadioGroup
      value={theme}
      onValueChange={(v) => {
        setTheme(v as 'light' | 'dark' | 'system');
      }}
    >
      <DropdownMenuLabel>Theme</DropdownMenuLabel>
      <DropdownMenuRadioItem value="light">
        <SunIcon />
        Light
      </DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="dark">
        <MoonIcon />
        Dark
      </DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="system">
        <MonitorIcon />
        System
      </DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  );
}

/**
 * Two letters for the avatar. Falls back to the first character of whatever
 * name we have rather than rendering an empty circle, because an employee
 * record is only guaranteed a first name (the contract makes lastName
 * nullable) and a signed-in user may have no employee record at all.
 */
/**
 * One destination in the account sheet's grid: a 44px row, glyph on the
 * left, the label allowed two lines, the whole tile the target. The same
 * tile the More and Customise sheets use; stacking the glyph over the label
 * made an 80px slab of each (B-23).
 */
function SheetTile({ icon, label, dot, onClick }: { icon: React.ReactNode; label: string; dot?: boolean; onClick: () => void }) {
  return (
    <Button
      variant="outline"
      className="relative h-auto min-h-11 justify-start gap-2 px-2 py-1.5 text-left whitespace-normal"
      onClick={onClick}
    >
      {icon}
      <span className="line-clamp-2 min-w-0 flex-1 text-xs leading-tight">{label}</span>
      {dot ? <span className="bg-primary absolute top-2 right-2 size-2 rounded-full" aria-hidden /> : null}
    </Button>
  );
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const first = words[0]?.charAt(0) ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase() || '?';
}


/**
 * Who is signed in, and the way out.
 *
 * Reads `/me` directly rather than the session store: the store flattens roles
 * to a display string for the sidebar, and this menu needs the email and the
 * roles as they actually came back from the server.
 *
 * Every label here comes from the API answer. Nothing is derived from a role
 * name (PRD §2: nothing branches on a role), and nothing is remembered locally
 * — sign out clears the query cache, so the next render has nothing to leak.
 */
function UserMenu() {
  const navigate = useNavigate();
  const { data: me } = useMe();
  const logout = useLogout();
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);
  /*
   * Starting the tour is a request, not a call.
   *
   * The run state belongs to GuideOverlay, which is a sibling of this menu
   * rather than an ancestor, so there is nothing to call into. Arming is the
   * same channel the sign-in screen uses, and the overlay collects it either
   * way — one path in, rather than a context provider existing only so a menu
   * item can reach a component beside it.
   */
  const armGuide = useGuideStore((s) => s.arm);
  const startTour = () => {
    armGuide({ scope: 'all' });
  };
  const startPageGuide = () => {
    armGuide({ scope: 'page' });
  };
  // The action alone, which is a stable reference, so opening or closing the
  // calculator never re-renders the header. Selecting the whole store would.
  const openCalculator = useCalculatorStore((s) => s.openPanel);
  // The action alone, for the same reason the calculator takes only its
  // opener: selecting the whole store would re-render the header every time
  // the answer panel opened or closed.
  const openShortcuts = useUiStore((s) => s.setShortcutsOpen);
  /*
   * The unread dot.
   *
   * Compared against the newest release rather than counted, because "how many
   * entries are new" is not a question anybody asks and maintaining a count
   * would mean storing which entries were read rather than when.
   */
  const seenVersion = useGuideStore((s) => s.seenVersion);
  const unread = hasUnread(seenVersion);

  // AppShell only renders behind SessionGate, so this is a type narrowing
  // rather than a real state. Rendering nothing beats rendering "Unknown".
  if (!me) return null;

  const name = me.employee
    ? employeeDisplayName(me.employee.firstName, me.employee.lastName)
    : me.user.email;
  const roleLabel = me.roles.map((role) => role.name).join(', ') || 'No role';
  const initials = initialsOf(name);

  function goToProfile() {
    setSheetOpen(false);
    void navigate('/profile');
  }

  /*
   * On a phone this is a bottom Sheet rather than the dropdown.
   *
   * As a popover it was a ~240px column pinned to the top-right corner
   * carrying ten rows — three lines of identity, a theme label and its three
   * options, then two actions — reaching most of the way down a 360px screen
   * from the furthest point from the thumb. CLAUDE.md §3.1 asks for a Sheet on
   * small screens, and More and Customise already open that way, so this also
   * stops the phone having two different ideas of what a menu is.
   *
   * It is also shorter: the identity collapses into the header beside the
   * avatar, the three theme options become one row instead of four, and the
   * two actions share a row.
   */
  if (isMobile) {
    return (
      <>
        <Button
          variant="ghost"
          size="icon"
          aria-label={
            unread ? `Account menu for ${name}, unread updates` : `Account menu for ${name}`
          }
          data-guide="header.account"
          className="relative"
          onClick={() => {
            setSheetOpen(true);
          }}
        >
          <Avatar size="sm">
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          {unread ? (
            <span
              aria-hidden
              className="bg-primary ring-background absolute top-1 right-1 size-2 rounded-full ring-2"
            />
          ) : null}
        </Button>

        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="bottom" className="gap-0">
            <SheetHeader className="flex-row items-center gap-3 border-b">
              <Avatar>
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-col">
                <SheetTitle className="truncate">{name}</SheetTitle>
                {/* An account with no employee record falls back to the email
                    as its name, and printing it again underneath just reads as
                    a rendering bug. */}
                {me.user.email === name ? null : (
                  <SheetDescription className="truncate">{me.user.email}</SheetDescription>
                )}
                <SheetDescription className="truncate">{roleLabel}</SheetDescription>
              </div>
            </SheetHeader>

            <div className="flex flex-col gap-2 p-4">
              <span className="text-muted-foreground text-xs font-medium">Theme</span>
              {/* One row of three rather than three stacked rows. A set this
                  small reads faster side by side, and it costs one row of
                  height instead of four. */}
              <ThemeToggleGroup />
            </div>

            {/* Six destinations as a grid of tiles rather than six rows: a
                row spends the whole width on one word and pushes the tail
                below the fold (thumb-reach). Two columns at 360, three from
                sm. Three of these exist only because a phone has no keyboard
                and hides the header buttons below sm: the answer panel and the
                per-screen guide live on Ctrl+F1, the calculator on Ctrl+N
                (REQ-N-03), and without a tile here each would be built
                responsive and then be unreachable at the width that was for. */}
            <div className="grid grid-cols-2 gap-2 border-t p-4 sm:grid-cols-3">
              <SheetTile icon={<UserCircleIcon className="size-5" />} label="Profile" onClick={goToProfile} />
              <SheetTile
                icon={<MegaphoneIcon className="size-5" />}
                label="Updates"
                dot={unread}
                onClick={() => {
                  setSheetOpen(false);
                  void navigate('/updates');
                }}
              />
              <SheetTile
                icon={<QuestionIcon className="size-5" />}
                label="Ask a question"
                onClick={() => {
                  setSheetOpen(false);
                  openShortcuts(true);
                }}
              />
              <SheetTile
                icon={<MapPinIcon className="size-5" />}
                label="Guide to this screen"
                onClick={() => {
                  setSheetOpen(false);
                  startPageGuide();
                }}
              />
              <SheetTile
                icon={<CompassIcon className="size-5" />}
                label="Take the tour"
                onClick={() => {
                  setSheetOpen(false);
                  startTour();
                }}
              />
              <SheetTile
                icon={<CalculatorIcon className="size-5" />}
                label="Calculator"
                onClick={() => {
                  setSheetOpen(false);
                  openCalculator();
                }}
              />
            </div>

            <SheetFooter className="border-t">
              {/* Alone on the bottom edge, and not a confirm: signing back in
                  costs one form, and a dialog on a reversible action is
                  friction, not safety. */}
              <Button
                variant="ghost"
                className="text-destructive hover:text-destructive w-full"
                disabled={logout.isPending}
                onClick={() => {
                  logout.mutate();
                }}
              >
                <SignOutIcon data-icon="inline-start" />
                {logout.isPending ? 'Signing out' : 'Sign out'}
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <DropdownMenu>
      {/* The avatar alone, at every width. The name and role used to sit
          beside it above lg, which made the header's right edge a different
          shape on a large screen than on a small one, and spent the widest
          part of the layout restating something the person already knows. The
          menu below states the name, the email and the roles in full, and the
          trigger's aria-label carries the name for anyone who cannot see the
          initials — so nothing is lost by not printing it. */}
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={
              unread ? `Account menu for ${name}, unread updates` : `Account menu for ${name}`
            }
            data-guide="header.account"
            className="relative"
          />
        }
      >
        <Avatar size="sm">
          <AvatarFallback>{initialsOf(name)}</AvatarFallback>
        </Avatar>
        {/* aria-hidden: the trigger's own label already says "unread updates",
            so announcing the dot separately would say it twice. */}
        {unread ? (
          <span
            aria-hidden
            className="bg-primary ring-background absolute top-1 right-1 size-2 rounded-full ring-2"
          />
        ) : null}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-60">
        {/* The label is inside a group for the same reason the theme label is
            inside its radio group: Base UI reads the group context and throws
            when a GroupLabel is rendered loose in the popup, which takes the
            whole menu down. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5 py-2.5">
            <span className="text-foreground truncate text-xs font-medium">{name}</span>
            {me.user.email === name ? null : <span className="truncate">{me.user.email}</span>}
            <span className="truncate">{roleLabel}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <ThemeSection />

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={() => {
              void navigate('/updates');
            }}
          >
            <MegaphoneIcon />
            Updates
            {unread ? <span className="bg-primary ml-auto size-2 rounded-full" aria-hidden /> : null}
          </DropdownMenuItem>
          {/* The page guide is listed above the whole-product one because it
              is the commoner question by far: "what is this screen for?" gets
              asked every day, "show me the product" once. Ctrl+F1 offers the
              same thing, but only to somebody who already knows the key. */}
          <DropdownMenuItem
            onClick={() => {
              startPageGuide();
            }}
          >
            <MapPinIcon />
            Guide to this screen
          </DropdownMenuItem>
          {/* Wrapped for the same reason as the sign-in offer: `arm` takes an
              optional step id, and the raw handler would pass the click event. */}
          <DropdownMenuItem
            onClick={() => {
              startTour();
            }}
          >
            <CompassIcon />
            Take the tour
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              void navigate('/profile');
            }}
          >
            <UserCircleIcon />
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={logout.isPending}
            onClick={() => {
              // No confirmation. Signing back in costs one form, and a
              // confirm dialog on a reversible action is friction, not safety.
              logout.mutate();
            }}
          >
            <SignOutIcon />
            {logout.isPending ? 'Signing out' : 'Sign out'}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Development only, and rendered only when the session came from the preview
 * path rather than from `/me`. It exists so the permission filtering in the
 * sidebar and the Go To palette can be seen working before the auth endpoints
 * are built. It disappears the moment a real session is present.
 */
function PreviewRoleMenu() {
  const roleLabel = useSessionStore((s) => s.roleLabel);
  const applyPreviewRole = useSessionStore((s) => s.applyPreviewRole);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" className="ml-auto shrink-0" />}
      >
        Preview: {roleLabel}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>No API yet — preview a role</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {Object.values(SYSTEM_ROLES).map((role: SystemRoleName) => (
            <DropdownMenuItem
              key={role}
              onSelect={() => {
                applyPreviewRole(role);
              }}
            >
              {role}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell() {
  const location = useLocation();
  const isPreview = useSessionStore((s) => s.isPreview);
  const toggleGoto = useUiStore((s) => s.toggleGoto);
  const armGuideFromHeader = useGuideStore((s) => s.arm);
  const startPageGuide = () => {
    armGuideFromHeader({ scope: 'page' });
  };
  const toggleShortcuts = useUiStore((s) => s.toggleShortcuts);

  return (
    <SidebarProvider>
      <AppearanceEffect />
      {/* First focusable element in the document, and it has to be: it used to
          sit inside SidebarInset, which renders after the sidebar, so the first
          Tab landed on the organisation brand and a keyboard user still had to
          walk the whole sidebar. Caught by a probe, not by reading.

          Padding is applied only on focus. Alongside sr-only it beat that
          utility's padding: 0 and inflated the hidden link into a real 24x16
          target while it was still invisible. */}
      <a
        href="#main-content"
        className="bg-background focus-visible:ring-ring sr-only text-sm font-medium focus-visible:not-sr-only focus-visible:absolute focus-visible:top-2 focus-visible:left-2 focus-visible:z-50 focus-visible:px-3 focus-visible:py-2 focus-visible:ring-2"
      >
        Skip to content
      </a>

      <AppSidebar />

      <SidebarInset className="min-w-0">

        {/* A material rather than an opaque strip: content scrolls under it and
            stays faintly legible, which keeps the page feeling continuous while
            scrolling a long muster. Falls back to solid where the browser has
            no backdrop-filter, and where the reader has asked for reduced
            transparency. */}
        <header className="bg-background/85 supports-backdrop-filter:bg-background/70 reduced-transparency:bg-background reduced-transparency:backdrop-blur-none sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b px-3 backdrop-blur-md">
          {/* Desktop only. On a phone the bottom bar is the navigation, and
              keeping a hamburger that opens a second, different nav gives the
              screen two answers to "where can I go". */}
          <SidebarTrigger className="hidden md:inline-flex" />
          {/* The 16px vertical rule that used to sit here is gone. In a 56px
              header it read as a stray half-drawn line rather than a divider,
              and the gap between the trigger and the breadcrumb already
              separates them. Deleting beats tuning a mark that was doing no
              work. */}

          {/* The page states its identity here and nowhere else, so the body
              starts straight into content. Derived from the route rather than
              passed up by the screen — a screen cannot forget to say who it
              is, and two screens cannot name the same route differently. */}
          <BreadcrumbTrail crumbs={findBreadcrumbs(location.pathname)} />

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {/* Every key chip that used to sit in this row now lives in the
                hover tooltip. See components/shared/header-tooltip for why, and
                for the §6.4 departure it records. */}
            <HeaderTooltip label="Go to a screen or report" keys="alt+g">
              <Button
                variant="outline"
                size="sm"
                aria-label="Go to a screen or report"
                data-guide="header.goto"
                className="text-muted-foreground max-sm:size-11 max-sm:border-transparent max-sm:bg-transparent max-sm:px-0 max-sm:shadow-none gap-2 font-normal"
                onClick={toggleGoto}
              >
                <MagnifyingGlassIcon />
                <span className="hidden sm:inline">Go to</span>
              </Button>
            </HeaderTooltip>

            {/* The per-screen guide, in the header because that is where
                somebody looks when they want to know what they are looking at.
                It was reachable only from the account menu and Ctrl+F1, which
                are both places you go having already decided to ask. */}
            <HeaderTooltip label="Guide to this screen">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Guide to this screen"
                data-guide="header.page-guide"
                onClick={startPageGuide}
              >
                <MapPinIcon />
              </Button>
            </HeaderTooltip>

            {/* "Help and shortcuts", not "Keyboard shortcuts". The key is
                still PRD §6.4's, and the icon still says which key -- but the
                sheet behind it now answers questions as well as listing keys,
                and nobody looking for help clicks a keyboard. The label is
                where that is cheapest to say: the icon stays, so the header
                gains no width and the tour anchor keeps its target. */}
            <HeaderTooltip label="Help and shortcuts" keys="ctrl+f1" alias="f1">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Help and shortcuts"
                data-guide="header.shortcuts"
                className="hidden sm:inline-flex"
                onClick={toggleShortcuts}
              >
                <KeyboardIcon />
              </Button>
            </HeaderTooltip>

            {/* REQ-K-05. The header's bell is notifications, and Updates keeps
                its place in the account menu behind a megaphone: two bells a
                few pixels apart, one meaning "the product changed" and one
                meaning "something happened to you", is a coin toss every time
                somebody sees a dot. */}
            <HeaderTooltip label="Notifications">
              <NotificationBell />
            </HeaderTooltip>

            {/* REQ-N-03, and the only place the shortcut is advertised: the
                hint chip PRD §6.4 asks for rides on this button. Hidden below
                sm because a phone has no keyboard to hint at and the header
                has no room, not because the calculator is unavailable there --
                it opens as a Sheet once something else summons it. */}
            {/* Carries its own tooltip, so it is not wrapped here. */}
            <CalculatorButton className="hidden sm:inline-flex" />

            <UserMenu />
          </div>
        </header>

        {isPreview ? (
          // Theme tokens only. The previous amber palette values bypassed the
          // theme entirely and would not have followed a rebrand (CLAUDE.md §3
          // rule 1); the icon carries the signal the colour used to.
          <div className="text-muted-foreground bg-muted/40 flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2 text-xs">
            <InfoIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0">
              Preview mode. No API is running, so this session is not real and no data is loaded.
            </span>
            {/* The role switcher sits with the notice that explains it rather
                than in the header. Both are development-only and both vanish
                on the same condition, so the control cannot outlive its
                explanation or be left behind in production chrome. */}
            <PreviewRoleMenu />
          </div>
        ) : null}

        {/*
          A new screen pushes a new shortcut scope, so a screen's shortcuts
          unregister cleanly on navigation and cannot leak into the next one.
        */}
        <ShortcutLayer id={`screen:${location.pathname}`}>
          {/* A div, not a <main>. SidebarInset already renders the page's
              <main> landmark, and nesting a second one is invalid and leaves
              assistive technology with two competing "main content" regions.
              This is only the skip-link target inside that landmark. */}
          <div
            id="main-content"
            tabIndex={-1}
            // pb-24 clears the fixed bottom bar on a phone. Without it the last
            // row of any list sits under the bar and cannot be reached.
            // Keyed by pathname so each screen arrives with the 120ms enter
            // (index.css .screen-enter); the ErrorBoundary inside was already
            // keyed the same way, so nothing new remounts that did not before.
            key={location.pathname}
            className="screen-enter flex min-w-0 flex-1 flex-col gap-6 p-4 pb-24 outline-none md:p-6 md:pb-6"
          >
            {/* Inside the shell rather than around it, so a screen that throws
                takes only itself down and the navigation is still there to
                leave by. Keyed on the path: walking to another screen clears
                the error, which is what anyone would expect that to do. */}
            <ErrorBoundary resetKey={location.pathname}>
              {/* P-23: each route is its own chunk; the shell stays put while
                  the page's code arrives. The fallback is the page's shape,
                  never a spinner (emil: a spinner seen all day reads as slow). */}
              <Suspense fallback={<RouteFallback />}>
                <Outlet />
              </Suspense>
            </ErrorBoundary>
          </div>
        </ShortcutLayer>
      </SidebarInset>

      <MobileBottomNav />

      <GoToPalette />
      <ShortcutDialog />
      {/* REQ-N-03. Outside the screen's ShortcutLayer for the reason the tour
          gives below: its own layer suspends the screen's keys while it is up,
          so typing 7 into the calculator cannot also trigger whatever 7 means
          on the screen behind it. */}
      <CalculatorPanel />
      {/* Renders null unless a run is in progress, so the cost to somebody who
          never takes the tour is one mounted component doing nothing. Sits
          outside the screen's ShortcutLayer on purpose: it pushes a layer of
          its own, which suspends the screen's keys while the tour is up. */}
      <GuideOverlay />
      <AccessWindowWarning />
      {/* Base UI's viewport owns its placement (bottom-right above sm, full
          width on a phone), so there is no position prop to pass. */}
      <Toaster />
    </SidebarProvider>
  );
}

/**
 * 12 REQ-AB-05: the window does not throw anybody out at 19:30 — refresh is
 * refused after the cutoff and the session simply runs out — but a person
 * mid-form deserves to hear that fifteen minutes ahead. `/me` says how many
 * minutes remain when the shell mounts; the timer counts down from there.
 * Exempt holders (Admin) are never warned: nothing changes for them.
 */
const WARN_MINUTES_BEFORE = 15;

function AccessWindowWarning() {
  const { data: me } = useMe();
  const closesInMinutes = me?.accessWindow?.closesInMinutes ?? null;
  const exempt = me?.accessWindow?.exempt ?? true;
  useEffect(() => {
    if (exempt || closesInMinutes === null) return undefined;
    const warnInMs = Math.max(0, (closesInMinutes - WARN_MINUTES_BEFORE) * 60_000);
    // Already inside the last fifteen minutes: say so now rather than never.
    const closesAt = new Date(Date.now() + closesInMinutes * 60_000);
    const label = closesAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const timer = window.setTimeout(() => {
      toast.add({
        type: 'warning',
        title: `Sign-in closes at ${label}`,
        description: 'Your session ends when it expires; save what you are working on. Punch stays open.',
        timeout: 0,
      });
    }, warnInMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [closesInMinutes, exempt]);
  return null;
}

/** The between-routes state: the page's own shape, not a spinner (emil: perceived speed). */
function RouteFallback() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" className="flex flex-col gap-3">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-4 w-full max-w-md" />
      <Skeleton className="mt-2 h-64 w-full" />
    </div>
  );
}
