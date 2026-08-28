import { Module } from '@nestjs/common';

import { ReceivableSnapshotHandler } from './receivable-snapshot.handler.js';
import { MailModule } from '../../platform/mail/mail.module.js';
import { SettingsModule } from '../../platform/settings/settings.module.js';
import { CfoNightlyService } from './cfo-nightly.service.js';
import { BrandService } from './brand.service.js';
import { AnalyticsService } from './analytics.service.js';
import { AlertsService } from './alerts.service.js';
import { CfoExportService } from './cfo-export.service.js';
import { CfoController } from './cfo.controller.js';
import { CreditControlService } from './credit-control.service.js';
import { MyCfoService } from './my-cfo.service.js';
import { OwnerMapService } from './attribution/owner-map.service.js';
import { ReceivableSnapshotService } from './receivable-snapshot.service.js';
import { MarginService } from './margin.service.js';
import { DataQualityService } from './data-quality.service.js';
import { ExceptionsService } from './exceptions.service.js';
import { DeskService } from './desk.service.js';
import { PenetrationService } from './penetration.service.js';
import { SalesAnalysisService } from './sales-analysis.service.js';
import { SalesFactService } from './sales-fact.service.js';
import { TierService } from './tier.service.js';
import { TeamService } from './team.service.js';

/**
 * The Virtual CFO module (owner's brief §0.10, D-23). Born as one nightly
 * job and one fact table, before any endpoint or screen: the trends the
 * module will one day draw need daily history that cannot be reconstructed
 * later, so the recorder ships first and the UI catches up.
 */
@Module({
  imports: [SettingsModule, MailModule],
  controllers: [CfoController],
  providers: [ReceivableSnapshotService, ReceivableSnapshotHandler, OwnerMapService, SalesFactService, CreditControlService, MyCfoService, TeamService, SalesAnalysisService, DeskService, DataQualityService, PenetrationService, TierService, ExceptionsService, CfoExportService, AlertsService, CfoNightlyService, MarginService, BrandService, AnalyticsService],
})
export class CfoModule {}
