import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { AttendanceModule } from './modules/attendance/attendance.module.js';
import { CrmModule } from './modules/crm/crm.module.js';
import { SalesModule } from './modules/sales/sales.module.js';
import { PurchaseModule } from './modules/purchase/purchase.module.js';
import { InterestModule } from './modules/interest/interest.module.js';
import { AuditContextMiddleware } from './platform/audit/audit-context.middleware.js';
import { AuditInterceptor } from './platform/audit/audit.interceptor.js';
import { AuditModule } from './platform/audit/audit.module.js';
import { AuthModule } from './platform/auth/auth.module.js';
import { ConsentModule } from './platform/consent/consent.module.js';
import { AppExceptionFilter } from './platform/common/app-exception.filter.js';
import { WILDCARD_ROUTE } from './platform/common/constants.js';
import { pinoParams } from './platform/common/logging.js';
import { RequestIdMiddleware } from './platform/common/request-id.middleware.js';
import { ZodValidationPipe } from './platform/common/zod-validation.pipe.js';
import { DbModule } from './platform/db/db.module.js';
import { ExportModule } from './platform/export/export.module.js';
import { FileModule } from './platform/files/file.module.js';
import { HealthModule } from './platform/health/health.module.js';
import { HelpModule } from './platform/help/help.module.js';
import { IntegrationModule } from './platform/integration/integration.module.js';
import { JobsModule } from './platform/jobs/jobs.module.js';
import { MailModule } from './platform/mail/mail.module.js';
import { MastersModule } from './platform/masters/masters.module.js';
import { NotificationsModule } from './platform/notifications/notifications.module.js';
import { OrgModule } from './platform/org/org.module.js';
import { PeopleModule } from './platform/people/people.module.js';
import { AccessGuard } from './platform/rbac/access.guard.js';
import { RbacModule } from './platform/rbac/rbac.module.js';
import { RecycleBinModule } from './platform/recycle-bin/recycle-bin.module.js';
import { RedisModule } from './platform/redis/redis.module.js';
import { SearchModule } from './platform/search/search.module.js';
import { SettingsModule } from './platform/settings/settings.module.js';
import { SyncModule } from './platform/sync/sync.module.js';
import { TasksModule } from './platform/tasks/tasks.module.js';
import { DocumentsModule } from './platform/documents/documents.module.js';
import { CollectionsModule } from './platform/collections/collections.module.js';
import { PortalModule } from './platform/portal/portal.module.js';
import { PricingModule } from './platform/pricing/pricing.module.js';
import { StorageModule } from './platform/storage/storage.module.js';

/**
 * Technical design §1: `platform/` is the shared kernel and `modules/` sits on
 * top of it. Attendance, CRM, and ERP will be imported here and nowhere else.
 *
 * The filter, pipe, guard, and interceptor are registered as providers rather
 * than through `app.useGlobal*`, so they take part in dependency injection --
 * `AccessGuard` needs the database and `AuditInterceptor` needs the audit
 * service, neither of which a manually constructed instance could reach.
 *
 * The four global bindings, and what each one guarantees:
 *
 * - `AccessGuard`    every route is denied unless it declares a policy
 * - `ZodValidationPipe`  every annotated body is parsed before the handler
 * - `AuditInterceptor`   every successful mutation leaves a row (REQ-M-01)
 * - `AppExceptionFilter` every failure leaves as the §6 envelope
 */
@Module({
  imports: [
    LoggerModule.forRoot(pinoParams()),
    DbModule,
    RedisModule,
    MailModule,
    StorageModule,
    AuditModule,
    RbacModule,
    // Before every module that registers a soft-deletable record with it.
    // Nest resolves the graph rather than the array order, but reading it in
    // dependency order is how a reader learns that the registry exists.
    RecycleBinModule,
    FileModule,
    JobsModule,
    NotificationsModule,
    AuthModule,
    ConsentModule,
    OrgModule,
    // Before PeopleModule, whose employee source registers into it on init.
    SearchModule,
    // Before AttendanceModule, whose report source registers into it on init.
    ExportModule,
    MastersModule,
    PeopleModule,
    SettingsModule,
    // Before IntegrationModule, whose token issuance mints through it, and
    // reachable by AccessGuard, which resolves agent credentials through it.
    SyncModule,
    TasksModule,
    DocumentsModule,
    // Area AN: price lists; before SalesModule, whose lines resolve through its resolver.
    PricingModule,
    // Area AJ: after TasksModule (its party subject registers into that registry) and MastersModule.
    CollectionsModule,
    PortalModule,
    IntegrationModule,
    HealthModule,
    HelpModule,
    // The first `modules/` entry. Everything above it is the shared kernel;
    // CRM and ERP will sit beside this one and import nothing from it.
    AttendanceModule,
    CrmModule,
    SalesModule,
    PurchaseModule,
    InterestModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AppExceptionFilter },
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Order matters: the audit context must be open before anything the
    // request does can try to record into it.
    consumer.apply(RequestIdMiddleware, AuditContextMiddleware).forRoutes(WILDCARD_ROUTE);
  }
}
