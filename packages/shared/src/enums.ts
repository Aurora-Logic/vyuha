/**
 * Domain enums shared by the API and the web client. These mirror the Postgres
 * enum types created in the first migration; changing one means changing both,
 * which is why they live in the contract package.
 */

export const EMPLOYMENT_TYPES = ['PERMANENT', 'CONTRACT', 'PROBATION', 'INTERN'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/** REQ-A-05: activate, place on notice, deactivate with a last working date. */
export const EMPLOYEE_STATUSES = ['ACTIVE', 'ON_NOTICE', 'INACTIVE'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const USER_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const PUNCH_TYPES = ['IN', 'OUT'] as const;
export type PunchType = (typeof PUNCH_TYPES)[number];

/** ADMIN_ENTRY (owner, 21 Aug 2026): recorded by an admin for an employee, beside the employee's own punches. */
export const PUNCH_SOURCES = ['WEB', 'MOBILE', 'OFFLINE_SYNC', 'ADMIN_ENTRY'] as const;
export type PunchSource = (typeof PUNCH_SOURCES)[number];

export const HALF_DAY_PARTS = ['FIRST_HALF', 'SECOND_HALF'] as const;
export type HalfDayPart = (typeof HALF_DAY_PARTS)[number];

/**
 * REQ-E-02. The array order is the resolution order the day engine applies:
 * the first matching condition wins. Do not reorder without changing the
 * engine and its table-driven tests together.
 */
export const ATTENDANCE_STATUSES = [
  'HOLIDAY',
  'WEEKLY_OFF',
  'ON_LEAVE',
  'PRESENT',
  'HALF_DAY',
  'ON_DUTY',
  'PENDING',
  'ABSENT',
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** REQ-E-04: flags are independent of status; a day may carry several. */
export const ATTENDANCE_FLAGS = [
  'late',
  'early_exit',
  'missing_punch',
  'outside_geofence',
  'outside_window',
  'offline_sync',
  'device_mismatch',
  'manual_override',
  'low_gps_accuracy',
  'no_location',
  'mock_location',
  'clock_skew',
] as const;
export type AttendanceFlag = (typeof ATTENDANCE_FLAGS)[number];

/** REQ-D-06. Default is ALLOW_WITH_REASON per 05-decisions. */
/**
 * What an admin does with a flagged punch from Approvals (owner, 21 Aug 2026).
 * ACCEPT clears the flag, KEEP leaves it, HALF_DAY pins the day to a half,
 * NOTE attaches a note and closes nothing.
 */
export const PUNCH_FLAG_REVIEW_ACTIONS = ['ACCEPT', 'KEEP', 'HALF_DAY', 'NOTE'] as const;
export type PunchFlagReviewAction = (typeof PUNCH_FLAG_REVIEW_ACTIONS)[number];

/** REQ-B-08. Default is WARN per 05-decisions. */
export const DEVICE_BINDING_MODES = ['OFF', 'WARN', 'ENFORCE'] as const;
export type DeviceBindingMode = (typeof DEVICE_BINDING_MODES)[number];

/** REQ-D-08 and REQ-L-02: what happens to a punch outside the location radius. */
export const GEOFENCE_BEHAVIOURS = ['BLOCK', 'ALLOW_WITH_REASON', 'ALLOW_AND_FLAG'] as const;
export type GeofenceBehaviour = (typeof GEOFENCE_BEHAVIOURS)[number];

export const APPROVAL_TYPES = [
  'LEAVE',
  'REGULARIZATION',
  'ON_DUTY',
  'FLAGGED_PUNCH',
  'DEVICE_REBIND',
  /** 13 REQ-X-16: a purchase order over the configured value. */
  'PURCHASE_ORDER',
  /** 08 REQ-W-08: a sales order discounted past the threshold. */
  'SALES_DISCOUNT',
  'PRICE_LIST',
] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export const APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'ESCALATED',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** REQ-G-03: every balance movement is a ledger row naming its cause. */
export const LEAVE_MOVEMENT_TYPES = [
  'OPENING',
  'ACCRUAL',
  'AVAILED',
  'ADJUSTMENT',
  'CARRY_FORWARD',
  'ENCASHMENT',
  'LAPSE',
  'REVERSAL',
] as const;
export type LeaveMovementType = (typeof LEAVE_MOVEMENT_TYPES)[number];

export const LEAVE_ACCRUAL_METHODS = ['NONE', 'MONTHLY', 'YEARLY', 'ON_JOINING'] as const;
export type LeaveAccrualMethod = (typeof LEAVE_ACCRUAL_METHODS)[number];

export const LEAVE_DAY_PORTIONS = ['FULL', 'FIRST_HALF', 'SECOND_HALF'] as const;
export type LeaveDayPortion = (typeof LEAVE_DAY_PORTIONS)[number];

export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'whatsapp'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const FILE_PURPOSES = [
  'PUNCH_PHOTO',
  'PUNCH_PHOTO_THUMB',
  'EXPORT',
  'ATTACHMENT',
  'ORG_LOGO',
  'IMPORT',
  /** REQ-AA-20: a dispatch's box and LR photographs, through the same pipeline. */
  'DISPATCH_PHOTO',
  /**
   * REQ-U-05 (owner, 31 Aug 2026): a quote, drawing or site photograph
   * attached to a deal. Its own purpose rather than ATTACHMENT, because
   * that one is read with attendance and leave keys and a deal is read
   * with CRM keys.
   */
  'CRM_ATTACHMENT',
] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

export const EXPORT_JOB_STATUSES = ['QUEUED', 'RUNNING', 'DONE', 'FAILED'] as const;
export type ExportJobStatus = (typeof EXPORT_JOB_STATUSES)[number];

export const INTEGRATION_SYSTEMS = ['TALLY'] as const;
export type IntegrationSystem = (typeof INTEGRATION_SYSTEMS)[number];

export const INTEGRATION_STATUSES = ['DISCONNECTED', 'CONNECTED', 'STALE', 'ERROR'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const DEVICE_STATUSES = ['ACTIVE', 'PENDING_REBIND', 'REVOKED'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export const SETTING_SCOPES = ['ORG', 'LOCATION'] as const;
export type SettingScope = (typeof SETTING_SCOPES)[number];
