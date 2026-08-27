import { PERMISSIONS, type PermissionKey } from '@vyuha/shared';

/**
 * The guided tour, as data.
 *
 * Organised **per screen**, and the whole-product tour is derived from that
 * rather than the other way round. The first version was one flat list, which
 * made the common question — "what is this screen for?" — cost sixteen steps
 * to reach Approvals. A person asks that on the screen they are already
 * looking at, so the screen is the unit and the full tour is the concatenation.
 *
 * Two scopes come out of one registry:
 *
 *   Page  — the intro for this route, plus whatever furniture the route
 *           actually renders. Two to four steps. Reached from Ctrl+F1.
 *   All   — the shell, then one intro per screen the session may open.
 *           Twenty-one steps for an administrator. Reached from the account
 *           menu and from the sign-in offer.
 *
 * Every `permission` is a real key from `ROLE_PERMISSION_MATRIX`, and it is the
 * same set the sidebar and the Go To palette filter on, so the tour cannot
 * point at a screen the person would be refused.
 */
export interface GuideStep {
  id: string;
  /** Navigated to before the step draws. Omitted means "stay where you are". */
  route?: string;
  /**
   * For a screen reached with an id in the path, e.g. `/sales/orders/:id`.
   * Matched segment by segment, with `:name` matching any single segment.
   * A screen with both keeps `route` as the one the tour navigates to.
   */
  routePattern?: string;
  /** Matched as `[data-guide="…"]`. See ANCHORS below. */
  anchor: string;
  /** Used instead of `anchor` below the 768px breakpoint. */
  mobileAnchor?: string;
  title: string;
  body: string;
  /** Preferred side. The positioner may flip it to avoid a collision. */
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** Skipped entirely when the session does not hold it. */
  permission?: PermissionKey;
  /** Rendered as a hint chip inside the bubble. */
  shortcut?: string;
  /** Documented alias for a browser-reserved key (PRD §6.4). */
  shortcutAlias?: string;
  /** Skipped on a phone when there is no `mobileAnchor` to fall back to. */
  mobileBehaviour?: 'skip';
  /**
   * True for a step describing a piece of the shared kit rather than a screen.
   * These appear only in the page scope: repeating "this is the table" on
   * sixteen screens is what would make the full tour unbearable.
   */
  furniture?: boolean;
}

/**
 * Every anchor the registry can name.
 *
 * Deliberately small, and deliberately on shared components rather than on
 * individual screens. `screen.header` sits on the one `PageHeader` all
 * twenty-nine screens render; `screen.table`, `screen.search` and
 * `screen.pagination` sit on the shared kit those screens are built from. So a
 * page guide gets real depth without eighteen screens each carrying their own
 * attributes to lose in a refactor.
 */
export const ANCHORS = {
  navGroups: 'nav.groups',
  navBottomBar: 'nav.bottom-bar',
  headerGoto: 'header.goto',
  headerPageGuide: 'header.page-guide',
  headerShortcuts: 'header.shortcuts',
  headerBreadcrumb: 'header.breadcrumb',
  headerAccount: 'header.account',
  screenHeader: 'screen.header',
  screenDocument: 'screen.document',
  screenSearch: 'screen.search',
  screenTable: 'screen.table',
  screenTableCards: 'screen.table-cards',
  screenPagination: 'screen.pagination',
} as const;

/**
 * The anchors that must resolve to exactly one element wherever the shell is
 * rendered. The rest belong to screen furniture, which is legitimately absent
 * on some routes and may legitimately appear more than once on others — a
 * screen with two tables highlights the first, which is honest rather than
 * wrong.
 */
export const SHELL_ANCHORS: readonly string[] = [
  ANCHORS.navGroups,
  ANCHORS.navBottomBar,
  ANCHORS.headerGoto,
  ANCHORS.headerPageGuide,
  ANCHORS.headerShortcuts,
  ANCHORS.headerBreadcrumb,
  ANCHORS.headerAccount,
  ANCHORS.screenHeader,
];

/**
 * Bumped when the shape of the tour changes enough that a stored resume point
 * is no longer meaningful. Adding copy does not count; removing or reordering
 * steps does.
 */
export const REGISTRY_VERSION = 3;

