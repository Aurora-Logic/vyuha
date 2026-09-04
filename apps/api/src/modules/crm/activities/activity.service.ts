import { Injectable } from '@nestjs/common';
import {
  CRM_ACTIVITY_ACTION_PREFIX,
  CRM_ACTIVITY_KINDS,
  CRM_ACTIVITY_KIND_LABELS,
  PERMISSIONS,
  type ActivityListQuery,
  type ActivityPage,
  type ActivityView,
  type CrmActivitySubject,
  type LogActivityInput,
  REALTIME_RESOURCES,
  type RealtimeResource,
} from '@vyuha/shared';

import { AuditContext } from '../../../platform/audit/audit-context.js';
import { AuditLogRepository, type AuditLogRow } from '../../../platform/audit/audit-log.repository.js';
import { decodeCursor, encodeCursor } from '../../../platform/audit/audit-log.service.js';
import { AppError } from '../../../platform/common/errors.js';
import { InjectDatabase, type Database } from '../../../platform/db/db.provider.js';
import { hasPermission, type Principal } from '../../../platform/rbac/principal.js';
import { RealtimeService } from '../../../platform/realtime/realtime.service.js';
import { CrmService } from '../contacts/crm.service.js';
import { DealService } from '../deals/deal.service.js';

/**
 * REQ-U-07 through the audit interceptor, literally. Logging a call writes
 * one `AuditContext.record()` against the record — the same call every
 * write in the product makes — and the interceptor persists it with the
 * actor, the request and the timestamp it already tracks. Reading the
 * timeline pages that record's audit rows, so a logged call, an edit and a
 * stage change are one list. There is no `crm_activities` table: a second
 * store would be the parallel mechanism the requirement rules out.
 */

const ENTITY_TYPE: Record<CrmActivitySubject, string> = {
  contact: 'crm_contact',
  company: 'crm_company',
  deal: 'crm_deal',
};

/** How a system action reads on the timeline. Unknown actions fall back to the action's last word. */
const SYSTEM_TITLES: Record<string, string> = {
  'crm.contact.created': 'Created',
  'crm.contact.updated': 'Edited',
  'crm.contact.deleted': 'Deleted',
  'crm.company.created': 'Created',
  'crm.company.updated': 'Edited',
  'crm.company.deleted': 'Deleted',
  'crm.company.party_linked': 'Linked to a Tally party',
  'crm.company.party_unlinked': 'Unlinked from its Tally party',
  'crm.deal.created': 'Created',
  'crm.deal.updated': 'Edited',
  'crm.deal.stage_changed': 'Stage changed',
  'crm.deal.won': 'Won',
  'crm.deal.lost': 'Lost',
  'crm.deal.reopened': 'Reopened',
  'crm.deal.deleted': 'Deleted',
};

