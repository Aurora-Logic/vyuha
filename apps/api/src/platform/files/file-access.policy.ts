import { PERMISSIONS, type FilePurpose, type PermissionKey } from '@vyuha/shared';

import { hasAnyPermission, type Principal } from '../rbac/principal.js';

/**
 * Who may be handed a signed URL, by what the file is for.
 *
 * NFR-09 and technical design §7: "Retrieval only via signed URLs valid for 5
 * minutes, **issued after a permission check** on the requesting user's
 * scope." This file is that check. It is a table rather than a chain of `if`s
 * so that adding a purpose to `FILE_PURPOSES` without deciding who may read it
 * is a compile error -- the `Record<FilePurpose, ...>` is doing that work.
 *
 * Two things are deliberately *not* here:
 *
 * - **Row-level scope.** Whether a manager may see *this* employee's photo is
 *   a `ScopeService` question against the punch that owns it, and `punches`
 *   arrives in Phase 1. Until then the breadth permissions below are the
 *   whole check, and the uploader rule is what gives an employee access to
 *   their own photo without granting them everyone else's.
 * - **Org isolation.** `FileService` loads the row through a
 *   `ScopedRepository`, so a file belonging to another organisation is not
 *   found rather than refused. A policy that had to remember to compare org
 *   ids would be a policy that could forget.
 */

export type FileReadRule =
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'permission'; readonly anyOf: readonly [PermissionKey, ...PermissionKey[]] };

export const FILE_READ_RULES: Record<FilePurpose, FileReadRule> = {
  // A punch photo is evidence about a named person (REQ-M-03). Deliberately
  // not readable with `attendance.view.self`: that key is held by every
  // employee, and a file id is the only thing between them and someone else's
  // photograph. Your own photo is reachable through the uploader rule below.
  PUNCH_PHOTO: {
    kind: 'permission',
    anyOf: [PERMISSIONS.ATTENDANCE_VIEW_TEAM, PERMISSIONS.ATTENDANCE_VIEW_ALL],
  },
  PUNCH_PHOTO_THUMB: {
    kind: 'permission',
    anyOf: [PERMISSIONS.ATTENDANCE_VIEW_TEAM, PERMISSIONS.ATTENDANCE_VIEW_ALL],
  },

  // §15, data leakage in exports: "Export permission checked ... links expire."
  EXPORT: { kind: 'permission', anyOf: [PERMISSIONS.REPORT_EXPORT] },

  // A leave certificate or a regularization attachment: whoever can approve
  // the request, or whoever can see the attendance it belongs to.
  ATTACHMENT: {
    kind: 'permission',
    anyOf: [
      PERMISSIONS.ATTENDANCE_VIEW_TEAM,
      PERMISSIONS.ATTENDANCE_VIEW_ALL,
      PERMISSIONS.LEAVE_APPROVE_TEAM,
      PERMISSIONS.LEAVE_APPROVE_ALL,
    ],
  },

  // REQ-L-01. Rendered in the page header for everyone who is signed in, so a
  // permission here would mean an employee seeing a broken logo.
  ORG_LOGO: { kind: 'authenticated' },

  // REQ-A-06 bulk import files contain the whole workforce in one spreadsheet.
  IMPORT: { kind: 'permission', anyOf: [PERMISSIONS.EMPLOYEE_MANAGE] },

  // REQ-AA-20: a box or an LR photograph, evidence about a shipment, readable
  // by whoever may read the sales documents it belongs to.
  DISPATCH_PHOTO: { kind: 'permission', anyOf: [PERMISSIONS.SALES_DOCUMENT_VIEW_SELF, PERMISSIONS.SALES_DOCUMENT_VIEW_ALL] },

  // REQ-U-05: a quote or drawing on a deal, readable by whoever may read the
  // deal it hangs off. The uploader rule reaches their own upload either way.
  CRM_ATTACHMENT: { kind: 'permission', anyOf: [PERMISSIONS.CRM_DEAL_VIEW_SELF, PERMISSIONS.CRM_DEAL_VIEW_ALL] },

  // REQ-V-12: a file on a task, readable by whoever may read the task it
  // hangs off. The uploader rule reaches their own upload either way.
  TASK_ATTACHMENT: {
    kind: 'permission',
    anyOf: [PERMISSIONS.CRM_TASK_VIEW_SELF, PERMISSIONS.CRM_TASK_VIEW_TEAM, PERMISSIONS.CRM_TASK_VIEW_ALL],
  },
};

export interface ReadableFile {
  readonly purpose: FilePurpose;
  readonly uploadedBy: string | null;
}

/**
 * The uploader may always read what they uploaded. That is what makes "an
 * employee can see their own punch photo" true without handing them a
 * permission that would also show them everyone else's.
 */
export function mayReadFile(principal: Principal, file: ReadableFile): boolean {
  if (file.uploadedBy !== null && file.uploadedBy === principal.userId) return true;

  const rule = FILE_READ_RULES[file.purpose];
  if (rule.kind === 'authenticated') return true;
  return hasAnyPermission(principal, rule.anyOf);
}

/** What the refusal should say it needed, for the error envelope's details. */
export function requiredPermissionsFor(purpose: FilePurpose): readonly PermissionKey[] {
  const rule = FILE_READ_RULES[purpose];
  return rule.kind === 'authenticated' ? [] : rule.anyOf;
}
