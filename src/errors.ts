export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message = 'invalid money') {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor() {
    super('currency mismatch');
  }
}

export class InsufficientFundsError extends DomainError {
  constructor() {
    super('insufficient funds');
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor() {
    super('transaction is terminal');
  }
}

export class InvalidOperationError extends DomainError {}

export class UnbalancedLedgerError extends DomainError {
  constructor(message = 'ledger entry is not balanced') {
    super(message);
  }
}