/** Where everything is, and how to move around. Shown to everyone. */
const SHELL_STEPS: GuideStep[] = [
  {
    id: 'shell.nav',
    anchor: ANCHORS.navGroups,
    mobileAnchor: ANCHORS.navBottomBar,
    side: 'right',
    title: 'Everything lives here',
    body: 'Grouped by what you are doing. You only see what your role allows, so this list is shorter for some people than others.',
  },
  {
    id: 'shell.goto',
    anchor: ANCHORS.headerGoto,
    side: 'bottom',
    shortcut: 'alt+g',
    title: 'Go to',
    body: 'The fast path. Press Alt+G anywhere and type the first few letters of a screen.',
  },
  {
    id: 'shell.page-guide',
    anchor: ANCHORS.headerPageGuide,
    side: 'bottom',
    title: 'What is this screen?',
    body: 'Walks you through whichever screen you are on — two or three steps, not the whole product. It is here on every screen, including on a phone.',
  },
  {
    id: 'shell.shortcuts',
    anchor: ANCHORS.headerShortcuts,
    side: 'bottom',
    shortcut: 'ctrl+f1',
    shortcutAlias: 'f1',
    // The control is desktop-only and there is no keyboard on a phone to hint
    // at, so this is skipped rather than re-anchored to something unrelated.
    mobileBehaviour: 'skip',
    title: 'Every key, and this screen explained',
    body: 'The shortcut sheet lists what is active here, and offers a walk through the screen you are on rather than the whole product.',
  },
  {
    id: 'shell.breadcrumb',
    anchor: ANCHORS.headerBreadcrumb,
    side: 'bottom',
    title: 'Where you are',
    body: 'The page always names itself here, so you never have to guess which screen you landed on.',
  },
  {
    id: 'shell.account',
    anchor: ANCHORS.headerAccount,
    side: 'bottom',
    title: 'Your account',
    body: 'Theme, your profile, updates, and the way out. The full tour lives here too if you want it again.',
  },
];

/**
 * One intro per screen: what it is for, in a sentence or two.
 *
 * This is the step that appears in both scopes — first in a page guide, and as
 * the screen's single entry in the whole-product tour.
 */
