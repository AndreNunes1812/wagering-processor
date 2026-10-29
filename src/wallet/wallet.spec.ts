import { expect, test } from 'bun:test';
import { InsufficientFundsError } from '../errors';
import { Money } from '../money/money';
import { Wallet } from './wallet';

const at = new Date('2026-01-01T00:00:00.000Z');

test('abre na versão 1 com o saldo inicial já aplicado', () => {
  const wallet = Wallet.open({
    id: 'w1',
    playerId: 'p1',
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    at,
  });

  expect(wallet.version).toBe(1);
  expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
});

test('rejeita um débito que o saldo não cobre e mantém o estado anterior', () => {
  const wallet = Wallet.open({
    id: 'w1',
    playerId: 'p1',
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    at,
  });

  wallet.debit(Money.from({ amount: '80.00', currency: 'BRL' }), at);

  expect(() => wallet.debit(Money.from({ amount: '80.00', currency: 'BRL' }), at)).toThrow(
    InsufficientFundsError,
  );
  expect(wallet.balance.toJSON().amount).toBe('20.00');
  expect(wallet.version).toBe(2);
});
