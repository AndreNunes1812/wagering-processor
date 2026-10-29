import { CurrencyMismatchError, InvalidMoneyError } from '../errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT = /^(0|[1-9]\d*)\.\d{2}$/;

export class Money {
  private constructor(
    private readonly cents: bigint,
    readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const cents = parseCents(props.amount);
    if (cents < 0n) {
      throw new InvalidMoneyError('amount must not be negative');
    }
    return new Money(cents, normalizeCurrency(props.currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, normalizeCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return { amount: this.format(), currency: this.currency };
  }

  toString(): string {
    return `${this.format()} ${this.currency}`;
  }

  private format(): string {
    const negative = this.cents < 0n;
    const absolute = negative ? -this.cents : this.cents;
    const whole = absolute / 100n;
    const fraction = (absolute % 100n).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError();
    }
  }
}

function parseCents(amount: string): bigint {
  if (typeof amount !== 'string' || !AMOUNT.test(amount)) {
    throw new InvalidMoneyError('amount must be a decimal string with 2 places');
  }
  const [whole, fraction] = amount.split('.');
  return BigInt(whole ?? '0') * 100n + BigInt(fraction ?? '0');
}

function normalizeCurrency(currency: string): string {
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) {
    throw new InvalidMoneyError('currency must be an ISO-4217 code');
  }
  return currency.toUpperCase();
}
