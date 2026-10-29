import { InvalidOperationError } from '../errors';
import { IntegrationEvent } from './events';
import { retryDelaySeconds } from './retry-delay';

export type OutboxMessageState = {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
};

export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue<T>(event: IntegrationEvent<T>): OutboxMessage {
    const body = event.toJSON();
    return new OutboxMessage(
      body.eventId,
      body.aggregateId,
      body.eventType,
      body as unknown as Readonly<Record<string, unknown>>,
      event.occurredAt,
      0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt == null;
  }

  isDue(now: Date): boolean {
    if (!this.isPending()) return false;
    if (!this._nextAttemptAt) return true;
    return this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (this._publishedAt) {
      throw new InvalidOperationError('outbox message already published');
    }
    this._publishedAt = at;
  }

  scheduleRetry(now: Date): void {
    if (this._publishedAt) {
      throw new InvalidOperationError('outbox message already published');
    }
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + retryDelaySeconds(this._attempts) * 1000);
  }
}
