import { EntityManager } from '@mikro-orm/core';
import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ApiResult } from '../api-result';
import { constraintOf } from '../database/constraint';
import {
  applyDirection,
  ledgerRow,
  outboxRow,
  storedMoney,
  transactionRow,
  walletFromRow,
  walletRow,
} from '../database/records';
import { InvalidMoneyError } from '../errors';
import { newId } from '../ids';
import { LedgerEntryEntity } from '../ledger/ledger-entry.entity';
import { LedgerDirection, WalletLedgerEntry } from '../ledger/ledger-entry';
import { logWarn } from '../log';
import { Metrics } from '../metrics';
import { WalletBalanceChanged, WagerTransactionProcessed, type EventContext } from '../messaging/events';
import { Money } from '../money/money';
import { payloadHash } from '../wagering/payload-hash';
import { WagerTransaction } from '../wagering/wager-transaction';
import { Wallet } from './wallet';
import { WalletEntity } from './wallet.entity';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class WalletService {
  constructor(
    private readonly em: EntityManager,
    @Optional() private readonly metrics?: Metrics,
  ) {}

  async open(body: unknown, correlationId?: string): Promise<ApiResult> {
    const input = parseOpenWallet(body);
    const at = new Date();
    const wallet = Wallet.open({
      id: newId(at.getTime()),
      playerId: input.playerId,
      initialBalance: input.initialBalance,
      at,
    });
    const context = eventContext(correlationId, at);

    try {
      await this.em.transactional(async (em) => {
        em.persist(walletRow(wallet));
        await em.flush();
        if (!wallet.balance.isPositive()) return;

        const transaction = WagerTransaction.opening({
          id: newId(at.getTime()),
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: wallet.balance,
          payloadHash: payloadHash({
            walletId: wallet.id,
            playerId: wallet.playerId,
            kind: 'OPENING',
            money: wallet.balance.toJSON(),
          }),
          createdAt: at,
        });
        transaction.markProcessed(undefined, at);
        const entry = WalletLedgerEntry.create({
          id: newId(at.getTime()),
          walletId: wallet.id,
          transactionId: transaction.id,
          direction: LedgerDirection.Credit,
          money: wallet.balance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: wallet.balance,
          createdAt: at,
        });
        em.persist(transactionRow(transaction, wallet.balance));
        await em.flush();
        em.persist(ledgerRow(entry));
        em.persist(outboxRow(WagerTransactionProcessed.from(transaction, wallet.balance.toJSON(), context)));
        em.persist(
          outboxRow(
            WalletBalanceChanged.from(wallet, entry, { ...context, eventId: newId(at.getTime()) }),
          ),
        );
      });
    } catch (error) {
      if (constraintOf(error) === 'wallets_player_currency') {
        throw new ConflictException('wallet already exists for this player and currency');
      }
      throw error;
    }

    return new ApiResult(201, walletBody(wallet));
  }

  async get(walletId: string): Promise<Record<string, unknown>> {
    const row = await this.em.findOne(WalletEntity, { id: walletId });
    if (!row) throw new NotFoundException('wallet not found');
    return walletBody(walletFromRow(row));
  }

  async ledger(walletId: string, cursor?: string, limit?: string): Promise<Record<string, unknown>> {
    const row = await this.em.findOne(WalletEntity, { id: walletId });
    if (!row) throw new NotFoundException('wallet not found');
    const pageSize = parseLimit(limit);
    const position = cursor ? decodeCursor(cursor) : undefined;
    const rows = await this.em.find(
      LedgerEntryEntity,
      position
        ? {
            walletId,
            $or: [
              { createdAt: { $gt: position.createdAt } },
              { createdAt: position.createdAt, id: { $gt: position.id } },
            ],
          }
        : { walletId },
      { orderBy: { createdAt: 'asc', id: 'asc' }, limit: pageSize + 1 },
    );
    const page = rows.slice(0, pageSize);
    const last = page.at(-1);
    return {
      items: page.map(ledgerBody),
      nextCursor: rows.length > pageSize && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async reconcile(walletId: string, correlationId?: string): Promise<Record<string, unknown>> {
    return this.em.transactional(async (em) => {
      const row = await em.findOne(WalletEntity, { id: walletId });
      if (!row) throw new NotFoundException('wallet not found');
      const entries = await em.find(LedgerEntryEntity, { walletId }, { orderBy: { createdAt: 'asc', id: 'asc' } });
      let calculated = Money.zero(row.currency);
      for (const entry of entries) {
        calculated = applyDirection(calculated, entry.direction, storedMoney(entry.amount, entry.currency));
      }
      const stored = storedMoney(row.balanceAmount, row.currency);
      const difference = stored.subtract(calculated);
      const consistent = stored.equals(calculated);
      if (!consistent) {
        logWarn('wallet.diverged', {
          correlationId,
          walletId,
          storedBalance: stored.toJSON().amount,
          calculatedBalance: calculated.toJSON().amount,
          difference: difference.toJSON().amount,
          currency: row.currency,
          checkedEntries: entries.length,
        });
        this.metrics?.divergence();
      }
      return {
        walletId,
        storedBalance: stored.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: entries.length,
      };
    });
  }
}

function walletBody(wallet: Wallet): Record<string, unknown> {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

function ledgerBody(row: LedgerEntryEntity): Record<string, unknown> {
  return {
    id: row.id,
    transactionId: row.transactionId,
    direction: row.direction,
    money: storedMoney(row.amount, row.currency).toJSON(),
    balanceBefore: storedMoney(row.balanceBefore, row.currency).toJSON(),
    balanceAfter: storedMoney(row.balanceAfter, row.currency).toJSON(),
    createdAt: row.createdAt.toISOString(),
  };
}

function eventContext(correlationId: string | undefined, at: Date): EventContext {
  return {
    eventId: newId(at.getTime()),
    correlationId: correlationId?.trim() || newId(at.getTime()),
    occurredAt: at,
  };
}

function parseOpenWallet(body: unknown): { playerId: string; initialBalance: Money } {
  const record = asRecord(body);
  const playerId = readUuid(record.playerId, 'playerId');
  return { playerId, initialBalance: readMoney(record.initialBalance, 'initialBalance') };
}

function parseLimit(limit: string | undefined): number {
  if (limit == null || limit === '') return 50;
  if (!/^\d+$/.test(limit)) fail('limit must be an integer from 1 to 50');
  const value = Number(limit);
  if (value < 1 || value > 50) fail('limit must be an integer from 1 to 50');
  return value;
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = raw.lastIndexOf('|');
  const iso = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  const createdAt = new Date(iso);
  if (separator <= 0 || Number.isNaN(createdAt.getTime()) || !UUID.test(id)) fail('invalid cursor');
  return { createdAt, id };
}

export function readMoney(value: unknown, field: string): Money {
  const record = asRecord(value, field);
  if (typeof record.amount !== 'string' || typeof record.currency !== 'string') {
    fail(`${field}.amount and ${field}.currency must be strings`);
  }
  try {
    return Money.from({ amount: record.amount, currency: record.currency });
  } catch (error) {
    if (error instanceof InvalidMoneyError) fail(error.message);
    throw error;
  }
}

export function readUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${field} must be a uuid`);
  return value;
}

export function asRecord(value: unknown, field = 'body'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${field} must be an object`);
  return value as Record<string, unknown>;
}

export function fail(message: string): never {
  throw new BadRequestException(message);
}
