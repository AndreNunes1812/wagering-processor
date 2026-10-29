import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'inbox_messages' })
export class InboxMessageEntity {
  @PrimaryKey({ fieldName: 'consumer_name', type: 'text' })
  consumerName!: string;

  @PrimaryKey({ fieldName: 'message_id', type: 'text' })
  messageId!: string;

  @Property({ fieldName: 'payload_hash', type: 'text' })
  payloadHash!: string;

  @Property({ fieldName: 'received_at', columnType: 'timestamptz' })
  receivedAt!: Date;

  @Property({ fieldName: 'processed_at', columnType: 'timestamptz', nullable: true })
  processedAt: Date | null = null;
}
