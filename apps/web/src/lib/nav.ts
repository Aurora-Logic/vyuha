import {
  LinkSimpleIcon,
  ArrowUUpLeftIcon,
  AddressBookIcon,
  ArchiveIcon,
  BooksIcon,
  BuildingsIcon,
  CalendarBlankIcon,
  CalendarDotsIcon,
  ChartBarIcon,
  BookOpenTextIcon,
  ChartLineUpIcon,
  GridNineIcon,
  PhoneIcon,
  TrophyIcon,
  HandCoinsIcon,
  UserCircleIcon,
  CheckSquareIcon,
  ClipboardIcon,
  ClipboardTextIcon,
  ClockCounterClockwiseIcon,
  ClockIcon,
  DownloadSimpleIcon,
  FileTextIcon,
  FingerprintIcon,
  GearIcon,
  HandshakeIcon,
  type Icon,
  ListChecksIcon,
  LockIcon,
  PackageIcon,
  PlugIcon,
  ReceiptIcon,
  ScrollIcon,
  ShieldCheckIcon,
  ShoppingCartIcon,
  SquaresFourIcon,
  TagIcon,
  TrashIcon,
  TreePalmIcon,
  ScanIcon,
  UmbrellaIcon,
  UsersIcon,
  UsersThreeIcon,
  BarcodeIcon,
  CheckCircleIcon,
  ReceiptXIcon,
  TruckIcon,
  CopyIcon,
} from '@phosphor-icons/react';

import { PERMISSIONS, type PermissionKey } from '@vyuha/shared';