const SCREEN_INTROS: GuideStep[] = [
  {
    id: 'screen.dashboard',
    route: '/dashboard',
    anchor: ANCHORS.screenHeader,
    // No permission: everyone lands here, and a landing screen nobody can be
    // guided through is the one gap people notice first.
    title: 'Dashboard',
    body: 'Where your day starts: what is outstanding, what needs a decision, and how the month is tracking so far.',
  },
  {
    id: 'screen.punch',
    route: '/punch',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.PUNCH_SELF,
    title: 'Punch',
    body: 'In and out, with a live photo every time. The half-day choice is offered on the way in, not afterwards.',
  },
  {
    id: 'screen.my-attendance',
    route: '/my-attendance',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.ATTENDANCE_VIEW_SELF,
    title: 'My attendance',
    body: 'Your month, day by day. Open a day to see the punches behind it and raise a correction if something looks wrong.',
  },
  {
    id: 'screen.my-leave',
    route: '/my-leave',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.LEAVE_APPLY_SELF,
    title: 'My leave',
    body: 'Apply, and track where an application has reached. Balances are shown against each type before you commit to a date.',
  },
  {
    id: 'screen.team-attendance',
    route: '/team-attendance',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.ATTENDANCE_VIEW_TEAM,
    title: 'Team attendance',
    body: 'One row per person for the day, with the exceptions surfaced rather than buried.',
  },
  {
    id: 'screen.approvals',
    route: '/approvals',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.LEAVE_APPROVE_TEAM,
    title: 'Approvals',
    body: 'Everything waiting on you, in one queue. A decision always asks for a reason and always writes to the audit log.',
  },
  {
    id: 'screen.team-leave',
    route: '/team-leave',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.LEAVE_APPROVE_TEAM,
    title: 'Team leave',
    body: 'Who is away and when, across the people reporting to you, so a decision on one application is made knowing about the others.',
  },
  {
    id: 'screen.tasks',
    route: '/tasks',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.CRM_TASK_VIEW_SELF,
    title: 'My tasks',
    body: 'What has been assigned to you and what falls due next.',
  },
  {
    id: 'screen.organisation',
    route: '/organisation',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.EMPLOYEE_VIEW,
    title: 'Organisation',
    body: 'Departments, designations and locations — the master data every employee record points at. A location also decides where a punch may be made from.',
  },
  {
    id: 'screen.employees',
    route: '/employees',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.EMPLOYEE_VIEW,
    title: 'Employees',
    body: 'The people register. Nobody is ever deleted — a leaver is retired with a last working day, so past reports still add up.',
  },
  {
    id: 'screen.shifts',
    route: '/shifts',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.SHIFT_MANAGE,
    title: 'Shifts and rosters',
    body: 'Timings, grace, and weekly-off patterns. What you set here is what the day engine measures a punch against.',
  },
  {
    id: 'screen.leave-types',
    route: '/leave-types',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.LEAVE_POLICY_MANAGE,
    title: 'Leave types',
    body: 'Entitlement, carry-forward and notice rules per type. Changing a rule here does not rewrite leave already taken.',
  },
  {
    id: 'screen.holidays',
    route: '/holidays',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.HOLIDAY_MANAGE,
    title: 'Holidays',
    body: 'The calendar the day engine treats as non-working. No dates ship assumed, so this starts empty on purpose.',
  },
  {
    id: 'screen.recycle-bin',
    route: '/recycle-bin',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.EMPLOYEE_MANAGE,
    title: 'Recycle bin',
    body: 'Nothing in this product is hard deleted, so what was removed is recoverable from here rather than gone.',
  },
  {
    id: 'screen.analytics',
    route: '/analytics',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.ATTENDANCE_VIEW_TEAM,
    title: 'Analytics',
    body: 'Trends across the team rather than a single month: attendance, lateness and leave, read as shapes instead of rows.',
  },
  {
    id: 'screen.interest-overrides',
    route: '/interest-overrides',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.INTEREST_CONFIGURE,
    title: 'Interest overrides',
    body: 'Per-party credit days and rates where they differ from Tally. What is set here reprices the interest series on the next build.',
  },
  {
    id: 'screen.downloads',
    route: '/downloads',
    anchor: ANCHORS.screenHeader,
    title: 'Downloads',
    body: 'An export runs as a job rather than holding the screen. Start it, carry on working, and collect the file here.',
  },
  {
    id: 'screen.reports',
    route: '/reports',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.REPORT_VIEW,
    title: 'Reports',
    body: 'Headline figures across every area your permissions open, each with the way into its own page.',
  },
  {
    id: 'screen.reports-attendance',
    route: '/reports/attendance',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.ATTENDANCE_VIEW_ALL,
    title: 'Attendance report',
    body: 'Who was in, who was late and the overtime credited, day by day over the period you pick.',
  },
  {
    id: 'screen.reports-receivables',
    route: '/reports/receivables',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.RECEIVABLES_VIEW,
    title: 'Receivables report',
    body: 'Invoiced against received, straight from the Tally vouchers, with the parties behind the figures.',
  },
  {
    id: 'screen.reports-sales',
    route: '/reports/sales',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.SALES_DOCUMENT_VIEW_ALL,
    title: 'Sales & purchase report',
    body: 'Orders and invoices by value, estimates and purchase orders by where each stands.',
  },
  {
    id: 'screen.reports-sync',
    route: '/reports/sync',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.INTEGRATION_MANAGE,
    title: 'Sync health',
    body: 'Jobs finishing, exceptions raised, and how fresh the last pull from Tally is.',
  },
  {
    id: 'screen.reports-sales-analysis',
    route: '/reports/sales-analysis',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.CFO_SALES_VIEW,
    title: 'Sales analysis',
    body: 'One sales engine at every scope: drill from the company into a brand, a person, a customer or a product, and climb back by the breadcrumb.',
  },
  {
    id: 'screen.reports-penetration',
    route: '/reports/penetration',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.CFO_SALES_VIEW,
    title: 'Penetration',
    body: 'Customer by category: a filled cell is what they buy from us, an empty one is what they buy from someone else.',
  },
  {
    id: 'screen.reports-growth',
    route: '/reports/growth',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.CFO_SALES_VIEW,
    title: 'Growth',
    body: 'Where the change came from — volume, price, mix, new and lost customers — and the matrix naming who it happened to.',
  },
  {
    id: 'screen.reports-team',
    route: '/reports/team',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.CFO_SALES_VIEW,
    title: 'Sales team',
    body: 'The league table: every book priced the same way, against the month\u2019s target.',
  },
  {
    id: 'screen.reports-desk',
    route: '/reports/desk',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.CFO_SALES_VIEW,
    title: "Director's desk",
    body: 'Which customers to work on today: one ranked list with a reason, the rupees at stake and an owner, and the call sheet behind each name.',
  },
  {
    id: 'screen.reports-data-quality',
    route: '/reports/data-quality',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.CFO_EXCEPTIONS_VIEW,
    title: 'Data quality',
    body: 'What the figures are built on and where they are weak: twelve checks, each with its fix and the records behind it.',
  },
  {
    id: 'screen.reports-definitions',
    route: '/reports/definitions',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.CFO_SALES_VIEW,
    title: 'Definitions',
    body: 'Every metric\u2019s meaning, formula, source and version in one place; the info icon beside a figure opens the same panel.',
  },
  {
    id: 'screen.reports-me',
    route: '/reports/me',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.CFO_SALES_VIEW,
    title: 'My CFO',
    body: 'Your own book: sales against last year, collections, the overdue money, and every customer behind it.',
  },
  {
    id: 'screen.reports-credit',
    route: '/reports/credit',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.CFO_RECEIVABLES_VIEW,
    title: 'Credit control',
    body: 'The receivable book as its measures: DSO, days late, the collection score, and whose delay costs the most.',
  },
  {
    id: 'screen.reports-class-grade',
    route: '/reports/class-grade',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.CFO_RECEIVABLES_VIEW,
    title: 'Class and grade',
    body: 'How important a customer is to you against how they pay. Key accounts paying late sit in one cell, in one number.',
  },
  {
    id: 'screen.reports-work-lists',
    route: '/reports/work-lists',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.CFO_SALES_VIEW,
    title: 'Work lists',
    body: 'Who to call, for how much, and why — the credit ladder and the recovery lists, each row one task away from the board.',
  },
  {
    id: 'screen.reports-custom',
    route: '/reports/custom',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.REPORT_VIEW,
    title: 'Custom reports',
    body: 'Compose your own report from the area metrics; it stays yours until you mark it shared.',
  },
  {
    id: 'screen.period-lock',
    route: '/period-lock',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.ATTENDANCE_LOCK,
    title: 'Period lock',
    body: 'Close a month once its numbers have gone to payroll. After that no punch or edit can change it.',
  },
  {
    id: 'screen.settings',
    route: '/settings',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.SETTINGS_MANAGE,
    title: 'Settings',
    body: 'Organisation, attendance policy and photo rules, in four tabs behind one Save. Each field says whether anything reads it yet.',
  },
  {
    id: 'screen.roles',
    route: '/roles',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.ROLES_MANAGE,
    title: 'Roles and permissions',
    body: 'Roles are named bundles of permissions, not fixed job titles. Nothing in the product branches on a role name.',
  },
  {
    id: 'screen.integrations',
    route: '/integrations',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.INTEGRATION_MANAGE,
    title: 'Integrations',
    body: 'Where outbound connections are configured, including the TallyPrime link when it arrives.',
  },
  {
    id: 'screen.audit',
    route: '/audit',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.AUDIT_VIEW,
    title: 'Audit log',
    body: 'Every state-changing action, who did it and why. Append-only — nothing in the product can edit a row here.',
  },
];

