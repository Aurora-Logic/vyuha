import { PERMISSIONS, type PermissionKey } from '@vyuha/shared';

/**
 * What changed, and when.
 *
 * A typed module rather than a table and an endpoint. The changelog changes
 * exactly when the code changes, it ships with the code, and it is identical
 * in every environment — a database copy could disagree with the bundle it is
 * describing, and there is nothing an endpoint would buy to offset that.
 *
 * This is content, not seed data: it is written by whoever closes a phase, and
 * it is as much a part of the release as the code. Every entry here is drawn
 * from a real commit, with the REQ IDs those commits already carry (CLAUDE.md
 * §4). Do not invent a release to fill the list out.
 */

export type ChangeKind = 'added' | 'changed' | 'fixed';

export interface ChangelogEntry {
  kind: ChangeKind;
  title: string;
  body: string;
  /**
   * REQ IDs from the PRD, as they appear in the commit message.
   *
   * Traceability for whoever reads this file, not for the reader of the
   * screen -- "REQ-G-01, REQ-G-03, REQ-G-06" under a release note means
   * nothing to the person using the product, and the updates page used to
   * print it. Kept here because the link from a release back to its
   * requirement is worth having; simply not rendered.
   */
  reqs?: string[];
  /** Offers "Take me there". Must be a route that exists. */
  route?: string;
  /**
   * Offers "Show me": starts the guided tour at this step rather than at the
   * beginning. A `GuideStep` id — validated by the test beside this file, so a
   * renamed step cannot leave a button here pointing at nothing.
   */
  guideStep?: string;
  /**
   * Hidden from anyone who does not hold it. Announcing a Roles change to
   * somebody who cannot open Roles is noise, and offering to walk them to a
   * screen that will refuse them is worse.
   */
  permission?: PermissionKey;
}

export interface Release {
  /** Ordered newest first. The first entry is what the unread dot compares to. */
  version: string;
  /** ISO date. */
  date: string;
  entries: ChangelogEntry[];
}

export const RELEASES: Release[] = [
  {
    version: '0.9.0',
    date: '2026-08-13',
    entries: [
      {
        kind: 'added',
        title: 'A guided tour of the screens you can open',
        body: 'Offered on the sign-in screen, and in your account menu whenever you want it again. It highlights the real control it is describing, and it only visits screens your role allows.',
        guideStep: 'shell.nav',
      },
      {
        kind: 'added',
        title: 'This page',
        body: 'What changed and when, with a link into the screen each change touched. A dot appears on your avatar when there is something you have not read.',
        route: '/updates',
      },
      {
        kind: 'added',
        title: 'Bulk employee import',
        body: 'Employees can be created from a spreadsheet, with the reporting lines resolved across the whole file rather than row by row.',
        reqs: ['REQ-A-03'],
        route: '/employees',
        permission: PERMISSIONS.EMPLOYEE_MANAGE,
      },
    ],
  },
  {
    version: '0.8.0',
    date: '2026-08-13',
    entries: [
      {
        kind: 'added',
        title: 'Period lock',
        body: 'A month can be closed once its numbers have gone to payroll. After that no punch or edit can change it.',
        reqs: ['REQ-E-09'],
        route: '/period-lock',
        guideStep: 'screen.period-lock',
        permission: PERMISSIONS.ATTENDANCE_LOCK,
      },
      {
        kind: 'added',
        title: 'Roles, settings, integrations and the audit log',
        body: 'Roles are named bundles of permissions rather than fixed job titles, and every state-changing action now appends to a log nothing in the product can edit.',
        reqs: ['REQ-B-07', 'REQ-L-01', 'REQ-M-02'],
        route: '/audit',
        guideStep: 'screen.audit',
        permission: PERMISSIONS.AUDIT_VIEW,
      },
    ],
  },
  {
    version: '0.7.0',
    date: '2026-08-13',
    entries: [
      {
        kind: 'changed',
        title: 'An export runs as a job',
        body: 'Large exports no longer hold the screen. Start one, carry on working, and collect the file from Downloads when it is ready.',
        reqs: ['REQ-J-03'],
        route: '/downloads',
        guideStep: 'screen.downloads',
      },
      {
        kind: 'added',
        title: 'Reports',
        // History stands, but the door is gone: the reports module was
        // removed on 26 Aug 2026, so the entry keeps its story and loses
        // its link rather than pointing at a 404.
        body: 'The monthly muster and the summaries payroll needs. This was the hand-off point — no money was calculated here. Removed in a later release.',
        reqs: ['REQ-J-01'],
      },
    ],
  },
  {
    version: '0.6.0',
    date: '2026-08-13',
    entries: [
      {
        kind: 'added',
        title: 'Leave types, balances and applications',
        body: 'Apply for leave against a type, with the balance shown before you commit to a date. The ledger behind it is append-only.',
        reqs: ['REQ-G-01', 'REQ-G-03', 'REQ-G-06'],
        route: '/my-leave',
        guideStep: 'screen.my-leave',
        permission: PERMISSIONS.LEAVE_APPLY_SELF,
      },
      {
        kind: 'added',
        title: 'Holiday calendars',
        body: 'Including restricted holidays and bulk import. No dates ship assumed, so the calendar starts empty.',
        reqs: ['REQ-H-01', 'REQ-H-04'],
        route: '/holidays',
        guideStep: 'screen.holidays',
        permission: PERMISSIONS.HOLIDAY_MANAGE,
      },
    ],
  },
];

/** The version the unread dot compares against. */
export const LATEST_VERSION: string = RELEASES[0]?.version ?? '0.0.0';

/**
 * What this person should be shown.
 *
 * A release whose every entry is filtered away is dropped with it, rather than
 * rendering a version heading over nothing.
 */
export function visibleReleases(granted: ReadonlySet<PermissionKey>): Release[] {
  return RELEASES.map((release) => ({
    ...release,
    entries: release.entries.filter((e) => !e.permission || granted.has(e.permission)),
  })).filter((release) => release.entries.length > 0);
}

/**
 * Whether to show the unread dot.
 *
 * Compared by identity rather than by ordering: there is no version arithmetic
 * here, so a rollback marks the page unread too, which is the honest answer —
 * the content did change.
 */
export function hasUnread(seenVersion: string | null): boolean {
  return seenVersion !== LATEST_VERSION;
}
