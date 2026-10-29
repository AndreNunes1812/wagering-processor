import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'aggregate_id', type: 'text' })
  aggregateId!: string;

  @Property({ fieldName: 'event_type', type: 'text' })
  eventType!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Property({ fieldName: 'occurred_at', columnType: 'timestamptz' })
  occurredAt!: Date;

  @Property({ type: 'integer' })
  attempts!: number;

  @Property({ fieldName: 'next_attempt_at', columnType: 'timestamptz', nullable: true })
  nextAttemptAt: Date | null = null;

  @Property({ fieldName: 'published_at', columnType: 'timestamptz', nullable: true })
  publishedAt: Date | null = null;
}
