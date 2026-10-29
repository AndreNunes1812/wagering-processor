import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { config } from '../config';
import { LedgerEntryEntity } from '../ledger/ledger-entry.entity';
import { InboxMessageEntity } from '../messaging/inbox.entity';
import { OutboxMessageEntity } from '../messaging/outbox.entity';
import { WalletEntity } from '../wallet/wallet.entity';
import { WagerTransactionEntity } from '../wagering/wager-transaction.entity';

export default defineConfig({
  host: config.database.host,
  port: config.database.port,
  user: config.database.user,
  password: config.database.password,
  dbName: config.database.name,
  entities: [
    WalletEntity,
    WagerTransactionEntity,
    LedgerEntryEntity,
    InboxMessageEntity,
    OutboxMessageEntity,
  ],
  metadataProvider: ReflectMetadataProvider,
  extensions: [Migrator],
  ensureDatabase: false,
  driverOptions: {
    connectionTimeoutMillis: 2000,
  },
  migrations: {
    path: 'dist/database/migrations',
    pathTs: 'src/database/migrations',
  },
});
