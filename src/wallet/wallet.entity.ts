import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';
import { NumericStringType } from '../database/numeric-string.type';

@Entity({ tableName: 'wallets' })
@Unique({ name: 'wallets_player_currency', properties: ['playerId', 'currency'] })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'player_id', type: 'uuid' })
  playerId!: string;

  @Property({ type: 'text' })
  currency!: string;

  @Property({ type: NumericStringType, fieldName: 'balance_amount' })
  balanceAmount!: string;

  @Property({ type: 'integer' })
  version!: number;

  @Property({ fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt!: Date;

  @Property({ fieldName: 'updated_at', columnType: 'timestamptz' })
  updatedAt!: Date;
}
