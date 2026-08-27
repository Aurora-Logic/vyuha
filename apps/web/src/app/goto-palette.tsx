import { useMemo, useState } from 'react';
import type { Icon } from '@phosphor-icons/react';
import { useNavigate } from 'react-router';

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { filterScreenGroups } from '@/lib/go-to-filter';
import { kindOf } from '@/lib/go-to-records';
import { ShortcutLayer, useShortcut } from '@/lib/keyboard/registry';
import { ADMIN_GROUPS, MODULES, TOP_BAR_ITEMS, type NavGroup, type NavItem } from '@/lib/nav';
import { usePermissions } from '@/lib/session/permissions';
import { useUiStore } from '@/lib/ui-store';
import { GO_TO_QUERY_MAX_LENGTH, GO_TO_QUERY_MIN_LENGTH, type GoToRecord } from '@vyuha/shared';

import { useGoToRecords } from './use-go-to-records';

/**
 * REQ-N-01 / REQ-O-05: Alt+G is the primary navigation, matching Tally's
 * model — and it searches records, not only screens. Typing an employee code
 * opens that employee; parties and vouchers join the same list in Phase 6b+
 * by registering a server-side source, with no change here.
 *
 * Screens are matched client-side over everything the account may reach —
 * including the Administration destinations REQ-O-02 moved out of the module
 * sidebar, which had silently fallen out of this palette when it read only
 * `NAV_GROUPS`. Records are matched server-side, where the permission and
 * scope rules live, so this component never decides who may find whom.
 *
 * The list runs with cmdk's own filtering off: server records arrive already
 * matched to the query, and a second filter here would re-judge them against
 * a title they may not contain (a code search matches "VY-0003", not "Asha
 * Menon"). Screen matching moves to `filterScreenGroups`, which a unit test
 * can hold still.
 *
 * Note that `CommandDialog` renders its children straight into the dialog and
 * does not supply the cmdk root itself, so the explicit `<Command>` below is
 * load-bearing. Without it cmdk throws while reading its store, React unmounts
 * the entire app, and the symptom is a blank page rather than a broken dialog.
 */

/**
 * Everything with a name and a route, wherever it is reached from — every
 * module's groups, not a hand-picked list. The hand-picked version has now
 * broken twice the same way: first when REQ-O-02 moved Administration out of
 * `NAV_GROUPS`, then when the Masters module arrived and its screens were
 * invisible here. Deriving from `MODULES` is what ends the class. Approvals
 * sits under "Inbox" because REQ-O-03's whole argument is that it is one.
 */
/**
 * One entry per destination, whichever surfaces reach it, and one group per
 * label, whichever modules use it.
 *
 * A screen can sit in a module sidebar and in the top bar at once (Approvals
 * does, since main re-added it to Work beside REQ-O-03's Inbox), and a palette
 * that listed it twice would make the arrow keys land on the same place two
 * rows apart. First surface wins; the route is what matters, not which door.
 *
 * Two modules can also both call a group "People" (attendance's employees,
 * CRM's contacts). The label is the React key and cmdk's group value, so two
 * groups sharing it rendered as one group twice -- and, worse, left the stale
 * copy standing after a query had emptied the list, so "Nothing matches that."
 * never appeared. Merging same-labelled groups makes the key unique by
 * construction; the position is the first module's, the rows are everyone's.
 */
function dedupeDestinations(groups: NavGroup[]): NavGroup[] {
  const seen = new Set<string>();
  const merged = new Map<string, NavItem[]>();
  for (const group of groups) {
    const items = group.items.filter((item) => {
      // The screen is the pathname: the report catalogue's category links
      // (/reports?category=...) are doors into one screen, and the palette
      // lists a screen once.
      const pathname = item.to.split('?')[0] ?? item.to;
      if (seen.has(pathname)) return false;
      seen.add(pathname);
      return true;
    });
    if (items.length === 0) continue;
    const existing = merged.get(group.label);
    if (existing) existing.push(...items);
    else merged.set(group.label, items);
  }
  return [...merged.entries()].map(([label, items]) => ({ label, items }));
}

const SCREEN_GROUPS: NavGroup[] = dedupeDestinations([
  ...MODULES.flatMap((module) => module.groups),
  { label: 'Inbox', items: TOP_BAR_ITEMS },
  ...ADMIN_GROUPS,
]);

