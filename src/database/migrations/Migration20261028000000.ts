import { Migration } from '@mikro-orm/migrations';

export class Migration20261028000000 extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency text not null,
        balance_amount numeric(20, 2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency unique (player_id, currency),
        constraint wallets_balance_non_negative check (balance_amount >= 0),
        constraint wallets_version_positive check (version >= 1),
        constraint wallets_currency_code check (currency ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null references wallets (id),
        player_id uuid not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(20, 2) not null,
        currency text not null,
        reference_external_transaction_id text null,
        status text not null,
        reference_transaction_id uuid null references wager_transactions (id),
        failure_code text null,
        result_balance_amount numeric(20, 2) null,
        result_balance_currency text null,
        attempt_count integer not null default 0,
        next_attempt_at timestamptz null,
        created_at timestamptz not null,
        processed_at timestamptz null,
        constraint wager_transactions_idempotency unique (idempotency_key),
        constraint wager_transactions_provider_external unique (provider_id, external_transaction_id),
        constraint wager_transactions_amount_positive check (amount > 0),
        constraint wager_transactions_attempt_count_non_negative check (attempt_count >= 0),
        constraint wager_transactions_kind check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_transactions_status check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_currency_code check (currency ~ '^[A-Z]{3}$'),
        constraint wager_transactions_reference_when_required check (
          (kind in ('REFUND', 'ROLLBACK') and reference_external_transaction_id is not null)
          or kind not in ('REFUND', 'ROLLBACK')
        )
      );
    `);

    this.addSql(`
      create unique index wager_transactions_one_successful_reversal
        on wager_transactions (provider_id, reference_external_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);

    this.addSql(`
      create index wager_transactions_pending_reference
        on wager_transactions (next_attempt_at)
        where status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null references wallets (id),
        transaction_id uuid not null references wager_transactions (id),
        direction text not null,
        amount numeric(20, 2) not null,
        currency text not null,
        balance_before numeric(20, 2) not null,
        balance_after numeric(20, 2) not null,
        created_at timestamptz not null,
        constraint wallet_ledger_entries_one_per_transaction unique (transaction_id),
        constraint wallet_ledger_entries_direction check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_amount_positive check (amount > 0),
        constraint wallet_ledger_entries_currency_code check (currency ~ '^[A-Z]{3}$'),
        constraint wallet_ledger_entries_balance_non_negative check (balance_before >= 0 and balance_after >= 0),
        constraint wallet_ledger_entries_balanced check (
          (direction = 'CREDIT' and balance_before + amount = balance_after)
          or (direction = 'DEBIT' and balance_before - amount = balance_after)
        )
      );
    `);

    this.addSql(`
      create index wallet_ledger_entries_wallet_created
        on wallet_ledger_entries (wallet_id, created_at, id);
    `);

    this.addSql(`
      create function prevent_ledger_mutation() returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'ledger entries are immutable';
      end;
      $$;
    `);

    this.addSql(`
      create trigger wallet_ledger_entries_no_mutation
      before update or delete on wallet_ledger_entries
      for each row execute function prevent_ledger_mutation();
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz null,
        primary key (consumer_name, message_id)
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id text not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz null,
        published_at timestamptz null,
        constraint outbox_messages_attempts_non_negative check (attempts >= 0)
      );
    `);

    this.addSql(`
      create index outbox_messages_due
        on outbox_messages (next_attempt_at nulls first, id)
        where published_at is null;
    `);
  }

  override down(): void {
    this.addSql('drop table if exists outbox_messages;');
    this.addSql('drop table if exists inbox_messages;');
    this.addSql('drop table if exists wallet_ledger_entries;');
    this.addSql('drop function if exists prevent_ledger_mutation();');
    this.addSql('drop table if exists wager_transactions;');
    this.addSql('drop table if exists wallets;');
  }
}
