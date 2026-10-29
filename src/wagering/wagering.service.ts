import { DeadlockException, EntityManager, LockMode } from '@mikro-orm/core';
import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ApiResult } from '../api-result';
import { constraintOf } from '../database/constraint';
import {
  copyTransaction,
  copyWallet,
  ledgerRow,
  outboxRow,
  storedMoney,
  transactionRow,
  walletFromRow,
} from '../database/records';
import { InsufficientFundsError } from '../errors';
import { newId } from '../ids';
import { LedgerDirection, WalletLedgerEntry } from '../ledger/ledger-entry';
import { logInfo } from '../log';
import {
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  type EventContext,
} from '../messaging/events';
import { Metrics } from '../metrics';
import { retryDelaySeconds } from '../messaging/retry-delay';
import { Money } from '../money/money';
import { traced } from '../trace';
import { asRecord, fail, readMoney, readUuid } from '../wallet/wallet.service';
import { WalletEntity } from '../wallet/wallet.entity';
import { FailureCode } from './failure-code';
import { payloadHash } from './payload-hash';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';
import { WagerTransactionEntity } from './wager-transaction.entity';

const REFERENCE_ATTEMPTS = 10;
const REFERENCE_TTL_MS = 15 * 60 * 1000;

type Inspection =
  | undefined
  | { action: 'park' }
  | { action: 'reject'; code: FailureCode }
  | { action: 'apply'; referenceId: string; direction: LedgerDirection };

type SubmitInput = {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  money: Money;
  referenceExternalTransactionId?: string;
  idempotencyKey: string;
  payloadHash: string;
};

@Injectable()
export class WageringService {
  constructor(
    private readonly em: EntityManager,
    @Optional() private readonly metrics?: Metrics,
  ) {}

  async submit(idempotencyKey: string | undefined, body: unknown, correlationId?: string): Promise<ApiResult> {
    const input = parseSubmit(body, idempotencyKey);
    return traced('wager.submit', { kind: input.kind, walletId: input.walletId }, () =>
      this.finishSubmit(input, correlationId),
    );
  }

