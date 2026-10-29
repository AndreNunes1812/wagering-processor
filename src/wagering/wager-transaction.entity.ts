import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';
import { NumericStringType } from '../database/numeric-string.type';

@Entity({ tableName: 'wager_transactions' })
@Unique({ name: 'wager_transactions_idempotency', properties: ['idempotencyKey'] })
@Unique({
  name: 'wager_transactions_provider_external',
  properties: ['providerId', 'externalTransactionId'],
})
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'provider_id', type: 'text' })
  providerId!: string;

  @Property({ fieldName: 'external_transaction_id', type: 'text' })
  externalTransactionId!: string;

  @Property({ fieldName: 'idempotency_key', type: 'text' })
  idempotencyKey!: string;

  @Property({ fieldName: 'payload_hash', type: 'text' })
  payloadHash!: string;

  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'player_id', type: 'uuid' })
  playerId!: string;

  @Property({ fieldName: 'round_id', type: 'text' })
  roundId!: string;

  @Property({ fieldName: 'game_id', type: 'text' })
  gameId!: string;

  @Property({ type: 'text' })
  kind!: string;

  @Property({ type: NumericStringType })
  amount!: string;

  @Property({ type: 'text' })
  currency!: string;

  @Property({ fieldName: 'reference_external_transaction_id', type: 'text', nullable: true })
  referenceExternalTransactionId: string | null = null;

  @Property({ type: 'text' })
  status!: string;

  @Property({ fieldName: 'reference_transaction_id', type: 'uuid', nullable: true })
  referenceTransactionId: string | null = null;

  @Property({ fieldName: 'failure_code', type: 'text', nullable: true })
  failureCode: string | null = null;

  @Property({ type: NumericStringType, fieldName: 'result_balance_amount', nullable: true })
  resultBalanceAmount: string | null = null;

  @Property({ fieldName: 'result_balance_currency', type: 'text', nullable: true })
  resultBalanceCurrency: string | null = null;

  @Property({ fieldName: 'attempt_count', type: 'integer' })
  attemptCount!: number;

  @Property({ fieldName: 'next_attempt_at', columnType: 'timestamptz', nullable: true })
  nextAttemptAt: Date | null = null;

  @Property({ fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt!: Date;

  @Property({ fieldName: 'processed_at', columnType: 'timestamptz', nullable: true })
  processedAt: Date | null = null;
}