/**
 * The shared kit, described once and shown wherever it appears.
 *
 * Every screen in this product is built from the same handful of components,
 * so these steps do not need writing per screen — they need including only
 * when the screen in front of you actually renders them. Which is decided at
 * run time by looking, not by a list somebody has to keep in step.
 */
const FURNITURE_STEPS: GuideStep[] = [
  {
    id: 'furniture.search',
    anchor: ANCHORS.screenSearch,
    furniture: true,
    title: 'Search this screen',
    body: 'Filters the list as you type. It searches the records behind the screen, not just the rows currently shown.',
  },
  {
    id: 'furniture.table',
    anchor: ANCHORS.screenTable,
    // The desktop table and the phone's card list are both always in the DOM,
    // with CSS deciding which is visible — so the guide has to choose by width
    // rather than by presence, exactly as it does for the two navigations.
    mobileAnchor: ANCHORS.screenTableCards,
    furniture: true,
    title: 'The records',
    body: 'Sortable by column, and every row opens a detail panel. On a phone each row collapses to a card rather than scrolling sideways.',
  },
  {
    id: 'furniture.pagination',
    anchor: ANCHORS.screenPagination,
    furniture: true,
    title: 'Moving through the list',
    body: 'Page Up and Page Down work here too, so a long register can be read without reaching for the mouse.',
  },
];