@Injectable()
export class ActivityService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly auditContext: AuditContext,
    private readonly crm: CrmService,
    private readonly deals: DealService,
    private readonly realtime: RealtimeService,
  ) {}

  async log(principal: Principal, input: LogActivityInput): Promise<ActivityView> {
    const subject = await this.describeSubject(principal, input.subjectType, input.subjectId);
    if (!hasPermission(principal, input.subjectType === 'deal' ? PERMISSIONS.CRM_DEAL_MANAGE : PERMISSIONS.CRM_CONTACT_MANAGE)) {
      throw AppError.forbidden('Logging an activity needs the manage key for the record it is on.');
    }
    const occurredAt = input.occurredAt === undefined ? new Date() : new Date(input.occurredAt);
    const recordedAt = new Date();
    this.auditContext.record({
      action: `${CRM_ACTIVITY_ACTION_PREFIX}${input.kind}`,
      entityType: ENTITY_TYPE[input.subjectType],
      entityId: input.subjectId,
      before: null,
      after: { kind: input.kind, body: input.body, occurredAt: occurredAt.toISOString(), subject: subject.label },
    });
    this.announce(
      principal,
      input.subjectType === 'deal' ? REALTIME_RESOURCES.CRM_DEAL : REALTIME_RESOURCES.CRM_CONTACT,
      'updated',
      input.subjectId,
    );
    // The row is written when the request completes; what is returned is the
    // entry as it will read, with the id the trail has not assigned yet.
    return {
      id: `pending-${recordedAt.getTime()}`,
      kind: input.kind,
      action: `${CRM_ACTIVITY_ACTION_PREFIX}${input.kind}`,
      title: CRM_ACTIVITY_KIND_LABELS[input.kind],
      body: input.body,
      actorName: null,
      occurredAt: occurredAt.toISOString(),
      recordedAt: recordedAt.toISOString(),
    };
  }

  async list(principal: Principal, query: ActivityListQuery): Promise<ActivityPage> {
    await this.describeSubject(principal, query.subjectType, query.subjectId);
    const repository = new AuditLogRepository(this.db, principal.orgId);
    const { rows, hasMore } = await repository.page({
      filters: { entityType: ENTITY_TYPE[query.subjectType], entityId: query.subjectId },
      cursor: query.cursor === undefined ? null : decodeCursor(query.cursor),
      limit: query.limit,
    });
    const last = rows[rows.length - 1];
    return {
      data: rows.map(toActivityView),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
    };
  }

  /** The subject must be one the caller can open; the same scope the screens use. */
  private async describeSubject(principal: Principal, type: CrmActivitySubject, id: string): Promise<{ label: string }> {
    switch (type) {
      case 'contact': {
        const contact = await this.crm.findContact(principal, id);
        return { label: contact.name };
      }
      case 'company': {
        const company = await this.crm.findCompany(principal, id);
        return { label: company.name };
      }
      case 'deal': {
        const deal = await this.deals.findDeal(principal, id);
        return { label: deal.name };
      }
      default:
        throw AppError.validation('Unknown subject type.', { subjectType: type });
    }
  }

  /**
   * Tell everyone else's open screens. Never awaited and never able to throw:
   * the record is written and audited by the time this runs, and a live
   * update that fails must not turn a saved record into a failed request.
   */
  private announce(
    principal: Principal,
    resource: RealtimeResource,
    action: 'created' | 'updated' | 'deleted',
    recordId: string | null,
  ): void {
    this.realtime.publish(principal.orgId, { resource, action, recordId, actorUserId: principal.userId });
  }

}

function toActivityView(row: AuditLogRow): ActivityView {
  const actorName =
    row.actorFirstName === null && row.actorLastName === null
      ? row.actorEmail
      : [row.actorFirstName, row.actorLastName].filter((p): p is string => p !== null && p !== '').join(' ');
  if (row.action.startsWith(CRM_ACTIVITY_ACTION_PREFIX)) {
    const kind = row.action.slice(CRM_ACTIVITY_ACTION_PREFIX.length);
    const known = CRM_ACTIVITY_KINDS.find((k) => k === kind) ?? null;
    const after = isRecord(row.after) ? row.after : {};
    const occurred = typeof after.occurredAt === 'string' ? after.occurredAt : row.createdAt.toISOString();
    return {
      id: row.id,
      kind: known ?? 'system',
      action: row.action,
      title: known === null ? kind : CRM_ACTIVITY_KIND_LABELS[known],
      body: typeof after.body === 'string' ? after.body : null,
      actorName,
      occurredAt: occurred,
      recordedAt: row.createdAt.toISOString(),
    };
  }
  return {
    id: row.id,
    kind: 'system',
    action: row.action,
    title: SYSTEM_TITLES[row.action] ?? row.action.split('.').pop() ?? row.action,
    body: systemBody(row),
    actorName,
    occurredAt: row.createdAt.toISOString(),
    recordedAt: row.createdAt.toISOString(),
  };
}

/** One line of what changed, for the events worth a line: a stage move names the stages. */
function systemBody(row: AuditLogRow): string | null {
  const before = isRecord(row.before) ? row.before : null;
  const after = isRecord(row.after) ? row.after : null;
  if (row.action === 'crm.deal.stage_changed' || row.action === 'crm.deal.won' || row.action === 'crm.deal.lost' || row.action === 'crm.deal.reopened') {
    const from = before === null ? null : before.stageName;
    const to = after === null ? null : after.stageName;
    if (typeof from === 'string' && typeof to === 'string') return `${from} → ${to}`;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);

}
