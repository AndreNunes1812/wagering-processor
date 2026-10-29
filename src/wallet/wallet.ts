import { CurrencyMismatchError, InsufficientFundsError, InvalidMoneyError } from '../errors';
import { Money } from '../money/money';

export type WalletState = {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; at: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError('initial balance cannot be negative');
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(amount: Money, at: Date): { balanceBefore: Money; balanceAfter: Money } {
    this.assertSameCurrency(amount);
    if (!amount.isPositive()) {
      throw new InvalidMoneyError('amount must be positive');
    }
    if (this._balance.isLessThan(amount)) {
      throw new InsufficientFundsError();
    }
    return this.apply(this._balance.subtract(amount), at);
  }

  credit(amount: Money, at: Date): { balanceBefore: Money; balanceAfter: Money } {
    this.assertSameCurrency(amount);
    if (!amount.isPositive()) {
      throw new InvalidMoneyError('amount must be positive');
    }
    return this.apply(this._balance.add(amount), at);
  }

  private apply(next: Money, at: Date): { balanceBefore: Money; balanceAfter: Money } {
    const balanceBefore = this._balance;
    this._balance = next;
    this._version += 1;
    this._updatedAt = at;
    return { balanceBefore, balanceAfter: next };
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError();
    }
  }
}
