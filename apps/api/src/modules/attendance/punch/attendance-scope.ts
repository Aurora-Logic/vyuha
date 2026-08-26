import { PERMISSIONS } from '@vyuha/shared';

import type { ScopeGrants } from '../../../platform/rbac/scope.service.js';

/**
 * Who may see whose attendance, one ladder for punches and days alike.
 *
 * In its own file rather than on `PunchService`, deliberately: the day
 * service imported it from there, which closed the cycle day.service ->
 * punch.service -> flag-review.service -> override.service -> day.service.
 * The cycle stayed latent for as long as an unrelated module's import
 * happened to fix the evaluation order, and surfaced as `AttendanceDayService
 * undefined at runtime` the day that module was removed. A constant with no
 * dependencies cannot re-close it.
 */
export const ATTENDANCE_SCOPE_GRANTS: ScopeGrants = {
  self: PERMISSIONS.ATTENDANCE_VIEW_SELF,
  team: PERMISSIONS.ATTENDANCE_VIEW_TEAM,
  all: PERMISSIONS.ATTENDANCE_VIEW_ALL,
};
