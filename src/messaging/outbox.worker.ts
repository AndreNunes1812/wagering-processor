import { EntityManager, LockMode } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';
import { Metrics } from '../metrics';
import { logWarn } from '../log';
import { OutboxMessage } from './outbox-message';
import { OutboxMessageEntity } from './outbox.entity';
import { SqsQueue } from './sqs.client';

@Injectable()
export class OutboxWorker {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsQueue,
    private readonly metrics: Metrics,
  ) {}

  async publishDue(now = new Date()): Promise<number> {
    await this.recordLag(now);
    let done = 0;
    for (let step = 0; step < 50; step++) {
      const worked = await this.publishNext(now);
      if (!worked) break;
      done += 1;
    }
    return done;
  }

  private async recordLag(now: Date): Promise<void> {
    await this.em.transactional(async (em) => {
      const oldest = await em.findOne(
        OutboxMessageEntity,
        { publishedAt: null },
        { orderBy: { occurredAt: 'asc' } },
      );
      const seconds = oldest ? Math.max(0, (now.getTime() - oldest.occurredAt.getTime()) / 1000) : 0;
      this.metrics.outboxLag(seconds);
    });
  }

  private async publishNext(now: Date): Promise<boolean> {
    return this.em.transactional(async (em) => {
      const row = await em.findOne(
        OutboxMessageEntity,
        {
          publishedAt: null,
          $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
        },
        { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, orderBy: { occurredAt: 'asc', id: 'asc' } },
      );
      if (!row) return false;
      try {
        await this.sqs.publishEvent(row.payload, row.aggregateId, row.id);
        row.publishedAt = now;
        row.nextAttemptAt = null;
      } catch (error) {
        const message = OutboxMessage.rehydrate({
          id: row.id,
          aggregateId: row.aggregateId,
          eventType: row.eventType,
          payload: row.payload,
          occurredAt: row.occurredAt,
          attempts: row.attempts,
          nextAttemptAt: row.nextAttemptAt ?? undefined,
          publishedAt: row.publishedAt ?? undefined,
        });
        message.scheduleRetry(now);
        row.attempts = message.attempts;
        row.nextAttemptAt = message.nextAttemptAt ?? null;
        this.metrics.retry('outbox');
        logWarn('outbox.publish_failed', {
          id: row.id,
          message: error instanceof Error ? error.message : 'publish failed',
        });
      }
      return true;
    });
  }
}