export function GoToPalette() {
  const navigate = useNavigate();
  const granted = usePermissions();
  const open = useUiStore((s) => s.gotoOpen);
  const setOpen = useUiStore((s) => s.setGotoOpen);
  const toggle = useUiStore((s) => s.toggleGoto);

  const [query, setQuery] = useState('');

  useShortcut({
    id: 'global.goto',
    keys: 'alt+g',
    label: 'Go To',
    scope: 'global',
    // Closing by the shortcut clears the query the same way every other
    // close does; opening by it leaves whatever the store says alone.
    run: () => {
      if (open) setQuery('');
      toggle();
    },
  });

  const permitted = useMemo(
    () =>
      SCREEN_GROUPS.map((group) => ({
        label: group.label,
        items: group.items.filter((item) => !item.permission || granted.has(item.permission)),
      })).filter((group) => group.items.length > 0),
    [granted],
  );

  const screenGroups = filterScreenGroups(query, permitted);

  const records = useGoToRecords(query);
  // The same trim-and-cap the hook sends, so "has the server answered *this*
  // term" compares like with like: an over-cap paste otherwise never matched
  // the echoed query and the palette said "Searching records…" forever.
  const term = query.trim().slice(0, GO_TO_QUERY_MAX_LENGTH);
  const recordsExpected = term.length >= GO_TO_QUERY_MIN_LENGTH;
  const recordGroups = useMemo(() => {
    const groups = new Map<string, { record: GoToRecord; route: string; RecordIcon: Icon }[]>();
    // keepPreviousData keeps the last answer alive while a NEW term fetches —
    // which also means a query that dropped below the minimum still has data.
    // Gating here is what stops a one-letter query, or a reopened palette,
    // from wearing the previous search's records.
    if (!recordsExpected) return [] as [string, { record: GoToRecord; route: string; RecordIcon: Icon }[]][];
    for (const record of records.data?.records ?? []) {
      const kind = kindOf(record);
      if (kind === null) continue;
      const entry = { record, route: kind.route(record), RecordIcon: kind.icon };
      const bucket = groups.get(kind.group);
      if (bucket === undefined) groups.set(kind.group, [entry]);
      else bucket.push(entry);
    }
    return [...groups.entries()];
  }, [records.data, recordsExpected]);

  /**
   * "Nothing matches that." must never show while the answer is still on its
   * way — a 250ms debounce plus a round trip is long enough to read a wrong
   * claim. The response echoes the term it answers, so "the data on screen is
   * not for what is typed" is detectable without exposing the hook's debounce:
   * data for a different term means searching, whatever `isFetching` says.
   */
  const searching =
    recordsExpected &&
    recordGroups.length === 0 &&
    !records.isError &&
    (records.isFetching || records.data?.query !== term);

  /**
   * Every way the palette closes goes through here, so the query reset that
   * onOpenChange performs for Escape and the overlay also happens for a
   * selection and for the Alt+G toggle — Base UI does not fire onOpenChange
   * for an external `open` change, and a palette that reopened on the last
   * search opened on stale results and a pre-filtered screen list.
   */
  function close() {
    setOpen(false);
    setQuery('');
  }

  function go(to: string) {
    close();
    void navigate(to);
  }

  return (
    <CommandDialog
      instant
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // A palette that reopens showing the last search is a palette that
        // opens on stale results and a pre-filtered screen list.
        if (!next) setQuery('');
      }}
      title="Go To"
      description="Jump to any screen, report, or record"
      // No entrance animation. This is the primary navigation for a Tally
      // user and is opened dozens of times a day; motion here would be felt
      // as latency, not craft. See the surface-instant note in index.css.
      className="surface-instant"
    >
      <ShortcutLayer id="modal:goto">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Screen, report, or employee"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>
              {searching
                ? 'Searching records…'
                : recordsExpected && records.isError
                  ? 'No matching screens, and records are unreachable right now.'
                  : 'Nothing matches that.'}
            </CommandEmpty>
            {screenGroups.map((group) => (
              <CommandGroup key={group.label} heading={group.label}>
                {group.items.map((item) => (
                  <CommandItem
                    key={item.to}
                    value={`screen:${item.to}`}
                    onSelect={() => {
                      go(item.to);
                    }}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            {recordGroups.map(([label, entries]) => (
              <CommandGroup key={label} heading={label}>
                {entries.map(({ record, route, RecordIcon }) => (
                  <CommandItem
                    key={`${record.type}:${record.id}`}
                    value={`record:${record.type}:${record.id}`}
                    onSelect={() => {
                      go(route);
                    }}
                  >
                    <RecordIcon />
                    <span className="truncate">{record.title}</span>
                    {record.subtitle === null ? null : (
                      <span className="text-muted-foreground ml-auto truncate text-xs">
                        {record.subtitle}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </ShortcutLayer>
    </CommandDialog>
  );
}