/**
 * Phase 6–8: the Tally masters, CRM and the sales / purchase flow.
 *
 * Kept as its own list rather than mixed into the attendance screens above,
 * because the module boundary is real (CLAUDE.md §2) and a CRM tour should be
 * liftable without picking attendance steps out of it. The copy is drawn from
 * the REQ IDs each screen carries in `lib/nav.ts`, not invented: masters are
 * read-only because REQ-R-04 says so, a deal never reaches Tally because
 * REQ-U-05 says so, and sync state is reported rather than inferred because
 * REQ-W-06 says so.
 */
const TRADING_INTROS: GuideStep[] = [
  {
    id: 'screen.masters-parties',
    route: '/masters/parties',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.MASTERS_TALLY_VIEW,
    title: 'Parties',
    body: 'Customers and suppliers as Tally holds them, with credit limit and credit days. Read-only here — a new party is created in Tally and appears on the next pull (REQ-R-04).',
  },
  {
    id: 'screen.masters-items',
    route: '/masters/items',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.MASTERS_TALLY_VIEW,
    title: 'Stock items',
    body: 'Items pulled from Tally with their unit, group and GST rate. Also read-only, and for the same reason.',
  },
  {
    id: 'screen.masters-price-lists',
    route: '/masters/price-lists',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.MASTERS_TALLY_VIEW,
    title: 'Price lists',
    body: "Vyuha's own price lists: versioned, approved into force, and the floor on every sales line. The simulator beside them answers \"why this rate\" for any party and item.",
  },
  {
    id: 'screen.regularizations',
    route: '/regularizations',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.PUNCH_SELF,
    title: 'Corrections',
    body: 'Ask for a day to be corrected — a missed punch, a wrong time, a day spent on site. It goes to your approver with the reason you give; the approver\'s side is a band on Approvals.',
  },
  {
    id: 'screen.sales-returns',
    route: '/sales/returns',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.RETURNS_VIEW,
    title: 'Returns',
    body: 'Goods that came back: how many, why, in what state, and where they went next. Vyuha raises no credit note — each receipt waits for Tally\'s, and a restocked line rises in Tally rather than here.',
  },
  {
    id: 'screen.collections',
    route: '/collections',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.COLLECTIONS_VIEW_SELF,
    title: 'Collections',
    body: 'Who owes what, how much of it is late, and what each customer promised. A promise is never marked kept here: the receipts Tally sends decide it, and a broken one flags the credit check without blocking an order.',
  },
  {
    id: 'screen.portal-links',
    route: '/masters/portal-links',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.PORTAL_MANAGE,
    title: 'Customer links',
    body: 'One read-only link per customer, showing them their own orders, dispatches, invoices and statement. There is no customer sign-in: the link is the credential, so it is shown once, lasts ninety days, and can be withdrawn the moment it should stop working.',
  },
  {
    id: 'screen.masters-duplicates',
    route: '/masters/duplicates',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.DUPLICATES_VIEW,
    title: 'Duplicates',
    body: 'Parties and items Tally holds twice, found after each pull and ranked by what they split. Mark a cluster sent to Tally or genuinely different; the merge itself happens in Tally.',
  },
  {
    id: 'screen.masters-vouchers',
    route: '/masters/vouchers',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.RECEIVABLES_VIEW,
    title: 'Vouchers',
    body: 'Everything backfilled from Tally, across every financial year in scope. This is the history the rest of the module reads from.',
  },
  {
    id: 'screen.masters-voucher-paper',
    routePattern: '/masters/vouchers/:id/paper',
    anchor: ANCHORS.screenDocument,
    permission: PERMISSIONS.RECEIVABLES_VIEW,
    title: 'The voucher on paper',
    body: "Tally's figures on this organisation's own design: fit to the screen, PDF through the print dialog, Excel. Nothing here writes back to Tally.",
  },
  {
    id: 'screen.crm-contacts',
    route: '/crm/contacts',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.CRM_CONTACT_VIEW_SELF,
    title: 'Contacts',
    body: 'People, with their company and owner. Creating one warns about a duplicate phone or email rather than blocking you (REQ-U-08).',
  },
  {
    id: 'screen.crm-companies',
    route: '/crm/companies',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.CRM_CONTACT_VIEW_SELF,
    title: 'Companies',
    body: 'Prospect organisations. A company becomes a Tally party only on conversion — a prospect who never buys must not become a ledger.',
  },
  {
    id: 'screen.crm-deals',
    route: '/crm/deals',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.CRM_DEAL_VIEW_SELF,
    title: 'Deals',
    body: 'The pipeline, whose stages are configurable rather than fixed. A deal has no accounting existence and is never pushed to Tally; opening a won one shows the documents raised against it.',
  },
  {
    id: 'screen.sales-estimates',
    route: '/sales/estimates',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
    title: 'Estimates',
    body: 'A quote, owned here and never pushed to Tally. Picking an item shows what that party was quoted and invoiced before — the reason the backfill is worth its cost (REQ-W-02).',
  },
  {
    id: 'screen.sales-orders',
    route: '/sales/orders',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
    title: 'Sales orders',
    body: 'Raised fresh or converted from an estimate. Every pushed document shows a sync state that is reported by the agent, never inferred — a document claiming "In Tally" that is not there is the failure that ends trust.',
  },
  {
    id: 'screen.sales-pick-queue',
    route: '/sales/pick-queue',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
    title: 'Pick queue',
    body: 'What is waiting to be picked. Built to work one-handed at 360px, because a picker is holding a box (REQ-AA-10).',
  },
  {
    id: 'screen.sales-awaiting-invoice',
    route: '/sales/awaiting-invoice',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
    title: 'Awaiting invoice',
    body: 'Picked and ready to bill. The gap between the warehouse finishing and accounts raising the invoice, made visible instead of assumed.',
  },
  {
    id: 'screen.sales-invoices',
    route: '/sales/invoices',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
    title: 'Invoices',
    body: 'Where invoices are raised here they push as a Sales voucher; where Tally owns them they are pull-only.',
  },
  {
    id: 'screen.sales-dispatches',
    route: '/sales/dispatches',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
    title: 'Dispatches',
    body: 'How each consignment leaves: local by carrier, on your own vehicle, or outstation. What is still in transit lives here.',
  },
  {
    id: 'screen.sales-delivered',
    route: '/sales/delivered',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
    title: 'Delivered',
    body: 'Every dispatch the customer has signed for, newest first. A consignment arrives here when its slip is scanned and marked delivered at the door.',
  },
  {
    id: 'screen.sales-packed',
    route: '/sales/packed',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
    title: 'Packed',
    body: 'Every pack across your orders, newest first, with its slips one tap away. This is where a box waits between packing and the door.',
  },
  {
    id: 'screen.sales-scan',
    route: '/sales/scan',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.SALES_DOCUMENT_CREATE,
    title: 'Scan a slip',
    body: 'Point the camera at the barcode on a packing slip. It opens the pack: ship it with the LR number and photographs, or mark it delivered at the door.',
  },
  {
    id: 'screen.purchase-requirements',
    route: '/purchase/requirements',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.PURCHASE_DOCUMENT_VIEW,
    title: 'Requirements',
    body: 'What is short and needs buying. Requirements are records rather than a flag on an order, because one purchase order may satisfy several and one requirement may be split across several orders.',
  },
  {
    id: 'screen.purchase-orders',
    route: '/purchase/orders',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.PURCHASE_DOCUMENT_VIEW,
    title: 'Purchase orders',
    body: 'Raised on a vendor, standalone for stock or against a sales order so the requirement carries through. Open orders are visible per vendor and per sales order.',
  },
  {
    id: 'screen.purchase-grns',
    route: '/purchase/grns',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.PURCHASE_DOCUMENT_VIEW,
    title: 'Goods receipts',
    body: 'What actually arrived against what was ordered, which is where a short or excess delivery is caught.',
  },
];

