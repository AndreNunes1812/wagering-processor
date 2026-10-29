import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { HealthController } from './health.controller';

@Module({
  imports: [MessagingModule],
  controllers: [HealthController],
})
export class HealthModule {}
