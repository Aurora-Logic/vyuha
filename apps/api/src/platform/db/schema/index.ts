/**
 * Platform tables only (technical design §4.1).
 *
 * Attendance tables live in `modules/attendance/` and are picked up separately
 * by drizzle.config.ts. They are deliberately not re-exported here: the
 * dependency rule in §1 says platform must never reach into a module, and a
 * barrel that pulled them in would make that violation invisible.
 */
export * from './organizations.schema.js';
export * from './people.schema.js';
export * from './approval.schema.js';
export * from './identity.schema.js';
export * from './audit.schema.js';
export * from './deletion.schema.js';
export * from './notification.schema.js';
export * from './file.schema.js';
export * from './consent.schema.js';
export * from './report.schema.js';
export * from './integration.schema.js';
export * from './sync.schema.js';
export * from './projections.schema.js';
export * from './task.schema.js';
export * from './procurement.schema.js';
export * from './rate-limit.schema.js';
export * from './jobs-fallback.schema.js';
export * from './pricing.schema.js';
export * from './duplicates.schema.js';
export * from './collections.schema.js';
export * from './portal.schema.js';
export * from './insights.schema.js';
