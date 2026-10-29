import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';
import { NumericStringType } from '../database/numeric-string.type';

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({ name: 'wallet_ledger_entries_one_per_transaction', properties: ['transactionId'] })
export class LedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'transaction_id', type: 'uuid' })
  transactionId!: string;

  @Property({ type: 'text' })
  direction!: string;

  @Property({ type: NumericStringType })
  amount!: string;

  @Property({ type: 'text' })
  currency!: string;

  @Property({ type: NumericStringType, fieldName: 'balance_before' })
  balanceBefore!: string;

  @Property({ type: NumericStringType, fieldName: 'balance_after' })
  balanceAfter!: string;

  @Property({ fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt!: Date;
}