  private async finishSubmit(input: SubmitInput, correlationId?: string): Promise<ApiResult> {
    const started = performance.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const outcome = await this.em.transactional((tx) => this.settle(tx, input, correlationId));
        this.metrics?.observe((performance.now() - started) / 1000);
        return outcome;
      } catch (error) {
        if (isIdempotencyConstraint(error)) return this.readReplay(input);
        const retryable =
          error instanceof DeadlockException ||
          constraintOf(error) === 'wager_transactions_one_successful_reversal';
        if (error instanceof DeadlockException) this.metrics?.lockConflict();
        if (retryable && attempt === 0) continue;
        throw error;
      }
    }
    throw new ConflictException('idempotency conflict');
  }

  async getById(transactionId: string): Promise<Record<string, unknown>> {
    const row = await this.em.findOne(WagerTransactionEntity, { id: transactionId });
    if (!row) throw new NotFoundException('transaction not found');
    return transactionBody(row);
  }

  async getByExternal(providerId: string, externalTransactionId: string): Promise<Record<string, unknown>> {
    const row = await this.em.findOne(WagerTransactionEntity, { providerId, externalTransactionId });
    if (!row) throw new NotFoundException('transaction not found');
    return transactionBody(row);
  }

  async applyIn(
    em: EntityManager,
    idempotencyKey: string | undefined,
    body: unknown,
    correlationId?: string,
  ): Promise<ApiResult> {
    return this.settle(em, parseSubmit(body, idempotencyKey), correlationId);
  }

  async reprocessDue(now = new Date(), walletId?: string): Promise<number> {
    let done = 0;
    for (let step = 0; step < 50; step++) {
      const worked = await this.reprocessNext(now, walletId);
      if (!worked) break;
      done += 1;
    }
    return done;
  }

  private async reprocessNext(now: Date, walletId?: string): Promise<boolean> {
    const started = performance.now();
    const worked = await this.em.transactional(async (em) => {
      const candidate = await em.findOne(
        WagerTransactionEntity,
        {
          status: WagerTransactionStatus.PendingReference,
          ...(walletId ? { walletId } : {}),
          $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
        },
        { orderBy: { nextAttemptAt: 'asc', id: 'asc' } },
      );
      if (!candidate) return false;
      const wallet = await em.findOne(WalletEntity, { id: candidate.walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (!wallet) return false;
      const row = await em.findOne(
        WagerTransactionEntity,
        { id: candidate.id },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!row || row.status !== WagerTransactionStatus.PendingReference) return false;
      if (row.nextAttemptAt && row.nextAttemptAt.getTime() > now.getTime()) return false;
      await this.settle(em, inputFrom(row), undefined, row, now);
      return true;
    });
    if (worked) this.metrics?.observe((performance.now() - started) / 1000);
    return worked;
  }

  private async settle(
    em: EntityManager,
    input: SubmitInput,
    correlationId: string | undefined,
    current?: WagerTransactionEntity,
    clock?: Date,
  ): Promise<ApiResult> {
      const at = clock ?? new Date();
      if (!current) {
      const existing = await em.findOne(WagerTransactionEntity, { idempotencyKey: input.idempotencyKey });
      if (existing) return this.noted(replay(existing, input), input.kind);
      }

      const walletRow = await em.findOne(
        WalletEntity,
        { id: input.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!walletRow) throw new NotFoundException('wallet not found');

      if (!current) {
        const raced = await em.findOne(WagerTransactionEntity, { idempotencyKey: input.idempotencyKey });
        if (raced) return this.noted(replay(raced, input), input.kind);
      }

      const transaction = current
        ? referencedTransaction(current)
        : WagerTransaction.create({
            id: newId(at.getTime()),
            providerId: input.providerId,
            externalTransactionId: input.externalTransactionId,
            idempotencyKey: input.idempotencyKey,
            payloadHash: input.payloadHash,
            walletId: input.walletId,
            playerId: input.playerId,
            roundId: input.roundId,
            gameId: input.gameId,
            kind: input.kind,
            money: input.money,
            referenceExternalTransactionId: input.referenceExternalTransactionId,
            createdAt: at,
          });
      const context = eventContext(correlationId, transaction.id, at);
      const wallet = walletFromRow(walletRow);
      const observed = wallet.balance;

      if (wallet.playerId !== input.playerId) {
        return this.reject(em, transaction, observed, FailureCode.PlayerWalletMismatch, context, current);
      }
      if (wallet.currency !== input.money.currency) {
        return this.reject(em, transaction, observed, FailureCode.CurrencyMismatch, context, current);
      }

      const linked = await this.inspectReference(em, input, transaction);
      if (linked?.action === 'reject') {
        return this.reject(em, transaction, observed, linked.code, context, current);
      }
      if (linked?.action === 'park') return this.park(em, transaction, observed, context, current);

      if (input.kind === WagerTransactionKind.Loss) {
        transaction.markProcessed(undefined, at);
        const saved = this.saveTransaction(em, current, transaction, observed);
        saved.nextAttemptAt = null;
        em.persist(outboxRow(WagerTransactionProcessed.from(transaction, observed.toJSON(), context)));
        logOutcome(context.correlationId, transaction, false);
        return this.noted(result(transaction, observed, false), input.kind);
      }

      const direction =
        linked?.action === 'apply'
          ? linked.direction
          : input.kind === WagerTransactionKind.Bet
            ? LedgerDirection.Debit
            : LedgerDirection.Credit;
      const referenceId = linked?.action === 'apply' ? linked.referenceId : undefined;

      try {
        const moved =
          direction === LedgerDirection.Debit
            ? wallet.debit(input.money, at)
            : wallet.credit(input.money, at);
        transaction.markProcessed(referenceId, at);
        copyWallet(walletRow, wallet);
        const entry = WalletLedgerEntry.create({
          id: newId(at.getTime()),
          walletId: wallet.id,
          transactionId: transaction.id,
          direction,
          money: input.money,
          balanceBefore: moved.balanceBefore,
          balanceAfter: moved.balanceAfter,
          createdAt: at,
        });
        const saved = this.saveTransaction(em, current, transaction, moved.balanceAfter);
        saved.nextAttemptAt = null;
        await em.flush();
        em.persist(ledgerRow(entry));
        em.persist(outboxRow(WagerTransactionProcessed.from(transaction, moved.balanceAfter.toJSON(), context)));
        em.persist(
          outboxRow(
            WalletBalanceChanged.from(wallet, entry, { ...context, eventId: newId(at.getTime()) }),
          ),
        );
        logOutcome(context.correlationId, transaction, false);
        return this.noted(result(transaction, moved.balanceAfter, false), input.kind);
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          const code =
            input.kind === WagerTransactionKind.Rollback
              ? FailureCode.ReversalWouldOverdraw
              : FailureCode.InsufficientFunds;
          return this.reject(em, transaction, observed, code, context, current);
        }
        throw error;
      }
  }

  private async inspectReference(
    em: EntityManager,
    input: SubmitInput,
    transaction: WagerTransaction,
  ): Promise<Inspection> {
    const referenced =
      input.kind === WagerTransactionKind.Refund ||
      input.kind === WagerTransactionKind.Rollback ||
      (input.kind === WagerTransactionKind.Win && input.referenceExternalTransactionId != null);
    if (!referenced || !input.referenceExternalTransactionId) return undefined;

    const reference = await em.findOne(
      WagerTransactionEntity,
      {
        providerId: input.providerId,
        externalTransactionId: input.referenceExternalTransactionId,
      },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    if (!reference) return { action: 'park' };
    if (!referenceKindAllowed(input.kind, reference.kind)) {
      return { action: 'reject', code: FailureCode.ReferenceKindNotAllowed };
    }
    if (
      reference.playerId !== transaction.playerId ||
      reference.walletId !== transaction.walletId ||
      reference.roundId !== transaction.roundId ||
      reference.currency !== transaction.money.currency
    ) {
      return { action: 'reject', code: FailureCode.ReferenceScopeMismatch };
    }
    if (
      reference.status === WagerTransactionStatus.Rejected ||
      reference.status === WagerTransactionStatus.Failed
    ) {
      return { action: 'reject', code: FailureCode.ReferenceKindNotAllowed };
    }
    if (reference.status !== WagerTransactionStatus.Processed) return { action: 'park' };
    if (input.kind === WagerTransactionKind.Refund || input.kind === WagerTransactionKind.Rollback) {
      const referenceMoney = storedMoney(reference.amount, reference.currency);
      if (!referenceMoney.equals(input.money)) return { action: 'reject', code: FailureCode.AmountMismatch };
      const prior = await em.findOne(WagerTransactionEntity, {
        providerId: input.providerId,
        referenceExternalTransactionId: input.referenceExternalTransactionId,
        kind: input.kind,
        status: WagerTransactionStatus.Processed,
      });
      if (prior && prior.id !== transaction.id) return { action: 'reject', code: FailureCode.AlreadyReversed };
    }

    const direction =
      input.kind === WagerTransactionKind.Rollback
        ? transaction.ledgerDirectionFor(referencedTransaction(reference))
        : LedgerDirection.Credit;
    return { action: 'apply', referenceId: reference.id, direction };
  }

  private reject(
    em: EntityManager,
    transaction: WagerTransaction,
    balance: Money,
    code: FailureCode,
    context: EventContext,
    current?: WagerTransactionEntity,
  ): ApiResult {
    transaction.reject(code, context.occurredAt);
    const row = this.saveTransaction(em, current, transaction, balance);
    row.nextAttemptAt = null;
    em.persist(outboxRow(WagerTransactionRejected.from(transaction, balance.toJSON(), context)));
    logOutcome(context.correlationId, transaction, false);
    return this.noted(result(transaction, balance, false), transaction.kind);
  }

  private park(
    em: EntityManager,
    transaction: WagerTransaction,
    balance: Money,
    context: EventContext,
    current?: WagerTransactionEntity,
  ): ApiResult {
    if (current && referenceExhausted(current, context.occurredAt)) {
      return this.reject(em, transaction, balance, FailureCode.ReferenceNotFound, context, current);
    }
    transaction.markPendingReference();
    const row = this.saveTransaction(em, current, transaction, balance);
    if (!current) {
      row.attemptCount = 0;
      row.nextAttemptAt = context.occurredAt;
      em.persist(outboxRow(WagerTransactionPendingReference.from(transaction, context)));
    } else {
      const attempt = current.attemptCount + 1;
      row.attemptCount = attempt;
      row.nextAttemptAt = new Date(context.occurredAt.getTime() + retryDelaySeconds(attempt) * 1000);
      this.metrics?.retry('reference');
    }
    logOutcome(context.correlationId, transaction, false);
    return this.noted(result(transaction, balance, false), transaction.kind);
  }

  private saveTransaction(
    em: EntityManager,
    current: WagerTransactionEntity | undefined,
    transaction: WagerTransaction,
    balance: Money,
  ): WagerTransactionEntity {
    if (!current) {
      const row = transactionRow(transaction, balance);
      em.persist(row);
      return row;
    }
    copyTransaction(current, transaction, balance);
    return current;
  }

  private noted(outcome: ApiResult, kind: string): ApiResult {
    this.metrics?.transactions(String(outcome.body.status ?? ''), kind);
    if (outcome.body.idempotentReplay === true) this.metrics?.duplicates();
    return outcome;
  }

  private async readReplay(input: SubmitInput): Promise<ApiResult> {
    const row =
      (await this.em.findOne(WagerTransactionEntity, { idempotencyKey: input.idempotencyKey })) ??
      (await this.em.findOne(WagerTransactionEntity, {
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
      }));
    if (!row) throw new ConflictException('idempotency conflict');
    return this.noted(replay(row, input), input.kind);
  }
}

function referenceExhausted(row: WagerTransactionEntity, now: Date): boolean {
  const agedOut = now.getTime() - row.createdAt.getTime() >= REFERENCE_TTL_MS;
  return agedOut || row.attemptCount + 1 >= REFERENCE_ATTEMPTS;
}

function inputFrom(row: WagerTransactionEntity): SubmitInput {
  return {
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    playerId: row.playerId,
    walletId: row.walletId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind as SubmitInput['kind'],
    money: storedMoney(row.amount, row.currency),
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
  };
}

function replay(row: WagerTransactionEntity, input: SubmitInput): ApiResult {
  if (row.idempotencyKey !== input.idempotencyKey) {
    throw new ConflictException('provider transaction already exists');
  }
  if (row.payloadHash !== input.payloadHash) {
    throw new ConflictException('idempotency key was already used with a different payload');
  }
  const balance = row.resultBalanceAmount
    ? storedMoney(row.resultBalanceAmount, row.resultBalanceCurrency ?? row.currency)
    : null;
  return resultFrom(row, balance, true);
}

function isIdempotencyConstraint(error: unknown): boolean {
  const constraint = constraintOf(error);
  return (
    constraint === 'wager_transactions_idempotency' || constraint === 'wager_transactions_provider_external'
  );
}

function result(transaction: WagerTransaction, balance: Money, replayed: boolean): ApiResult {
  return new ApiResult(statusCode(transaction.status), {
    transactionId: transaction.id,
    status: transaction.status,
    balance: balance.toJSON(),
    idempotentReplay: replayed,
    ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
  });
}

function resultFrom(row: WagerTransactionEntity, balance: Money | null, replayed: boolean): ApiResult {
  return new ApiResult(statusCode(row.status), {
    transactionId: row.id,
    status: row.status,
    balance: balance ? balance.toJSON() : null,
    idempotentReplay: replayed,
    ...(row.failureCode ? { failureCode: row.failureCode } : {}),
  });
}

function transactionBody(row: WagerTransactionEntity): Record<string, unknown> {
  const balance = row.resultBalanceAmount
    ? storedMoney(row.resultBalanceAmount, row.resultBalanceCurrency ?? row.currency).toJSON()
    : null;
  return {
    transactionId: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind,
    status: row.status,
    money: storedMoney(row.amount, row.currency).toJSON(),
    balance,
    ...(row.failureCode ? { failureCode: row.failureCode } : {}),
    ...(row.referenceExternalTransactionId
      ? { referenceExternalTransactionId: row.referenceExternalTransactionId }
      : {}),
  };
}

function statusCode(status: string): number {
  if (status === WagerTransactionStatus.Processed) return 200;
  if (status === WagerTransactionStatus.Rejected) return 422;
  return 202;
}

function eventContext(correlationId: string | undefined, causationId: string, at: Date): EventContext {
  return {
    eventId: newId(at.getTime()),
    correlationId: correlationId?.trim() || newId(at.getTime()),
    causationId,
    occurredAt: at,
  };
}

function logOutcome(correlationId: string, transaction: WagerTransaction, idempotentReplay: boolean): void {
  logInfo('wager.submitted', {
    correlationId,
    transactionId: transaction.id,
    walletId: transaction.walletId,
    providerId: transaction.providerId,
    status: transaction.status,
    failureCode: transaction.failureCode,
    idempotentReplay,
  });
}

function parseSubmit(body: unknown, idempotencyKey: string | undefined): SubmitInput {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    fail('Idempotency-Key header is required');
  }
  const record = asRecord(body);
  const kind = readKind(record.kind);
  const money = readMoney(record.money, 'money');
  const reference = readOptional(record.referenceExternalTransactionId, 'referenceExternalTransactionId');
  if ((kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) && !reference) {
    fail('referenceExternalTransactionId is required');
  }
  const input = {
    providerId: readText(record.providerId, 'providerId'),
    externalTransactionId: readText(record.externalTransactionId, 'externalTransactionId'),
    playerId: readUuid(record.playerId, 'playerId'),
    walletId: readUuid(record.walletId, 'walletId'),
    roundId: readText(record.roundId, 'roundId'),
    gameId: readText(record.gameId, 'gameId'),
    kind,
    money,
    referenceExternalTransactionId: reference,
    idempotencyKey: idempotencyKey.trim(),
    payloadHash: '',
  };
  input.payloadHash = payloadHash({
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: input.money.toJSON(),
    referenceExternalTransactionId: input.referenceExternalTransactionId,
  });
  return input;
}

function readKind(value: unknown): SubmitInput['kind'] {
  if (
    value === WagerTransactionKind.Bet ||
    value === WagerTransactionKind.Win ||
    value === WagerTransactionKind.Loss ||
    value === WagerTransactionKind.Refund ||
    value === WagerTransactionKind.Rollback
  ) {
    return value;
  }
  fail('kind must be BET, WIN, LOSS, REFUND or ROLLBACK');
}

function referenceKindAllowed(kind: SubmitInput['kind'], referenceKind: string): boolean {
  if (kind === WagerTransactionKind.Win || kind === WagerTransactionKind.Refund) {
    return referenceKind === WagerTransactionKind.Bet;
  }
  if (kind === WagerTransactionKind.Rollback) {
    return (
      referenceKind === WagerTransactionKind.Bet ||
      referenceKind === WagerTransactionKind.Win ||
      referenceKind === WagerTransactionKind.Refund
    );
  }
  return false;
}

function referencedTransaction(row: WagerTransactionEntity): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind as WagerTransactionKind,
    money: storedMoney(row.amount, row.currency),
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
    createdAt: row.createdAt,
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode: (row.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: row.processedAt ?? undefined,
  });
}

function readText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${field} is required`);
  return value.trim();
}

function readOptional(value: unknown, field: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') fail(`${field} must be a string`);
  return value.trim();
}
