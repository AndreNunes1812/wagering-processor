import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { PendingReferenceWorker } from './pending-reference.worker';
import { WageringController } from './wagering.controller';
import { WageringService } from './wagering.service';

@Module({
  imports: [WalletModule],
  controllers: [WageringController],
  providers: [WageringService, PendingReferenceWorker],
  exports: [WageringService, PendingReferenceWorker],
})
export class WageringModule {}
