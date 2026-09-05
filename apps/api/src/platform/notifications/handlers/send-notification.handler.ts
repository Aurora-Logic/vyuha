import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ALL_PERMISSIONS, type PermissionKey } from '@vyuha/shared';

import { JobRegistry, type JobContext, type JobHandler, type JobResult } from '../../jobs/job-handler.js';
import type { JobPayloads } from '../../jobs/queue.registry.js';
import type {
  NotificationAudience,
  NotificationEventType,
  NotificationPayload,
} from '../notification-events.js';
import { NOTIFICATION_TEMPLATES } from '../notification-events.js';
import { NotificationDispatcher } from '../notification.dispatcher.js';

/**
 * The `notification` queue's consumer (technical design §11).
 *
 * The payload has been through Redis, so it arrives as JSON with no types
 * attached. Everything it carries is checked here rather than trusted: an
 * event type the catalogue does not know, or an audience shape nothing can
 * resolve, is a permanent failure and should reach the failed set on the first
 * attempt instead of being retried five times and then rendering as
 * "undefined" in someone's inbox.
 */
@Injectable()
export class SendNotificationHandler implements JobHandler<'send-notification'>, OnModuleInit {
  readonly jobName = 'send-notification' as const;

  constructor(
    private readonly dispatcher: NotificationDispatcher,
    private readonly registry: JobRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(
    payload: JobPayloads['send-notification'],
    _context: JobContext,
  ): Promise<JobResult> {
    const eventType = payload.eventType;
    if (!isKnownEvent(eventType)) {
      throw new Error(`Queued notification names an unknown event type "${eventType}".`);
    }

    const audience = asAudience(payload.audience);
    if (audience === null) {
      throw new Error(`Queued notification for "${eventType}" has an unrecognised audience.`);
    }

    const report = await this.dispatcher.deliver({
      orgId: payload.orgId,
      type: eventType,
      audience,
      payload: asScalarPayload(eventType, payload.payload),
    }, payload.outboxId);

    return { ...report, eventType };
  }
}

function isKnownEvent(value: string): value is NotificationEventType {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_TEMPLATES, value);
}

/**
 * `NotificationPayload` is scalars, and `emit` enforces that at the type
 * level -- so a nested object here means something enqueued a job without
 * going through the dispatcher. Refused rather than coerced: a template would
 * render it as "[object Object]" and send that to an employee.
 */
function asScalarPayload(
  eventType: string,
  raw: Record<string, unknown>,
): NotificationPayload {
  const scalars: Record<string, string | number | boolean | null> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      scalars[key] = value as string | number | boolean | null;
      continue;
    }
    throw new Error(
      `Queued notification "${eventType}" carries a non-scalar payload value at "${key}".`,
    );
  }

  return scalars;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Narrows the JSON that came back out of Redis, or returns null. */
function asAudience(value: unknown): NotificationAudience | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;

  if (candidate.kind === 'users' && isStringArray(candidate.userIds)) {
    return { kind: 'users', userIds: candidate.userIds };
  }
  if (candidate.kind === 'employees' && isStringArray(candidate.employeeIds)) {
    return { kind: 'employees', employeeIds: candidate.employeeIds };
  }
  if (candidate.kind === 'permission' && isPermissionKey(candidate.key)) {
    return { kind: 'permission', key: candidate.key };
  }

  return null;
}

/**
 * Checked against the catalogue rather than cast. A permission key that no
 * longer exists would otherwise resolve to nobody and read as "delivered to
 * zero recipients", which is indistinguishable from "nobody holds that role".
 */
function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === 'string' && (ALL_PERMISSIONS as readonly string[]).includes(value);
}
