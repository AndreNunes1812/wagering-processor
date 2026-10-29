import { expect, test } from 'bun:test';
import { UnbalancedLedgerError } from '../errors';
import { Money } from '../money/money';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';

const at = new Date('2026-01-01T00:00:00.000Z');

test('aceita um débito em que os saldos fecham', () => {
  const entry = WalletLedgerEntry.create({
    id: 'l1',
    walletId: 'w1',
    transactionId: 't1',
    direction: LedgerDirection.Debit,
    money: Money.from({ amount: '80.00', currency: 'BRL' }),
    balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
    balanceAfter: Money.from({ amount: '20.00', currency: 'BRL' }),
    createdAt: at,
  });

  expect(entry.isBalanced()).toBe(true);
});

test('rejeita um crédito que não fecha no saldo posterior', () => {
  expect(() =>
    WalletLedgerEntry.create({
      id: 'l1',
      walletId: 'w1',
      transactionId: 't1',
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '10.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '10.00', currency: 'BRL' }),
      createdAt: at,
    }),
  ).toThrow(UnbalancedLedgerError);
});
