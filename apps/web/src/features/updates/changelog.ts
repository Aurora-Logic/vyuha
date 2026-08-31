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
    version: '1.0.0',
    date: '2026-08-31',
    entries: [
      {
        kind: 'added',
        title: 'A dashboard for your tasks',
        body: 'What is assigned to you, what falls due next, and what has gone past its date — read as a shape rather than a list.',
        reqs: ['REQ-V-11'],
        route: '/tasks/dashboard',
        guideStep: 'screen.tasks-dashboard',
        permission: PERMISSIONS.CRM_TASK_VIEW_SELF,
      },
      {
        kind: 'added',
        title: 'A task names its customer, its supplier and its items',
        body: 'So a job is tied to the record it is about, and files can be attached to it rather than sent separately.',
        reqs: ['REQ-V-09', 'REQ-V-10'],
        route: '/tasks',
        guideStep: 'screen.tasks',
        permission: PERMISSIONS.CRM_TASK_VIEW_SELF,
      },
      {
        kind: 'added',
        title: 'The CRM updates while you watch, and shows who else is in a record',
        body: 'A deal edited by a colleague changes under you rather than going stale, and the list shows who is looking at what.',
        reqs: ['REQ-U-08', 'REQ-U-09'],
        route: '/crm/deals',
        guideStep: 'screen.crm-deals',
        permission: PERMISSIONS.CRM_DEAL_VIEW_SELF,
      },
      {
        kind: 'added',
        title: 'A dashboard for the CRM, and a deal that knows its paperwork',
        body: 'The pipeline read as a whole, and opening a deal shows the estimate, order and invoice raised against it.',
        reqs: ['REQ-U-10', 'REQ-U-12'],
        route: '/crm/dashboard',
        guideStep: 'screen.crm-dashboard',
        permission: PERMISSIONS.CRM_DEAL_VIEW_SELF,
      },
    ],
  },
  {
    version: '0.14.0',
    date: '2026-08-28',
    entries: [
      {
        kind: 'added',
        title: 'Ask a question of the software',
        body: 'Press Ctrl+F1 and type a question — "why can\u2019t I punch from here" — instead of hunting for the screen that answers it. A question nobody has answered yet is passed on rather than dropped.',
        reqs: ['REQ-AJ-05'],
        guideStep: 'shell.shortcuts',
      },
    ],
  },
  {
    version: '0.13.0',
    date: '2026-08-26',
    entries: [
      {
        kind: 'changed',
        title: 'Reports rebuilt, and they speak the attendance language',
        body: 'One shell for every report — the same filter bar, column chooser, saved views and export everywhere, rather than a bespoke screen each.',
        reqs: ['REQ-J-01', 'REQ-J-02', 'REQ-AD-03'],
        route: '/reports',
        guideStep: 'screen.reports',
        permission: PERMISSIONS.REPORT_VIEW,
      },
      {
        kind: 'added',
        title: 'Build a report of your own',
        body: 'Choose the columns, the grouping and the period, and keep it as a saved view rather than asking for a new screen.',
        route: '/reports/custom',
        permission: PERMISSIONS.REPORT_VIEW,
      },
    ],
  },
  {
    version: '0.12.0',
    date: '2026-08-22',
    entries: [
      {
        kind: 'added',
        title: 'Two-step sign-in',
        body: 'Pair an authenticator app with your account, and keep the recovery codes somewhere safe — they are shown once and are the way back in if you lose the phone.',
        reqs: ['REQ-B-09'],
        // Route but no guideStep: /profile is reached from the account menu
        // and is deliberately absent from the whole-product tour, so "Show me"
        // would arm a step the run could never land on.
        route: '/profile',
      },
      {
        kind: 'added',
        title: 'Order to dispatch, end to end',
        body: 'Scan a pick, mark a consignment packed, then delivered — each stage its own screen, and each one usable one-handed on a phone.',
        reqs: ['REQ-AA-05', 'REQ-AA-10', 'REQ-AA-17'],
        route: '/sales/dispatches',
        guideStep: 'screen.sales-dispatches',
        permission: PERMISSIONS.SALES_FULFIL,
      },
      {
        kind: 'added',
        title: 'Collections, returns and customer portal links',
        body: 'What is owed and who has been chased, goods coming back, and a link a customer can open without an account.',
        route: '/collections',
        permission: PERMISSIONS.COLLECTIONS_VIEW_SELF,
      },
    ],
  },
  {
    version: '0.11.0',
    date: '2026-08-16',
    entries: [
      {
        kind: 'added',
        title: 'Tally masters arrive on their own',
        body: 'Parties, stock items and price lists pull from Tally on a schedule and stay read-only here — a new customer is created in Tally and appears on the next pull.',
        reqs: ['REQ-R-01', 'REQ-R-04', 'REQ-R-07'],
        route: '/masters/parties',
        guideStep: 'screen.masters-parties',
        permission: PERMISSIONS.MASTERS_TALLY_VIEW,
      },
      {
        kind: 'added',
        title: 'Duplicate parties surfaced rather than merged behind your back',
        body: 'Two ledgers that look like the same customer are listed for a person to decide about.',
        route: '/masters/duplicates',
        permission: PERMISSIONS.DUPLICATES_VIEW,
      },
    ],
  },
  {
    version: '0.10.0',
    date: '2026-08-14',
    entries: [
      {
        kind: 'fixed',
        title: 'A punch made offline no longer counts as absent',
        body: 'A shift punched without a connection computed as ABSENT with zero minutes. It now records what actually happened when the device reconnects.',
        reqs: ['REQ-D-10'],
        route: '/punch',
        guideStep: 'screen.punch',
        permission: PERMISSIONS.PUNCH_SELF,
      },
      {
        kind: 'fixed',
        title: 'A busy moment no longer looks like a failed sign-in',
        body: 'Contention on the login limiter is retried rather than treated as a refusal, and the per-account count is now incremented by the database rather than by the server.',
        reqs: ['REQ-B-04', 'REQ-B-10'],
      },
    ],
  },
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
        body: 'The monthly muster and the summaries payroll needs. This is the hand-off point — no money is calculated here.',
        reqs: ['REQ-J-01'],
        route: '/reports',
        guideStep: 'screen.reports',
        permission: PERMISSIONS.REPORT_VIEW,
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
