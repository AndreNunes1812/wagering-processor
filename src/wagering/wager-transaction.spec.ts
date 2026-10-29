import { expect, test } from 'bun:test';
import { InvalidOperationError, InvalidTransactionStateError } from '../errors';
import { LedgerDirection } from '../ledger/ledger-entry';
import { Money } from '../money/money';
import { FailureCode } from './failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';

const at = new Date('2026-01-01T00:00:00.000Z');
const money = Money.from({ amount: '25.00', currency: 'BRL' });

function bet(kind: WagerTransactionKind = WagerTransactionKind.Bet, reference?: string): WagerTransaction {
  return WagerTransaction.create({
    id: 't1',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    payloadHash: 'hash',
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money,
    referenceExternalTransactionId: reference,
    createdAt: at,
  });
}

test('começa pendente e recusa outra transição depois de processada', () => {
  const transaction = bet();
  expect(transaction.status).toBe(WagerTransactionStatus.Pending);
  transaction.markProcessed(undefined, at);
  expect(() => transaction.reject(FailureCode.InsufficientFunds, at)).toThrow(InvalidTransactionStateError);
});

test('OPENING só é criada pela fábrica interna', () => {
  const opening = WagerTransaction.opening({
    id: 'opening-1',
    walletId: 'w1',
    playerId: 'p1',
    money,
    payloadHash: 'hash',
    createdAt: at,
  });
  expect(opening.kind).toBe(WagerTransactionKind.Opening);
  expect(opening.status).toBe(WagerTransactionStatus.Pending);
  expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
});

test('rejeita OPENING e um estorno sem referência', () => {
  expect(() => bet(WagerTransactionKind.Opening)).toThrow(InvalidOperationError);
  expect(() => bet(WagerTransactionKind.Refund)).toThrow(InvalidOperationError);
});

test('LOSS não mexe no saldo e um ROLLBACK inverte a aposta', () => {
  const loss = bet(WagerTransactionKind.Loss);
  expect(loss.affectsBalance()).toBe(false);

  const rollback = bet(WagerTransactionKind.Rollback, 'transaction-123');
  const original = bet();
  expect(rollback.ledgerDirectionFor(original)).toBe(LedgerDirection.Credit);
});

test('o mesmo payload de idempotência confere e um hash diferente falha', () => {
  const transaction = bet();
  expect(transaction.matchesPayload('hash')).toBe(true);
  expect(transaction.matchesPayload('other')).toBe(false);
});
