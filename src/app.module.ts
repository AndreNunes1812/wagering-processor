import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { MessagingModule } from './messaging/messaging.module';
import { MetricsModule } from './metrics.module';
import { WalletModule } from './wallet/wallet.module';
import { WageringModule } from './wagering/wagering.module';

@Module({
  imports: [MetricsModule, DatabaseModule, WalletModule, WageringModule, MessagingModule, HealthModule],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
