import { Injectable } from '@nestjs/common';
import {
  DEFAULT_MASTER_SORT,
  MASTER_SORT_FIELDS,
  pageSlice,
  paginated,
  parseSort,
  type LocationSummary,
  type MasterListQuery,
  type Paginated,
} from '@vyuha/shared';
import { eq } from 'drizzle-orm';

import { AuditContext } from '../audit/audit-context.js';
import { AppError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { isUniqueViolation } from '../db/pg-error.js';
import { locations } from '../db/schema/index.js';
import { ScopedRepository, type Row } from '../db/scoped-repository.js';
import { orgContextOf, type Principal } from '../rbac/principal.js';
import { assertHolidayCalendarInOrg } from './holiday-calendar-ref.js';
import { codeTakenError } from './master-errors.js';
import { masterOrderBy, masterSearch } from './master-query.js';
import type { CreateLocationBody, UpdateLocationBody } from './org.dto.js';

/**
 * Locations (REQ-A-01).
 *
 * The geofence centre and the IP allowlist are writable here, and both are
 * empty until answered (docs/OPEN-QUESTIONS items 1 and 3). Nothing in this
 * file supplies a default for either: a guessed centre would make geofenced
 * punch appear to work while rejecting the people standing in the office, and
 * an allowlist populated with a guess would let punches through from wherever
 * that guess happens to point.
 *
 * `geofence_radius_m` is the one exception, and only because the column is NOT
 * NULL with a 100 m default. A radius without a centre does nothing.
 */

const SORT_COLUMNS = { name: locations.name, code: locations.code } as const;

/**
 * `LocationSummary` plus the holiday calendar link (OS-3, REQ-H-02). Declared
 * beside the service rather than in `@vyuha/shared` for the reason the DTO
 * gives: the id is validated against an attendance-owned table.
 */
export interface LocationView extends LocationSummary {
  readonly holidayCalendarId: string | null;
}

@Injectable()
export class LocationService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly auditContext: AuditContext,
  ) {}

  async list(principal: Principal, query: MasterListQuery): Promise<Paginated<LocationView>> {
    const repository = this.repository(principal);
    const { limit, offset } = pageSlice(query);
    const where =
      query.q === undefined ? undefined : masterSearch(query.q, [locations.name, locations.code]);

    const rows = await repository.findMany({
      ...(where === undefined ? {} : { where }),
      orderBy: masterOrderBy(
        parseSort(query.sort ?? DEFAULT_MASTER_SORT, MASTER_SORT_FIELDS),
        SORT_COLUMNS,
        locations.name,
        locations.id,
      ),
      limit,
      offset,
    });

    return paginated(rows.map(toSummary), query, await repository.count(where));
  }

  async create(principal: Principal, input: CreateLocationBody): Promise<LocationView> {
    const repository = this.repository(principal);
    if ((await this.findIdByCode(repository, input.code)) !== null) {
      throw codeTakenError('location', input.code);
    }
    assertGeofenceIsWholeOrAbsent(input.geofenceLat ?? null, input.geofenceLng ?? null);
    await assertHolidayCalendarInOrg(this.db, principal.orgId, input.holidayCalendarId);

    let created: Row<typeof locations>;
    try {
      created = await repository.insert(input);
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw codeTakenError('location', input.code, error);
      throw error;
    }

    const summary = toSummary(created);
    this.auditContext.record({
      action: 'location.created',
      entityType: 'location',
      entityId: summary.id,
      before: null,
      after: summary,
    });

    return summary;
  }

  async update(
    principal: Principal,
    id: string,
    input: UpdateLocationBody,
  ): Promise<LocationView> {
    const repository = this.repository(principal);
    const existing = await repository.findById(id);
    if (existing === null) throw AppError.notFound('Location', id);

    if (input.code !== undefined && input.code !== existing.code) {
      const clash = await this.findIdByCode(repository, input.code);
      if (clash !== null && clash !== id) throw codeTakenError('location', input.code);
    }

    // A centre is a pair. Half of one is not a weaker geofence, it is a
    // geofence the punch path cannot evaluate, and it would sit in the
    // database looking configured.
    assertGeofenceIsWholeOrAbsent(
      input.geofenceLat !== undefined ? input.geofenceLat : existing.geofenceLat,
      input.geofenceLng !== undefined ? input.geofenceLng : existing.geofenceLng,
    );
    await assertHolidayCalendarInOrg(this.db, principal.orgId, input.holidayCalendarId);

    const updated = await repository.update(id, input);
    if (updated === null) throw AppError.notFound('Location', id);

    this.auditContext.record({
      action: 'location.updated',
      entityType: 'location',
      entityId: id,
      before: toSummary(existing),
      after: toSummary(updated),
    });

    return toSummary(updated);
  }

  private repository(principal: Principal): ScopedRepository<typeof locations> {
    return new ScopedRepository(this.db, locations, orgContextOf(principal));
  }

  private async findIdByCode(
    repository: ScopedRepository<typeof locations>,
    code: string,
  ): Promise<string | null> {
    const row = await repository.findOne(eq(locations.code, code));
    return row?.id ?? null;
  }
}

function assertGeofenceIsWholeOrAbsent(lat: number | null, lng: number | null): void {
  if ((lat === null) === (lng === null)) return;
  throw AppError.validation('A geofence centre needs both a latitude and a longitude.', {
    fields: [
      { path: lat === null ? 'geofenceLat' : 'geofenceLng', message: 'required alongside the other' },
    ],
  });
}

function toSummary(row: Row<typeof locations>): LocationView {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    address: row.address,
    timezone: row.timezone,
    geofenceLat: row.geofenceLat,
    geofenceLng: row.geofenceLng,
    geofenceRadiusM: row.geofenceRadiusM,
    ipAllowlist: row.ipAllowlist,
    holidayCalendarId: row.holidayCalendarId,
  };
}
