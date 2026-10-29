import { LedgerEntryEntity } from '../ledger/ledger-entry.entity';
import { LedgerDirection, WalletLedgerEntry } from '../ledger/ledger-entry';
import { Money } from '../money/money';
import { OutboxMessageEntity } from '../messaging/outbox.entity';
import { OutboxMessage } from '../messaging/outbox-message';
import type { IntegrationEvent } from '../messaging/events';
import { Wallet } from '../wallet/wallet';
import { WalletEntity } from '../wallet/wallet.entity';
import { WagerTransactionEntity } from '../wagering/wager-transaction.entity';
import { WagerTransaction } from '../wagering/wager-transaction';

export function walletRow(wallet: Wallet): WalletEntity {
  const row = new WalletEntity();
  row.id = wallet.id;
  row.playerId = wallet.playerId;
  row.currency = wallet.currency;
  copyWallet(row, wallet);
  row.createdAt = wallet.createdAt;
  return row;
}

export function copyWallet(row: WalletEntity, wallet: Wallet): void {
  row.balanceAmount = wallet.balance.toJSON().amount;
  row.version = wallet.version;
  row.updatedAt = wallet.updatedAt;
}

export function walletFromRow(row: WalletEntity): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: storedMoney(row.balanceAmount, row.currency),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function transactionRow(transaction: WagerTransaction, result?: Money): WagerTransactionEntity {
  const row = new WagerTransactionEntity();
  row.id = transaction.id;
  row.providerId = transaction.providerId;
  row.externalTransactionId = transaction.externalTransactionId;
  row.idempotencyKey = transaction.idempotencyKey;
  row.payloadHash = transaction.payloadHash;
  row.walletId = transaction.walletId;
  row.playerId = transaction.playerId;
  row.roundId = transaction.roundId;
  row.gameId = transaction.gameId;
  row.kind = transaction.kind;
  row.amount = transaction.money.toJSON().amount;
  row.currency = transaction.money.currency;
  row.referenceExternalTransactionId = transaction.referenceExternalTransactionId ?? null;
  row.status = transaction.status;
  row.referenceTransactionId = transaction.referenceTransactionId ?? null;
  row.failureCode = transaction.failureCode ?? null;
  row.resultBalanceAmount = result ? result.toJSON().amount : null;
  row.resultBalanceCurrency = result ? result.currency : null;
  row.attemptCount = 0;
  row.createdAt = transaction.createdAt;
  row.processedAt = transaction.processedAt ?? null;
  return row;
}

export function copyTransaction(row: WagerTransactionEntity, transaction: WagerTransaction, result?: Money): void {
  row.status = transaction.status;
  row.referenceTransactionId = transaction.referenceTransactionId ?? null;
  row.failureCode = transaction.failureCode ?? null;
  row.resultBalanceAmount = result ? result.toJSON().amount : null;
  row.resultBalanceCurrency = result ? result.currency : null;
  row.processedAt = transaction.processedAt ?? null;
}

export function ledgerRow(entry: WalletLedgerEntry): LedgerEntryEntity {
  const row = new LedgerEntryEntity();
  row.id = entry.id;
  row.walletId = entry.walletId;
  row.transactionId = entry.transactionId;
  row.direction = entry.direction;
  row.amount = entry.money.toJSON().amount;
  row.currency = entry.money.currency;
  row.balanceBefore = entry.balanceBefore.toJSON().amount;
  row.balanceAfter = entry.balanceAfter.toJSON().amount;
  row.createdAt = entry.createdAt;
  return row;
}

export function outboxRow<T>(event: IntegrationEvent<T>): OutboxMessageEntity {
  const message = OutboxMessage.enqueue(event);
  const row = new OutboxMessageEntity();
  row.id = message.id;
  row.aggregateId = message.aggregateId;
  row.eventType = message.eventType;
  row.payload = message.payload as Record<string, unknown>;
  row.occurredAt = message.occurredAt;
  row.attempts = message.attempts;
  row.nextAttemptAt = null;
  row.publishedAt = null;
  return row;
}

export function storedMoney(amount: string, currency: string): Money {
  return Money.from({ amount: decimalString(amount), currency });
}

function decimalString(raw: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) {
    throw new Error(`unexpected numeric value ${raw}`);
  }
  const sign = match[1] ?? '';
  const whole = (match[2] ?? '0').replace(/^0+(?=\d)/, '');
  const fraction = match[3] ?? '';
  if ([...fraction.slice(2)].some((digit) => digit !== '0')) {
    throw new Error(`unexpected numeric scale ${raw}`);
  }
  return `${sign}${whole}.${(fraction + '00').slice(0, 2)}`;
}

export function applyDirection(balance: Money, direction: string, amount: Money): Money {
  if (direction === LedgerDirection.Credit) return balance.add(amount);
  if (direction === LedgerDirection.Debit) return balance.subtract(amount);
  throw new Error(`unexpected ledger direction ${direction}`);
}
