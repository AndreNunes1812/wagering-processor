import { Module } from '@nestjs/common';
import { WageringModule } from '../wagering/wagering.module';
import { OutboxWorker } from './outbox.worker';
import { ProcessorLoop } from './processor-loop';
import { SqsQueue } from './sqs.client';
import { WageringConsumer } from './wagering.consumer';

@Module({
  imports: [WageringModule],
  providers: [SqsQueue, WageringConsumer, OutboxWorker, ProcessorLoop],
  exports: [SqsQueue, WageringConsumer, OutboxWorker],
})
export class MessagingModule {}
