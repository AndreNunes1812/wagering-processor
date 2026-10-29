export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletNotFound = 'WALLET_NOT_FOUND',
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  ReferenceRequired = 'REFERENCE_REQUIRED',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceScopeMismatch = 'REFERENCE_SCOPE_MISMATCH',
  AmountMismatch = 'AMOUNT_MISMATCH',
  AlreadyReversed = 'ALREADY_REVERSED',
  InvalidKind = 'INVALID_KIND',
}