/**
 * Screens reached with something in the path, or from somewhere other than the
 * sidebar.
 *
 * These are the ones the header pin used to do nothing on. They are not in
 * `lib/nav.ts`, so the coverage test that reads the navigation could not see
 * them — a detail page, a document editor and the account screens are all
 * routed, all wear the shell, and all offered a button that silently did
 * nothing when pressed.
 */
const DETAIL_INTROS: GuideStep[] = [
  {
    id: 'screen.employee-detail',
    routePattern: '/employees/:id',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.EMPLOYEE_VIEW,
    title: 'This employee',
    body: 'Everything on record for one person, and their attendance read as a trend rather than a list of days.',
  },
  {
    id: 'screen.administration',
    route: '/administration',
    anchor: ANCHORS.screenHeader,
    permission: PERMISSIONS.SETTINGS_MANAGE,
    title: 'Administration',
    body: 'Settings, people and records that belong to the whole workspace rather than to one module.',
  },
  {
    id: 'screen.notifications',
    route: '/notifications',
    anchor: ANCHORS.screenHeader,
    title: 'Notifications',
    body: 'Everything the product has told you, newest first. The bell in the header carries the unread count.',
  },
  {
    id: 'screen.profile',
    route: '/profile',
    anchor: ANCHORS.screenHeader,
    title: 'Your profile',
    body: 'Your own record and sign-in details. Changing what an employee record says about you is HR’s to do, not yours.',
  },
  {
    id: 'screen.updates',
    route: '/updates',
    anchor: ANCHORS.screenHeader,
    title: 'Updates',
    body: 'What changed in the product and when, with a way into the screen each change touched.',
  },
  /*
   * The document screens: four editors and three paper views.
   *
   * One step serves all seven because all seven render `DocumentEditor`, and
   * none of them renders a `PageHeader` — so `screen.header` is absent and the
   * toolbar is the anchor instead. Separate entries only because each one
   * navigates from a different list.
   */
  {
    id: 'screen.estimate-editor',
    routePattern: '/sales/estimates/:id',
    anchor: ANCHORS.screenDocument,
    permission: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
    title: 'Writing an estimate',
    body: 'The document as it will be read. Picking an item shows what this party was quoted and invoiced before, and nothing here reaches Tally.',
  },
  {
    id: 'screen.sales-order-editor',
    routePattern: '/sales/orders/:id',
    anchor: ANCHORS.screenDocument,
    permission: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
    title: 'Writing a sales order',
    body: 'Once accepted this is read-only except through an explicit Alter, which re-pushes against the stored GUID rather than creating a second voucher.',
  },
  {
    id: 'screen.invoice-editor',
    routePattern: '/sales/invoices/:id',
    anchor: ANCHORS.screenDocument,
    permission: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
    title: 'The invoice',
    body: 'What the customer receives. The sync state shown here is reported by the agent, never inferred.',
  },
  {
    id: 'screen.purchase-order-editor',
    routePattern: '/purchase/orders/:id',
    anchor: ANCHORS.screenDocument,
    permission: PERMISSIONS.PURCHASE_DOCUMENT_VIEW,
    title: 'Writing a purchase order',
    body: 'Raised on a vendor, standalone or against a sales order so the requirement carries through.',
  },
  {
    id: 'screen.packing-slip',
    routePattern: '/sales/packs/:id',
    anchor: ANCHORS.screenDocument,
    permission: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
    title: 'Packing slip',
    body: 'What goes in the box, as the person packing it needs to read it.',
  },
  {
    id: 'screen.dispatch-paper',
    routePattern: '/sales/dispatches/:id',
    anchor: ANCHORS.screenDocument,
    permission: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
    title: 'Dispatch note',
    body: 'The consignment as it leaves, ready to print and to travel with the goods.',
  },
  {
    id: 'screen.grn-paper',
    routePattern: '/purchase/grns/:id',
    anchor: ANCHORS.screenDocument,
    permission: PERMISSIONS.PURCHASE_DOCUMENT_VIEW,
    title: 'Goods receipt',
    body: 'What arrived against what was ordered, which is where a short or excess delivery is caught.',
  },
];

