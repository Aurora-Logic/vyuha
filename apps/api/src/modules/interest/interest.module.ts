import { Module } from '@nestjs/common';

import { InterestBuildService } from './interest-build.service.js';
import { InterestController } from './interest.controller.js';
import { InterestReportSource } from './interest-report.source.js';
import { InterestService } from './interest.service.js';
import { InterestSnapshotHandler } from './interest-snapshot.handler.js';

/**
 * The interest cost module (D-22). Reads the Tally projection, writes only
 * its own snapshot and override tables, and surfaces everything through the
 * report shell — no bespoke screen owns a figure the exporter cannot see.
 */
@Module({
  controllers: [InterestController],
  providers: [InterestBuildService, InterestService, InterestSnapshotHandler, InterestReportSource],
})
export class InterestModule {}
