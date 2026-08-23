import {
  WineIcon,
  UmbrellaIcon,
  StackSimpleIcon,
  ScissorsIcon,
  BarbellIcon,
  ArrowFatLinesUpIcon,
  ArchiveIcon,
  BooksIcon,
  BriefcaseIcon,
  CalendarBlankIcon,
  CalendarCheckIcon,
  CalendarDotsIcon,
  CheckIcon,
  CheckSquareIcon,
  CircleHalfIcon,
  ClipboardIcon,
  ClockCounterClockwiseIcon,
  CloudArrowUpIcon,
  DesktopIcon,
  DeviceMobileIcon,
  FileTextIcon,
  HourglassIcon,
  LockIcon,
  MapPinIcon,
  MoonIcon,
  PackageIcon,
  PercentIcon,
  PlugIcon,
  ReceiptIcon,
  ScrollIcon,
  ShoppingCartIcon,
  SunIcon,
  TruckIcon,
  UserGearIcon,
  UsersThreeIcon,
  XIcon,
  type Icon, TagIcon } from '@phosphor-icons/react';
import type { ApprovalType, AttendanceStatus, HandlingMark, PunchSource, ReportCategory } from '@vyuha/shared';

import { ACTION_ICONS } from './action-icons';

/**
 * Owner, 22 Aug 2026: the things this product names often enough to deserve
 * a fixed glyph, worn wherever the thing is named. One table per family,
 * the way ACTION_ICONS binds verbs, so a screen asks here and never picks
 * its own. The flag set the pattern; these follow it.
 */

export const DOCUMENT_ICONS = {
  estimate: FileTextIcon,
  sales_order: ClipboardIcon,
  invoice: ReceiptIcon,
  dispatch: TruckIcon,
  purchase_order: ShoppingCartIcon,
  grn: PackageIcon,
} as const satisfies Record<string, Icon>;

export const APPROVAL_TYPE_ICONS: Record<ApprovalType, Icon> = {
  LEAVE: CalendarCheckIcon,
  REGULARIZATION: ClockCounterClockwiseIcon,
  ON_DUTY: MapPinIcon,
  FLAGGED_PUNCH: ACTION_ICONS.flag,
  DEVICE_REBIND: DeviceMobileIcon,
  PURCHASE_ORDER: ShoppingCartIcon,
  SALES_DISCOUNT: PercentIcon,
  PRICE_LIST: TagIcon,
};

export const PUNCH_SOURCE_ICONS: Record<PunchSource, Icon> = {
  MOBILE: DeviceMobileIcon,
  WEB: DesktopIcon,
  OFFLINE_SYNC: CloudArrowUpIcon,
  ADMIN_ENTRY: UserGearIcon,
};

export const ATTENDANCE_STATUS_ICONS: Record<AttendanceStatus, Icon> = {
  PRESENT: CheckIcon,
  HALF_DAY: CircleHalfIcon,
  ON_DUTY: BriefcaseIcon,
  ON_LEAVE: CalendarBlankIcon,
  PENDING: HourglassIcon,
  ABSENT: XIcon,
  HOLIDAY: SunIcon,
  WEEKLY_OFF: MoonIcon,
};

/** The catalogue's families; the Reports sidebar wears the same glyphs for the same names. */
export const REPORT_CATEGORY_ICONS: Record<ReportCategory, Icon> = {
  Attendance: CalendarDotsIcon,
  Approvals: CheckSquareIcon,
  Leave: CalendarBlankIcon,
  Books: BooksIcon,
  Receivables: ReceiptIcon,
  Customers: UsersThreeIcon,
  Inventory: PackageIcon,
  Vendors: ArchiveIcon,
  Fulfilment: TruckIcon,
  Exceptions: ScrollIcon,
};

/** D-47: the marks a carton wears; the slip prints icon and label, the Design rail shows the same glyphs to switch on. */
export const HANDLING_MARK_ICONS: Record<HandlingMark, Icon> = {
  fragile: WineIcon,
  this_side_up: ArrowFatLinesUpIcon,
  keep_dry: UmbrellaIcon,
  do_not_stack: StackSimpleIcon,
  heavy: BarbellIcon,
  open_with_care: ScissorsIcon,
};

/** A bell row's glyph, by the event family its type names. */
export function notificationIcon(eventType: string): Icon {
  if (eventType.startsWith('punch.flagged')) return ACTION_ICONS.flag;
  if (eventType.startsWith('punch.')) return DeviceMobileIcon;
  if (eventType.startsWith('leave.')) return APPROVAL_TYPE_ICONS.LEAVE;
  if (eventType.startsWith('regularization.')) return APPROVAL_TYPE_ICONS.REGULARIZATION;
  if (eventType.startsWith('approval.')) return HourglassIcon;
  if (eventType.startsWith('period.')) return LockIcon;
  if (eventType.startsWith('sync.')) return PlugIcon;
  if (eventType.startsWith('task.')) return CheckSquareIcon;
  if (eventType.startsWith('procurement.')) return DOCUMENT_ICONS.purchase_order;
  if (eventType.startsWith('sales.')) return DOCUMENT_ICONS.invoice;
  if (eventType.startsWith('reports.')) return ACTION_ICONS.flag;
  return CalendarBlankIcon;
}