/** Everything, in sidebar order. The whole-product tour. */
/*
 * The whole-product tour is the sidebar, and only the sidebar.
 *
 * Detail pages, document editors and the account screens are deliberately not
 * in it: a tour that stopped on "writing a sales order" between two list
 * screens would be describing somewhere you cannot get to from where you are.
 * They are reachable through the page guide, which is where they belong.
 */
export const MAIN_TOUR: GuideStep[] = [...SHELL_STEPS, ...SCREEN_INTROS, ...TRADING_INTROS];

/** Every screen the guide can introduce, whether or not the sidebar lists it. */
const EVERY_INTRO: GuideStep[] = [...SCREEN_INTROS, ...TRADING_INTROS, ...DETAIL_INTROS];

/** Every step the registry can produce, in either scope. */
export const ALL_STEPS: GuideStep[] = [
  ...SHELL_STEPS,
  ...SCREEN_INTROS,
  ...TRADING_INTROS,
  ...DETAIL_INTROS,
  ...FURNITURE_STEPS,
];

/** The intro for a route, if it has one. */
/** `/sales/orders/:id` against `/sales/orders/abc123`. */
function patternMatches(pattern: string, path: string): boolean {
  const a = pattern.split('/');
  const b = path.split('/');
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg.startsWith(':') || seg === b[i]);
}

