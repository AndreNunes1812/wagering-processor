import { createHash } from 'node:crypto';
import { DeadlockException, EntityManager } from '@mikro-orm/core';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { constraintOf } from '../database/constraint';
import { logInfo, logWarn } from '../log';
import { Metrics } from '../metrics';
import { config } from '../config';
import { WageringService } from '../wagering/wagering.service';
import { InboxMessageEntity } from './inbox.entity';
import { retryDelaySeconds } from './retry-delay';
import { traced } from '../trace';
import { SqsQueue, type ReceivedMessage } from './sqs.client';

const CONSUMER = 'wagering-processor';
const RECEIVE_LIMIT = 5;

export type Delivery = 'ack' | 'retry' | 'dlq';

@Injectable()
export class WageringConsumer {
  private readonly inflight = new Set<string>();
  private stopping = false;
  private readonly abort = new AbortController();

  constructor(
    private readonly em: EntityManager,
    private readonly wagering: WageringService,
    private readonly sqs: SqsQueue,
    private readonly metrics: Metrics,
  ) {}

  async pollOnce(waitSeconds = 1): Promise<void> {
    if (this.stopping) return;
    const messages = await this.sqs.receive(config.sqs.wagerQueueUrl, 10, waitSeconds, 30, this.abort.signal);
    for (const message of messages) {
      await this.handle(message);
    }
  }

  async settle(body: string, messageId: string): Promise<Delivery> {
    return traced('wager.consume', { messageId }, () => this.readDelivery(body, messageId));
  }

  private async readDelivery(body: string, messageId: string): Promise<Delivery> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return 'dlq';
    }
    const envelope = asEnvelope(parsed);
    if (!envelope) return 'dlq';

    try {
      let duplicate = false;
      let logged: Record<string, string | undefined> = {};
      await this.em.transactional(async (tx) => {
        const inbox = await tx.findOne(InboxMessageEntity, { consumerName: CONSUMER, messageId });
        if (inbox?.processedAt) {
          duplicate = true;
          return;
        }
        const row = inbox ?? new InboxMessageEntity();
        if (!inbox) {
          row.consumerName = CONSUMER;
          row.messageId = messageId;
          row.payloadHash = createHash('sha256').update(body).digest('hex');
          row.receivedAt = new Date();
          row.processedAt = null;
          tx.persist(row);
        }
        const outcome = await this.wagering.applyIn(tx, envelope.idempotencyKey, envelope.data, messageId);
        row.processedAt = new Date();
        logged = {
          transactionId: stringField(outcome.body.transactionId),
          walletId: stringField(envelope.data.walletId),
          providerId: stringField(envelope.data.providerId),
          status: stringField(outcome.body.status),
          failureCode: stringField(outcome.body.failureCode),
        };
      });
      if (duplicate) {
        this.metrics.duplicates();
        logInfo('wager.consumed', { messageId, correlationId: messageId, duplicate: true });
        return 'ack';
      }
      logInfo('wager.consumed', { messageId, correlationId: messageId, ...logged });
      return 'ack';
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ConflictException) return 'dlq';
      if (error instanceof DeadlockException) this.metrics.lockConflict();
      if (constraintOf(error) === 'inbox_messages_pkey') {
        const inbox = await this.em.fork().findOne(InboxMessageEntity, { consumerName: CONSUMER, messageId });
        if (inbox?.processedAt) {
          this.metrics.duplicates();
          return 'ack';
        }
      }
      if (!(error instanceof NotFoundException) && !(error instanceof DeadlockException)) {
        logWarn('wager.consume_failed', {
          messageId,
          message: error instanceof Error ? error.message : 'consume failed',
        });
      }
      return 'retry';
    }
  }

  async releaseInflight(waitMs = 5_000): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    const deadline = Date.now() + waitMs;
    while (this.inflight.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const pending = [...this.inflight];
    await Promise.all(
      pending.map((receipt) => this.sqs.changeVisibility(config.sqs.wagerQueueUrl, receipt, 0)),
    );
  }

  async handle(message: ReceivedMessage): Promise<void> {
    this.inflight.add(message.receiptHandle);
    try {
      if (this.stopping) return;
      const outcome = nextStep(await this.settle(message.body, message.messageId), message.receiveCount);
      if (this.stopping) return;
      if (outcome === 'dlq') {
        await this.sqs.send(
          config.sqs.dlqQueueUrl,
          message.body,
          message.messageId,
          `dlq-${message.messageId}-${message.receiveCount}`,
        );
        await this.sqs.delete(config.sqs.wagerQueueUrl, message.receiptHandle);
        this.metrics.dlq();
        return;
      }
      if (outcome === 'ack') {
        await this.sqs.delete(config.sqs.wagerQueueUrl, message.receiptHandle);
        return;
      }
      await this.sqs.changeVisibility(
        config.sqs.wagerQueueUrl,
        message.receiptHandle,
        retryDelaySeconds(message.receiveCount),
      );
      this.metrics.retry('sqs');
    } finally {
      this.inflight.delete(message.receiptHandle);
    }
  }
}

export function nextStep(outcome: Delivery, receiveCount: number): Delivery {
  if (outcome === 'ack') return 'ack';
  if (outcome === 'dlq' || receiveCount >= RECEIVE_LIMIT) return 'dlq';
  return 'retry';
}

function asEnvelope(value: unknown): { idempotencyKey: string; data: Record<string, unknown> } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as { type?: unknown; data?: unknown };
  if (record.type !== 'WagerTransactionRequested') return undefined;
  if (typeof record.data !== 'object' || record.data === null || Array.isArray(record.data)) return undefined;
  const data = record.data as Record<string, unknown>;
  if (typeof data.idempotencyKey !== 'string' || data.idempotencyKey.trim() === '') return undefined;
  return { idempotencyKey: data.idempotencyKey, data };
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
