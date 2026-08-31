import { sql } from 'drizzle-orm';

import { AppError } from '../common/errors.js';
import type { Database } from '../db/db.provider.js';

/**
 * OS-3 (REQ-H-02): the write-side check for `holiday_calendar_id` on locations
 * and employees.
 *
 * Raw SQL naming the table, not the drizzle schema object: `holiday_calendars`
 * belongs to `modules/attendance`, and technical design §1 forbids platform/
 * importing modules/ -- the same arrangement `employee-data-export.repository.ts`
 * already uses for this table. The column itself carries a foreign key since
 * the Phase 1 migration, but the constraint cannot see `deleted_at` and answers
 * with a 500 naming a constraint rather than a 400 naming the field.
 */
export async function assertHolidayCalendarInOrg(
  db: Database,
  orgId: string,
  holidayCalendarId: string | null | undefined,
): Promise<void> {
  if (holidayCalendarId === null || holidayCalendarId === undefined) return;

  const rows = await db.execute(sql`
    SELECT 1 AS hit FROM holiday_calendars
     WHERE id = ${holidayCalendarId}::uuid
       AND org_id = ${orgId}
       AND deleted_at IS NULL
     LIMIT 1
  `);

  if (rows.rows.length === 0) {
    // The same wording assertReferencesExist uses for the other masters, so a
    // calendar from another organisation reads exactly like one that does not
    // exist -- confirming the id names a real calendar is the information a
    // probe is after.
    throw AppError.validation('One or more references do not exist in this organisation.', {
      fields: [{ path: 'holidayCalendarId', message: 'no such record', value: holidayCalendarId }],
    });
  }
}
