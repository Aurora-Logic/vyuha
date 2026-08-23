import { Module } from '@nestjs/common';

import { DocumentsModule } from '../documents/documents.module.js';

import { MastersController } from './masters.controller.js';
import { DuplicateDetectorHandler } from './duplicate-detector.handler.js';
import { DuplicatesService } from './duplicates.service.js';
import { LifecycleAnalyticsService } from './lifecycle-analytics.service.js';
import { LifecycleService } from './lifecycle.service.js';
import { MastersService } from './masters.service.js';
import { PartyGoToSource } from './party-goto.source.js';
import { AnalyticsReportSource } from './analytics-report.source.js';
import { ExceptionSweepHandler } from './exception-sweep.handler.js';
import { TallyReportSource } from './tally-report.source.js';
import { VoucherGoToSource } from './voucher-goto.source.js';

/**
 * The Tally masters projection's read surface (09 §5). Nothing is imported
 * and nothing writes: the projection's one writer lives in `platform/sync`,
 * and this module is what lets every other consumer say "I only read".
 */
@Module({
  // Read-only still: the documents module lends the voucher export its sheet writer and the design settings.
  imports: [DocumentsModule],
  controllers: [MastersController],
  providers: [MastersService, DuplicatesService, DuplicateDetectorHandler, LifecycleService, LifecycleAnalyticsService, PartyGoToSource, VoucherGoToSource, TallyReportSource, AnalyticsReportSource, ExceptionSweepHandler],
  exports: [MastersService],
})
export class MastersModule {}