/**
 * The intro **declared** for a route, exactly.
 *
 * Strict on purpose. This is what the coverage test asks, and a lookup that
 * quietly fell back to a parent would let a screen ship with no guide of its
 * own while the test reported it covered.
 */
export function introFor(route: string): GuideStep | undefined {
  // A nav link may carry a query (the report catalogue's categories); the
  // screen it lands on — and therefore its guide — is the pathname's.
  const pathname = route.split('?')[0] ?? route;
  return (
    EVERY_INTRO.find((step) => step.route === pathname) ??
    EVERY_INTRO.find((step) => step.routePattern && patternMatches(step.routePattern, pathname))
  );
}

/**
 * The intro to actually use for a path the browser is on.
 *
 * Forgiving where `introFor` is strict, and the difference is deliberate.
 * Several screens render the same component for the list and for one selected
 * row — `/crm/deals` and `/crm/deals/abc` are the same page with a panel open —
 * so rather than declare a near-duplicate entry for each, an unmatched path
 * falls back to its parent. `/sales/orders/new` still gets the editor's own
 * entry, because an explicit match is tried first.
 */
export function introForPath(pathname: string): GuideStep | undefined {
  const direct = introFor(pathname);
  if (direct) return direct;

  const parent = pathname.replace(/\/[^/]+$/u, '');
  return parent && parent !== pathname ? introFor(parent) : undefined;
}

/** Every route the tour knows how to introduce. */
export function guidedRoutes(): string[] {
  return EVERY_INTRO.map((step) => step.route ?? step.routePattern).filter(
    (r): r is string => Boolean(r),
  );
}

function permitted(step: GuideStep, granted: ReadonlySet<PermissionKey>): boolean {
  return !step.permission || granted.has(step.permission);
}

function usableAtWidth(step: GuideStep, isMobile: boolean): boolean {
  return !(isMobile && step.mobileBehaviour === 'skip' && !step.mobileAnchor);
}

/**
 * The whole-product tour, filtered to this session.
 *
 * Filtered rather than disabled: a step pointing at a screen the person cannot
 * open has nothing to say to them, and counting it would make the tour promise
 * a step that never arrives.
 */
export function resolveSteps(
  granted: ReadonlySet<PermissionKey>,
  isMobile: boolean,
): GuideStep[] {
  return MAIN_TOUR.filter((step) => permitted(step, granted) && usableAtWidth(step, isMobile));
}

/**
 * The guide for one screen: its intro, then whatever furniture it renders.
 *
 * `isPresent` is injected rather than assumed so this stays a pure function —
 * the caller passes a DOM probe in the app and a stub in a test. Furniture is
 * decided by looking at the page rather than by a per-route list, because a
 * list of "which screens have a table" is a second source of truth that would
 * quietly go stale the first time a screen gained one.
 *
 * Returns an empty array for a route with no intro — the caller offers the
 * whole tour instead of running a guide about nothing.
 */
export function resolvePageSteps(
  route: string,
  granted: ReadonlySet<PermissionKey>,
  isMobile: boolean,
  isPresent: (anchor: string) => boolean,
): GuideStep[] {
  const intro = introForPath(route);
  if (!intro || !permitted(intro, granted)) return [];

  const furniture = FURNITURE_STEPS.filter(
    (step) => usableAtWidth(step, isMobile) && isPresent(step.anchor),
  );

  // The intro keeps its route so a page guide started from elsewhere still
  // navigates, but in the normal case the caller is already here.
  return [intro, ...furniture];
}

/** The anchor a step wants at this width. */
export function anchorFor(step: GuideStep, isMobile: boolean): string {
  return isMobile && step.mobileAnchor ? step.mobileAnchor : step.anchor;
}
