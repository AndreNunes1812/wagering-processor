import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { logWarn } from '../log';
import { PendingReferenceWorker } from '../wagering/pending-reference.worker';
import { OutboxWorker } from './outbox.worker';
import { WageringConsumer } from './wagering.consumer';

@Injectable()
export class ProcessorLoop implements OnApplicationBootstrap, OnApplicationShutdown {
  private stopped = false;
  private running: Promise<void> | undefined;

  constructor(
    private readonly pending: PendingReferenceWorker,
    private readonly outbox: OutboxWorker,
    private readonly consumer: WageringConsumer,
  ) {}

  onApplicationBootstrap(): void {
    this.running = this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    await this.consumer.releaseInflight();
    await this.running;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.pending.reprocessDue();
        await this.outbox.publishDue();
        await this.consumer.pollOnce(20);
      } catch (error) {
        if (this.stopped) break;
        logWarn('processor.tick_failed', {
          message: error instanceof Error ? error.message : 'tick failed',
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
}