export interface NavItem {
  to: string;
  label: string;
  /**
   * Shorter name for the phone's bottom bar, where a tab gets a fifth of
   * 360px. Falls back to `label`. "My attend..." tells the reader nothing the
   * icon had not already said, so the tab gets a word that fits instead.
   */
  shortLabel?: string;
  icon: Icon;
  /** Sidebar items are permission-filtered (PRD §6.1). Undefined means always. */
  permission?: PermissionKey;
  /** Phase the screen ships in, shown on the placeholder until it is built. */
  phase: number;
  /** REQ IDs the screen implements, per the PRD §5 screen inventory. */
  reqs: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * A module owns a sidebar; the workspace owns everything else (REQ-O-01).
 *
 * Adding CRM is an entry in `MODULES` rather than an edit to the sidebar
 * component, which is the point: `09` §6 says a module registers itself, and a
 * component that grew a branch per module is how the nineteen-item sidebar
 * happened in the first place.
 */
export interface ModuleDef {
  id: string;
  label: string;
  icon: Icon;
  /** Where `Ctrl+G` lands when this module is chosen. */
  home: string;
  /** The phone bottom bar's default four, in order, when nobody has customised it: the screens held in a hand on the floor, not the office's. Absent = the module's first four. */
  readonly phoneBar?: readonly string[];
  /** Undefined means every signed-in account sees it. */
  permission?: PermissionKey;
  groups: NavGroup[];
}

/**
 * PRD §6.1 navigation model. Alt+G is the faster path and is advertised in the
 * UI, but the sidebar remains the discoverable one.
 *
 * This is the Attendance module's sidebar. It is no longer the whole
 * navigation: REQ-O-02 pulled the workspace destinations into `ADMIN_GROUPS`
 * and REQ-O-03 moved Approvals to the top bar, because one audit log and one
 * approvals inbox serve every module and neither belongs inside one of them.
 */
export const NAV_GROUPS: NavGroup[] = [
  // Regrouped at the owner's ask (21 Aug): what is mine, what is my team's,
  // and the people themselves — instead of one eight-item "Work".
  {
    label: 'Me',
    items: [
      // The dashboard moved to the Reports module (owner, 26 Aug 2026); the
      // route stays alive for old links, named in OFF_NAV_LABELS below.
      {
        to: '/punch',
        label: 'Punch',
        icon: FingerprintIcon,
        permission: PERMISSIONS.PUNCH_SELF,
        phase: 1,
        reqs: 'REQ-D-01…D-13',
      },
      {
        to: '/my-attendance',
        label: 'My attendance',
        shortLabel: 'Attendance',
        icon: CalendarDotsIcon,
        permission: PERMISSIONS.ATTENDANCE_VIEW_SELF,
        phase: 1,
        reqs: 'REQ-E-01, E-02',
      },
      {
        to: '/my-leave',
        label: 'My leave',
        shortLabel: 'Leave',
        icon: TreePalmIcon,
        permission: PERMISSIONS.LEAVE_APPLY_SELF,
        phase: 2,
        reqs: 'REQ-G-03, G-06',
      },
    ],
  },
  {
    label: 'Team',
    items: [
      {
        to: '/approvals',
        label: 'Approvals',
        shortLabel: 'Approvals',
        icon: ClipboardTextIcon,
        permission: PERMISSIONS.LEAVE_APPROVE_TEAM,
        phase: 2,
        reqs: 'REQ-I-03',
      },
      {
        to: '/team-attendance',
        label: 'Team attendance',
        shortLabel: 'Team',
        icon: UsersThreeIcon,
        permission: PERMISSIONS.ATTENDANCE_VIEW_TEAM,
        phase: 1,
        reqs: 'REQ-E-02, J-01',
      },
      {
        to: '/regularizations',
        label: 'Corrections',
        shortLabel: 'Fix',
        icon: ClockCounterClockwiseIcon,
        // The raise key, not the approve key: this screen is what a person
        // opens about their own days, and every Employee holds it. The
        // approver's surface is a band on /approvals.
        permission: PERMISSIONS.PUNCH_SELF,
        phase: 2,
        reqs: 'REQ-F-01…F-05',
      },
      {
        to: '/team-leave',
        label: 'Team leave',
        shortLabel: 'Away',
        icon: UmbrellaIcon,
        // The same key Approvals takes: the screen exists to be read *before*
        // a decision, so whoever can decide must be able to reach it. The
        // server scopes what is in it (OPEN-QUESTIONS records that PRD §6.1's
        // Work group now lists six items rather than five).
        permission: PERMISSIONS.LEAVE_APPROVE_TEAM,
        phase: 2,
        reqs: 'REQ-G-12',
      },
    ],
  },
  {
    label: 'People',
    items: [
      {
        to: '/employees',
        label: 'Employees',
        icon: UsersIcon,
        permission: PERMISSIONS.EMPLOYEE_VIEW,
        phase: 1,
        reqs: 'REQ-A-03, A-06',
      },
      {
        to: '/analytics',
        label: 'Analytics',
        icon: ChartLineUpIcon,
        // The team key, not view.all: a manager should see the shape of their
        // own team. The server's scope predicate decides what the numbers are
        // built from, so the same screen answers for a team or the whole
        // organisation without knowing which it is looking at.
        permission: PERMISSIONS.ATTENDANCE_VIEW_TEAM,
        phase: 4,
        reqs: 'REQ-K-01, REQ-J-01',
      },
    ],
  },
];

/**
 * The destinations REQ-O-02 pulls out of every module sidebar.
 *
 * There is one audit log for the whole system, one recycle bin and one set of
 * roles -- CRM will not get copies of them. Reached from the organisation name
 * in the header rather than from a module, because that is what they belong to.
 *
 * "Attendance setup" is the P6a-1 default recorded in `OPEN-QUESTIONS.md`:
 * REQ-O-02's own list leaves 13 destinations against REQ-O-04's cap of 11, and
 * these three are configuration somebody visits when a policy changes rather
 * than work they do during a day. Reverse it by moving them back and raising
 * the cap.
 */
export const ADMIN_GROUPS: NavGroup[] = [
  {
    label: 'Organisation',
    items: [
      {
        to: '/organisation',
        label: 'Organisation',
        shortLabel: 'Org',
        icon: BuildingsIcon,
        // employee.view, not a manage key: the three masters are what an
        // employee list filters by, so anybody who can read the register needs
        // to be able to see them. The screen splits the write keys the way the
        // server does - departments and designations on employee.manage,
        // locations on settings.manage, because a location carries the geofence
        // and the IP allowlist (OPEN-QUESTIONS P1-1).
        permission: PERMISSIONS.EMPLOYEE_VIEW,
        phase: 1,
        reqs: 'REQ-A-01, REQ-A-02',
      },
    ],
  },
  {
    label: 'Attendance setup',
    items: [
      {
        to: '/shifts',
        label: 'Shifts and rosters',
        shortLabel: 'Shifts',
        icon: ClockIcon,
        permission: PERMISSIONS.SHIFT_MANAGE,
        phase: 1,
        reqs: 'REQ-C-01…C-05',
      },
      {
        to: '/leave-types',
        label: 'Leave types',
        icon: CalendarBlankIcon,
        permission: PERMISSIONS.LEAVE_POLICY_MANAGE,
        phase: 2,
        reqs: 'REQ-G-01, G-03',
      },
      {
        to: '/holidays',
        label: 'Holidays',
        icon: CalendarDotsIcon,
        permission: PERMISSIONS.HOLIDAY_MANAGE,
        phase: 2,
        reqs: 'REQ-H-01…H-04',
      },
      {
        to: '/period-lock',

        label: 'Period lock',
        shortLabel: 'Lock',
        icon: LockIcon,
        permission: PERMISSIONS.ATTENDANCE_LOCK,
        phase: 3,
        reqs: 'REQ-E-09',
      },
    ],
  },
  {
    label: 'Workspace',
    items: [

      {
        to: '/settings',
        label: 'Settings',
        icon: GearIcon,
        permission: PERMISSIONS.SETTINGS_MANAGE,
        phase: 4,
        reqs: 'REQ-L-01…L-05',
      },
      {
        to: '/roles',
        label: 'Roles and permissions',
        shortLabel: 'Roles',
        icon: ShieldCheckIcon,
        permission: PERMISSIONS.ROLES_MANAGE,
        phase: 4,
        reqs: 'REQ-B-07',
      },
      {
        to: '/integrations',
        label: 'Integrations',
        icon: PlugIcon,
        permission: PERMISSIONS.INTEGRATION_MANAGE,
        phase: 6,
        reqs: 'Technical design §14',
      },
      {
        to: '/audit',
        label: 'Audit log',
        shortLabel: 'Audit',
        icon: ScrollIcon,
        permission: PERMISSIONS.AUDIT_VIEW,
        phase: 4,
        reqs: 'REQ-M-02',
      },
      {
        to: '/recycle-bin',
        label: 'Recycle bin',
        shortLabel: 'Recycle',
        icon: TrashIcon,
        // REQ-M-04 forbids a hard delete, so everything removed anywhere in the
        // product is recoverable from here. Gated on employee.manage because
        // that is the broadest of the master-management keys; the screen itself
        // filters to the kinds the viewer may actually restore.
        permission: PERMISSIONS.EMPLOYEE_MANAGE,
        phase: 4,
        reqs: 'REQ-M-04, REQ-B-09a',
      },
      {
        to: '/downloads',
        label: 'Downloads',
        icon: DownloadSimpleIcon,
        phase: 3,
        reqs: 'REQ-J-03',
      },
    ],
  },
];

/**
 * REQ-O-03. One inbox across every approvable thing, so it sits above the
 * modules rather than inside one -- a CRM discount and a leave request land in
 * the same place, and `01` already promised that.
 */
export const TOP_BAR_ITEMS: NavItem[] = [
      {
        to: '/approvals',
        label: 'Approvals',
        icon: ClipboardTextIcon,
        permission: PERMISSIONS.LEAVE_APPROVE_TEAM,
        phase: 2,
        reqs: 'REQ-I-03',
      },
];

/**
 * Named rather than inlined in `MODULES` so `findModuleForPath` has a typed
 * fallback without an index into the array — a route no module owns (the
 * workspace screens, /profile, a bad URL) still needs a sidebar behind it.
 */
const ATTENDANCE_MODULE: ModuleDef = {
  id: 'attendance',
  label: 'Attendance',
  icon: CalendarDotsIcon,
  home: '/punch',
  groups: NAV_GROUPS,
};

/** REQ-O-01. One entry per module; the sidebar renders only the current one. */
export const MODULES: ModuleDef[] = [
  ATTENDANCE_MODULE,
  {
    id: 'crm',
    label: 'CRM',
    icon: HandshakeIcon,
    // REQ-V-07: My tasks is the CRM landing screen.
    home: '/tasks',
    // 08 §2.2 gives view.self to everyone who holds view.all, so the narrower
    // key is the module gate: whoever may see any contact may open the module.
    permission: PERMISSIONS.CRM_CONTACT_VIEW_SELF,
    groups: [
      {
        label: 'Work',
        items: [
          {
            to: '/tasks',
            label: 'My tasks',
            shortLabel: 'Tasks',
            icon: CheckSquareIcon,
            permission: PERMISSIONS.CRM_TASK_VIEW_SELF,
            phase: 7,
            reqs: 'REQ-V-01, REQ-V-03, REQ-V-05, REQ-V-07',
          },
        ],
      },
      {
        label: 'Sales',
        items: [
          {
            to: '/crm/deals',
            label: 'Deals',
            icon: HandshakeIcon,
            permission: PERMISSIONS.CRM_DEAL_VIEW_SELF,
            phase: 7,
            reqs: 'REQ-U-04, REQ-U-05, REQ-U-06',
          },
        ],
      },
      {
        label: 'People',
        items: [
          {
            to: '/crm/contacts',
            label: 'Contacts',
            icon: AddressBookIcon,
            permission: PERMISSIONS.CRM_CONTACT_VIEW_SELF,
            phase: 7,
            reqs: 'REQ-U-01, REQ-U-08',
          },
          {
            to: '/crm/companies',
            label: 'Companies',
            icon: BuildingsIcon,
            permission: PERMISSIONS.CRM_CONTACT_VIEW_SELF,
            phase: 7,
            reqs: 'REQ-U-02, REQ-U-03',
          },
        ],
      },
    ],
  },
  {
    id: 'sales',
    label: 'Sales',
    icon: FileTextIcon,
    home: '/sales/estimates',
    // The desk's bar: the documents raised at it, and the masters they are
    // raised against. The floor's bar lives on Logistics.
    phoneBar: ['/sales/orders', '/sales/invoices', '/masters/parties', '/collections'],
    // D-19: no module-level key. Documents, Masters and Books answer to
    // different permissions, and a masters-only account must still see its
    // screens -- the module shows when any item inside it does.
    groups: [
      {
        label: 'Documents',
        items: [
          {
            to: '/sales/estimates',
            label: 'Estimates',
            icon: FileTextIcon,
            permission: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
            phase: 8,
            reqs: 'REQ-W-01, REQ-W-02',
          },
          {
            to: '/sales/orders',
            label: 'Sales orders',
            shortLabel: 'Orders',
            icon: ClipboardIcon,
            permission: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
            phase: 8,
            reqs: 'REQ-W-03, REQ-W-06, REQ-W-07',
          },
          {
            to: '/sales/invoices',
            label: 'Invoices',
            icon: ReceiptIcon,
            permission: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
            phase: 8,
            reqs: 'REQ-AA-11, D-38',
          },
        ],
      },
      {
        label: 'Masters',
        items: [
          {
            to: '/masters/parties',
            label: 'Parties',
            icon: BooksIcon,
            permission: PERMISSIONS.MASTERS_TALLY_VIEW,
            phase: 6,
            reqs: 'REQ-R-01, REQ-R-04',
          },
          {
            to: '/masters/items',
            label: 'Stock items',
            shortLabel: 'Items',
            icon: PackageIcon,
            permission: PERMISSIONS.MASTERS_TALLY_VIEW,
            phase: 6,
            reqs: 'REQ-R-02',
          },
          {
            to: '/masters/price-lists',
            label: 'Price lists',
            shortLabel: 'Prices',
            icon: TagIcon,
            permission: PERMISSIONS.MASTERS_TALLY_VIEW,
            phase: 6,
            reqs: 'docs/15 REQ-AN-01…18',
          },
        ],
      },
      {
        label: 'Books',
        items: [
          {

            to: '/collections',

            label: 'Collections',

            shortLabel: 'Collect',

            icon: HandshakeIcon,

            permission: PERMISSIONS.COLLECTIONS_VIEW_SELF,

            phase: 8,

            reqs: 'docs/15 REQ-AJ-01…13',

          },
          {
            to: '/masters/portal-links',
            label: 'Customer links',
            shortLabel: 'Links',
            icon: LinkSimpleIcon,
            // Accounts and Admin hold it; the panel on a party page is the
            // other way in, for when you already have the customer open.
            permission: PERMISSIONS.PORTAL_MANAGE,
            phase: 9,
            reqs: 'docs/15 REQ-AL-01, REQ-AL-03, REQ-AL-07',
          },
          {

            to: '/masters/duplicates',

            label: 'Duplicates',

            shortLabel: 'Dupes',

            icon: CopyIcon,

            permission: PERMISSIONS.DUPLICATES_VIEW,

            phase: 9,

            reqs: 'docs/15 REQ-AO-10',

          },
          {
            to: '/masters/vouchers',
            label: 'Vouchers',
            icon: ReceiptIcon,
            // Money moving, not a master: 08 §2.2's receivables key.
            permission: PERMISSIONS.RECEIVABLES_VIEW,
            phase: 6,
            reqs: 'REQ-S-01, REQ-Y-06',
          },
        ],
      },

    ],
  },
  {
    id: 'logistics',
    label: 'Logistics',
    icon: TruckIcon,
    home: '/sales/pick-queue',
    // Owner, 22 Aug: the phone is the floor's device - the process is what it carries.
    phoneBar: ['/sales/pick-queue', '/sales/packed', '/sales/scan', '/sales/dispatches'],
    // D-19: fulfilment is a different person at a different bench, and its
    // seven destinations were crowding the Sales sidebar toward D-16's cap.
    // The group keeps its name so every breadcrumb under it stays put.
    groups: [
      {
        label: 'Fulfilment',
        items: [
          // Owner, 22 Aug 2026: each stage is its own entry -- "we don't need
          // one Fulfilment option" -- and Delivered is among them so it can be
          // found. The strip on each screen (features/sales/fulfilment-tabs)
          // still says where you are and what waits.
          {
            to: '/sales/pick-queue',
            label: 'Pick queue',
            shortLabel: 'Pick',
            icon: BarcodeIcon,
            permission: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
            phase: 8,
            reqs: 'REQ-AA-05, REQ-AA-06, REQ-AA-07, D-48',
          },
          {
            to: '/sales/packed',
            label: 'Packed',
            shortLabel: 'Packed',
            icon: PackageIcon,
            permission: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
            phase: 8,
            reqs: 'D-47',
          },
          {
            to: '/sales/awaiting-invoice',
            label: 'Awaiting invoice',
            shortLabel: 'Billing',
            icon: ReceiptXIcon,
            permission: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
            phase: 8,
            reqs: 'REQ-AA-10, REQ-AA-12, REQ-AA-13',
          },
          {
            to: '/sales/dispatches',
            label: 'Dispatches',
            shortLabel: 'Shipped',
            icon: TruckIcon,
            permission: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
            phase: 8,
            reqs: 'REQ-AA-17, REQ-AA-21, REQ-AA-24',
          },
          {
            to: '/sales/returns',
            label: 'Returns',
            shortLabel: 'Returns',
            icon: ArrowUUpLeftIcon,
            permission: PERMISSIONS.RETURNS_VIEW,
            phase: 8,
            reqs: 'docs/15 REQ-AK-01…11',
          },
          {
            to: '/sales/delivered',
            label: 'Delivered',
            shortLabel: 'Delivered',
            icon: CheckCircleIcon,
            permission: PERMISSIONS.SALES_DOCUMENT_VIEW_SELF,
            phase: 8,
            reqs: 'D-47',
          },
          {
            to: '/sales/scan',
            label: 'Scan a slip',
            shortLabel: 'Scan',
            icon: ScanIcon,
            permission: PERMISSIONS.SALES_DOCUMENT_CREATE,
            phase: 8,
            reqs: 'D-47',
          },
        ],
      },

    ],
  },
  {
    id: 'purchase',
    label: 'Purchase',
    icon: ShoppingCartIcon,
    home: '/purchase/requirements',
    permission: PERMISSIONS.PURCHASE_DOCUMENT_VIEW,
    groups: [
      {
        label: 'Procurement',
        items: [
          {
            to: '/purchase/requirements',
            label: 'Requirements',
            shortLabel: 'Needs',
            icon: ListChecksIcon,
            permission: PERMISSIONS.PURCHASE_DOCUMENT_VIEW,
            phase: 8,
            reqs: 'REQ-X-01, REQ-X-02, REQ-X-03',
          },
          {
            to: '/purchase/orders',
            label: 'Purchase orders',
            shortLabel: 'POs',
            icon: ShoppingCartIcon,
            permission: PERMISSIONS.PURCHASE_DOCUMENT_VIEW,
            phase: 8,
            reqs: 'REQ-X-05, REQ-X-06, REQ-X-07',
          },
          {
            to: '/purchase/grns',
            label: 'Goods receipts',
            shortLabel: 'GRNs',
            icon: ArchiveIcon,
            permission: PERMISSIONS.PURCHASE_DOCUMENT_VIEW,
            phase: 8,
            reqs: 'REQ-X-10, REQ-X-11, REQ-X-12',
          },
        ],
      },
    ],
  },
  {
    id: 'reports',
    label: 'Reports',
    icon: ChartBarIcon,
    home: '/reports',
    // report.view opens the module; each area inside carries its own key, so
    // the sidebar shows a person exactly the areas their permissions open.
    permission: PERMISSIONS.REPORT_VIEW,
    groups: [
      {
        label: 'General',
        items: [
          {
            to: '/reports',
            label: 'Overview',
            icon: SquaresFourIcon,
            permission: PERMISSIONS.REPORT_VIEW,
            phase: 6,
            reqs: 'REQ-Y-06',
          },
          {
            to: '/reports/sales-analysis',
            label: 'Sales analysis',
            shortLabel: 'Sales',
            icon: ChartBarIcon,
            permission: PERMISSIONS.CFO_SALES_VIEW,
            phase: 6,
            reqs: 'CFO brief B3, Phase 3',
          },
          {
            to: '/reports/penetration',
            label: 'Penetration',
            icon: GridNineIcon,
            permission: PERMISSIONS.CFO_SALES_VIEW,
            phase: 6,
            reqs: 'CFO brief Q2.10',
          },
          {
            to: '/reports/growth',
            label: 'Growth',
            icon: ChartLineUpIcon,
            permission: PERMISSIONS.CFO_SALES_VIEW,
            phase: 6,
            reqs: 'CFO brief D1, D2, Phase 3',
          },
          {
            to: '/reports/team',
            label: 'Sales team',
            shortLabel: 'Team',
            icon: TrophyIcon,
            permission: PERMISSIONS.CFO_SALES_VIEW,
            phase: 6,
            reqs: 'CFO brief G4, G5, Phase 3',
          },
        ],
      },
      {
        label: 'Areas',
        items: [
          {
            to: '/reports/attendance',
            label: 'Attendance',
            icon: CalendarDotsIcon,
            permission: PERMISSIONS.ATTENDANCE_VIEW_ALL,
            phase: 6,
            reqs: 'REQ-Y-06',
          },
          {
            to: '/reports/receivables',
            label: 'Receivables',
            icon: ReceiptIcon,
            permission: PERMISSIONS.RECEIVABLES_VIEW,
            phase: 6,
            reqs: 'REQ-Y-06',
          },
          {
            to: '/reports/sales',
            label: 'Sales & purchase',
            shortLabel: 'Sales',
            icon: ShoppingCartIcon,
            permission: PERMISSIONS.SALES_DOCUMENT_VIEW_ALL,
            phase: 6,
            reqs: 'REQ-Y-06',
          },
          {
            to: '/reports/sync',
            label: 'Sync health',
            shortLabel: 'Sync',
            icon: PlugIcon,
            permission: PERMISSIONS.INTEGRATION_MANAGE,
            phase: 6,
            reqs: 'REQ-Y-06',
          },
        ],
      },
      {
        label: 'Credit',
        items: [
          {
            to: '/reports/desk',
            label: "Director's desk",
            shortLabel: 'Desk',
            icon: PhoneIcon,
            permission: PERMISSIONS.CFO_SALES_VIEW,
            phase: 6,
            reqs: 'CFO brief Part O',
          },
          {
            to: '/reports/me',
            label: 'My CFO',
            shortLabel: 'Mine',
            icon: UserCircleIcon,
            permission: PERMISSIONS.CFO_SALES_VIEW,
            phase: 6,
            reqs: 'CFO brief G3, Phase 2',
          },
          {
            to: '/reports/credit',
            label: 'Credit control',
            shortLabel: 'Credit',
            icon: HandCoinsIcon,
            permission: PERMISSIONS.CFO_RECEIVABLES_VIEW,
            phase: 6,
            reqs: 'CFO brief C4, Phase 2',
          },
          {
            to: '/reports/class-grade',
            label: 'Class and grade',
            shortLabel: 'Classes',
            icon: SquaresFourIcon,
            permission: PERMISSIONS.CFO_RECEIVABLES_VIEW,
            phase: 6,
            reqs: 'CFO brief Q2.2, Part P',
          },
          {
            to: '/reports/work-lists',
            label: 'Work lists',
            shortLabel: 'Lists',
            icon: ListChecksIcon,
            permission: PERMISSIONS.CFO_SALES_VIEW,
            phase: 6,
            reqs: 'CFO brief E1, E3, Phase 2',
          },
        ],
      },
      {
        label: 'Control',
        items: [
          {
            to: '/reports/data-quality',
            label: 'Data quality',
            shortLabel: 'Quality',
            icon: ShieldCheckIcon,
            permission: PERMISSIONS.CFO_EXCEPTIONS_VIEW,
            phase: 6,
            reqs: 'CFO brief Q3',
          },
          {
            to: '/reports/definitions',
            label: 'Definitions',
            icon: BookOpenTextIcon,
            permission: PERMISSIONS.CFO_SALES_VIEW,
            phase: 6,
            reqs: 'CFO brief Q4, R7',
          },
        ],
      },
      {
        label: 'Custom',
        items: [
          {
            to: '/reports/custom',
            label: 'Custom reports',
            shortLabel: 'Custom',
            icon: SquaresFourIcon,
            permission: PERMISSIONS.REPORT_VIEW,
            phase: 6,
            reqs: 'REQ-Y-06',
          },
        ],
      },
    ],
  },
];

/**
 * Whether a module belongs in this person's switcher and bar. A module that
 * declares its own key answers to it; one that does not (Sales and Logistics
 * after D-19 span several keys) shows when any destination inside it does --
 * a module whose every screen would be refused is furniture.
 */
export function moduleVisibleFor(module: ModuleDef, granted: ReadonlySet<string>): boolean {
  if (module.permission) return granted.has(module.permission);
  return module.groups.some((group) => group.items.some((item) => !item.permission || granted.has(item.permission)));
}

/**
 * The module that owns a route, so the sidebar can render that module's
 * groups rather than always attendance's (REQ-O-01 — without this, a second
 * module's screens exist in the palette and nowhere a mouse can find them).
 *
 * Prefix matching covers detail routes: /employees/42 belongs to whichever
 * module owns /employees. Routes no module claims — the workspace screens,
 * /profile, an unknown URL — fall back to attendance, which keeps the sidebar
 * stable instead of blanking it on every administrative page.
 */
export function findModuleForPath(pathname: string): ModuleDef {
  return (
    MODULES.find((module) =>
      module.groups.some((group) =>
        group.items.some((item) => {
          // Query doors (the report categories) still claim their pathname:
          // /reports belongs to the reports module even with no bare item.
          const base = item.to.split('?')[0] ?? item.to;
          return base === pathname || (base !== '/' && pathname.startsWith(`${base}/`));
        }),
      ),
    ) ?? ATTENDANCE_MODULE
  );
}

/** Every destination that has a name, wherever it is reached from. */
export const ALL_NAV_ITEMS: NavItem[] = [
  // Every module's destinations, not only attendance's: the breadcrumb and
  // the palette must name a screen whichever module owns it.
  ...MODULES.flatMap((m) => m.groups.flatMap((g) => g.items)),
  ...ADMIN_GROUPS.flatMap((g) => g.items),
  ...TOP_BAR_ITEMS,
];

export function findNavItem(pathname: string): NavItem | undefined {
  return ALL_NAV_ITEMS.find((item) => item.to === pathname);
}

/**
 * The sidebar group a route sits under, so the breadcrumb has a parent to show.
 * A trail of one is not a trail — without this every page would render its own
 * name and nothing else.
 */
export function findNavGroup(pathname: string): string | undefined {
  return [...MODULES.flatMap((m) => m.groups), ...ADMIN_GROUPS].find((group) =>
    group.items.some((item) => item.to === pathname),
  )?.label;
}

export interface Crumb {
  label: string;
  to?: string;
}

/**
 * Routes that carry a name but deliberately sit outside the sidebar.
 *
 * /profile is permanent: PRD §6.1 fixes the sidebar to Work, Records, Reports
 * and Setup, and a personal account page belongs to none of them, so it is
 * reached from the user menu in the header instead. It still needs a name here
 * or the breadcrumb would announce the page as "Not found".
 *
 * /patterns is gated on DEV for the same reason the route itself is: naming it
 * unconditionally would leave a production build showing "Shell patterns" in
 * the header above a body that says there is no screen at this address. The
 * label and the route have to appear and disappear together.
 */
const OFF_NAV_LABELS: Record<string, string> = {
  '/profile': 'Profile',
  /* The attendance dashboard left the sidebar when the Reports module took
     its job; the address survives for old links and needs its name. */
  '/dashboard': 'Dashboard',
  /* The shadcn-shaped second take on the reports dashboard. Deliberately not a
     nav item -- it exists to be compared against /reports/dashboard, and two
     entries called "Dashboard" in the same group would be a puzzle rather than
     a choice. Named here so the header does not say "Not found" above it. */
  '/reports/dashboard/v2': 'Dashboard (v2)',
  /* REQ-O-02's landing screen. Reached from the sidebar footer rather than
     being a destination inside a module, so it needs a name here for the same
     reason the three below do -- without it the header announced the page as
     "Not found" above a screen that was rendering perfectly. */
  /* The reports hub. Its sidebar rows are the category doors (owner, 25 Aug),
     each carrying a query -- so no nav item owns the bare pathname, and the
     breadcrumb needs the name here. */
  '/reports': 'All reports',
  '/administration': 'Administration',
  /* Same reasoning as /profile: PRD §6.1 fixes the sidebar to Work, Records,
     Reports and Setup, and a changelog belongs to none of them. Reached from
     the account menu; named here so the breadcrumb does not call it
     "Not found". */
  '/updates': 'Updates',
  /* REQ-K-02's list, reached from the bell rather than from the navigation.
     Named here for the same reason the two above are: the breadcrumb would
     otherwise announce the page as "Not found". */
  '/notifications': 'Notifications',
  /* D-22's per-party interest overrides. Reached from the Interest cost
     section of Settings rather than the sidebar: a configuration surface is
     not a report, and the reports group is at its cap. Named here so the
     header does not say "Not found" above it. */
  '/interest-overrides': 'Interest cost overrides',
  ...(import.meta.env.DEV ? { '/patterns': 'Shell patterns' } : {}),
};

/**
 * The trail for a route, derived here rather than passed up from the screen.
 * The header renders it, so a screen cannot forget to declare who it is, and
 * two screens cannot describe the same route differently.
 */
/**
 * Routes that are reached from a nav item rather than being one.
 *
 * Kept as a table beside the nav rather than inside the breadcrumb function, so
 * adding a detail screen is one row here instead of a branch somebody has to
 * find.
 */
const DETAIL_ROUTES: readonly { pattern: RegExp; parent: string; label: string }[] = [
  { pattern: /^\/reports\/custom\/[^/]+$/u, parent: '/reports/custom', label: 'Report' },
  { pattern: /^\/reports\/team\/[^/]+$/u, parent: '/reports/team', label: 'Scorecard' },
  { pattern: /^\/employees\/[^/]+$/u, parent: '/employees', label: 'Employee' },
  { pattern: /^\/masters\/vouchers\/[^/]+$/u, parent: '/masters/vouchers', label: 'Voucher' },
  { pattern: /^\/masters\/vouchers\/[^/]+\/paper$/u, parent: '/masters/vouchers', label: 'Print' },
  { pattern: /^\/masters\/parties\/[^/]+$/u, parent: '/masters/parties', label: 'Party' },
  { pattern: /^\/masters\/price-lists\/new$/u, parent: '/masters/price-lists', label: 'New price list' },
  { pattern: /^\/masters\/price-lists\/[^/]+$/u, parent: '/masters/price-lists', label: 'Price list' },
  { pattern: /^\/masters\/items\/[^/]+$/u, parent: '/masters/items', label: 'Stock item' },
  { pattern: /^\/crm\/contacts\/[^/]+$/u, parent: '/crm/contacts', label: 'Contact' },
  { pattern: /^\/crm\/companies\/[^/]+$/u, parent: '/crm/companies', label: 'Company' },
  { pattern: /^\/tasks\/[^/]+$/u, parent: '/tasks', label: 'Task' },
  { pattern: /^\/crm\/deals\/[^/]+$/u, parent: '/crm/deals', label: 'Deal' },
  { pattern: /^\/sales\/estimates\/[^/]+$/u, parent: '/sales/estimates', label: 'Estimate' },
  { pattern: /^\/sales\/orders\/[^/]+$/u, parent: '/sales/orders', label: 'Sales order' },
  { pattern: /^\/sales\/invoices\/[^/]+$/u, parent: '/sales/invoices', label: 'Invoice' },
  { pattern: /^\/sales\/pick-queue\/[^/]+$/u, parent: '/sales/pick-queue', label: 'Pack' },
  { pattern: /^\/sales\/packs\/[^/]+$/u, parent: '/sales/packed', label: 'Packing slip' },
  { pattern: /^\/sales\/dispatches\/[^/]+$/u, parent: '/sales/dispatches', label: 'Dispatch' },
  { pattern: /^\/purchase\/orders\/[^/]+$/u, parent: '/purchase/orders', label: 'Purchase order' },
  { pattern: /^\/purchase\/grns\/[^/]+$/u, parent: '/purchase/grns', label: 'Goods receipt' },
];

export function findBreadcrumbs(pathname: string): [Crumb, ...Crumb[]] {
  const offNav = OFF_NAV_LABELS[pathname];
  if (offNav) return [{ label: offNav }];

  // A detail route hangs off a nav item without being one. Matching only exact
  // paths made every one of them render "Not found" in the header while the
  // screen below it worked perfectly.
  //
  // The last crumb cannot be the person's name: this function is pure over the
  // pathname and has never seen the record. The screen states the name itself.
  const detail = DETAIL_ROUTES.find((route) => route.pattern.test(pathname));
  if (detail) {
    const parent = findNavItem(detail.parent);
    const group = findNavGroup(detail.parent);
    const crumbs: Crumb[] = [];
    if (group && group !== parent?.label) crumbs.push({ label: group });
    if (parent) crumbs.push({ label: parent.label, to: detail.parent });
    crumbs.push({ label: detail.label });
    return crumbs as [Crumb, ...Crumb[]];
  }

  const item = findNavItem(pathname);
  if (!item) return [{ label: 'Not found' }];

  const group = findNavGroup(pathname);
  // "Reports" sits in a group also called Reports. A parent that repeats its
  // child is noise, so it is dropped rather than rendered.
  return group && group !== item.label
    ? [{ label: group }, { label: item.label }]
    : [{ label: item.label }];
}
