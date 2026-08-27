import { Module } from '@nestjs/common';

import { ReceivableSnapshotHandler } from './receivable-snapshot.handler.js';
import { SettingsModule } from '../../platform/settings/settings.module.js';
import { CfoController } from './cfo.controller.js';
import { CreditControlService } from './credit-control.service.js';
import { MyCfoService } from './my-cfo.service.js';
import { OwnerMapService } from './attribution/owner-map.service.js';
import { ReceivableSnapshotService } from './receivable-snapshot.service.js';
import { DeskService } from './desk.service.js';
import { SalesAnalysisService } from './sales-analysis.service.js';
import { SalesFactService } from './sales-fact.service.js';
import { TeamService } from './team.service.js';

/**
 * The Virtual CFO module (owner's brief §0.10, D-23). Born as one nightly
 * job and one fact table, before any endpoint or screen: the trends the
 * module will one day draw need daily history that cannot be reconstructed
 * later, so the recorder ships first and the UI catches up.
 */
@Module({
  imports: [SettingsModule],
  controllers: [CfoController],
  providers: [ReceivableSnapshotService, ReceivableSnapshotHandler, OwnerMapService, SalesFactService, CreditControlService, MyCfoService, TeamService, SalesAnalysisService, DeskService],
})
export class CfoModule {}
