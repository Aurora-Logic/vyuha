import { Module } from '@nestjs/common';

import { ReceivableSnapshotHandler } from './receivable-snapshot.handler.js';
import { ReceivableSnapshotService } from './receivable-snapshot.service.js';

/**
 * The Virtual CFO module (owner's brief §0.10, D-23). Born as one nightly
 * job and one fact table, before any endpoint or screen: the trends the
 * module will one day draw need daily history that cannot be reconstructed
 * later, so the recorder ships first and the UI catches up.
 */
@Module({
  providers: [ReceivableSnapshotService, ReceivableSnapshotHandler],
})
export class CfoModule {}
