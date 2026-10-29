import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../errors';
import { Money } from './money';

describe('dinheiro', () => {
  test('mantém as duas casas decimais exatas', () => {
    const sum = Money.from({ amount: '0.10', currency: 'BRL' }).add(
      Money.from({ amount: '0.20', currency: 'BRL' }),
    );
    expect(sum.toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
  });

  test('rejeita valor que não é uma string com duas casas decimais', () => {
    const rejected = ['', '25', '25.0', '25.000', '1e2', 'NaN', 'Infinity', '-1.00', '10.5', 'abc', '00.10'];
    for (const amount of rejected) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    }
  });

  test('rejeita moeda que não tem três letras', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'BR' })).toThrow(InvalidMoneyError);
  });

  test('recusa conta entre moedas diferentes', () => {
    const brl = Money.from({ amount: '1.00', currency: 'BRL' });
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
  });
});
