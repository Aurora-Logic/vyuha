import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { InjectDatabase, type Database } from '../db/db.provider.js';
import { employees } from '../db/schema/index.js';
import type { Principal } from '../rbac/principal.js';

/**
 * A signed-in person's name, as a colleague would read it.
 *
 * The email is the fallback rather than the answer because an account can
 * exist with no employee record (REQ-B-02) -- an administrator set up before
 * anyone was hired has nothing else to show. Everywhere else, showing
 * `priya@…` where the rest of the screen says "Priya Kulkarni" reads as a
 * different person.
 *
 * Lifted out of `TaskService`, which had it private, when the live stream
 * needed the third copy of it.
 */
@Injectable()
export class ActorNameService {
  constructor(@InjectDatabase() private readonly db: Database) {}

  async of(principal: Principal): Promise<string> {
    if (principal.employeeId === null) return principal.email;
    const rows = await this.db
      .select({ firstName: employees.firstName, lastName: employees.lastName })
      .from(employees)
      .where(eq(employees.id, principal.employeeId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return principal.email;
    const name = [row.firstName, row.lastName].filter((part) => part !== null && part !== '').join(' ');
    return name === '' ? principal.email : name;
  }
}
