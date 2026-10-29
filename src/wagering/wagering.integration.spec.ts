import 'reflect-metadata';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/core';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ApiResult } from '../api-result';
import config from '../database/mikro-orm.config';
import { newId } from '../ids';
import { WalletService } from '../wallet/wallet.service';
import { WageringService } from './wagering.service';

let orm: MikroORM;
let wallets: WalletService;
let wagering: WageringService;

beforeAll(async () => {
  orm = await MikroORM.init({ ...config, allowGlobalContext: true });
  await orm.connect();
  wallets = new WalletService(orm.em);
  wagering = new WageringService(orm.em);
});

afterAll(async () => {
  await orm.close();
});

test('abrir carteira com saldo grava um crédito e a versão 1', async () => {
  const opened = await open('100.00');
  expect(opened.version).toBe(1);
  expect(opened.balance).toEqual({ amount: '100.00', currency: 'BRL' });

  const ledger = await wallets.ledger(opened.id);
  const items = ledger.items as Array<{ direction: string }>;
  expect(items).toHaveLength(1);
  expect(items[0]?.direction).toBe('CREDIT');
  await expectConsistent(opened.id);
});

test('segunda carteira do mesmo jogador e da mesma moeda conflita', async () => {
  const playerId = newId();
  await wallets.open({ playerId, initialBalance: { amount: '10.00', currency: 'BRL' } });
  await expect(
    wallets.open({ playerId, initialBalance: { amount: '10.00', currency: 'BRL' } }),
  ).rejects.toBeInstanceOf(ConflictException);
});

test('saldo zero não cria lançamento no ledger', async () => {
  const opened = await open('0.00');
  const ledger = await wallets.ledger(opened.id);
  expect(ledger.items).toEqual([]);
  expect(opened.version).toBe(1);
  await expectConsistent(opened.id);
});

test('o replay devolve o saldo observado na primeira aposta', async () => {
  const opened = await open('100.00');
  const first = await bet(opened.id, '30.00', 'bet-1');
  await bet(opened.id, '20.00', 'bet-2');
  const replay = await bet(opened.id, '30.00', 'bet-1');

  expect(first.body.balance).toEqual({ amount: '70.00', currency: 'BRL' });
  expect(first.body.idempotentReplay).toBe(false);
  expect(replay.statusCode).toBe(200);
  expect(replay.body.idempotentReplay).toBe(true);
  expect(replay.body.transactionId).toBe(first.body.transactionId);
  expect(replay.body.balance).toEqual({ amount: '70.00', currency: 'BRL' });
  await expectConsistent(opened.id);
});

test('a mesma chave com outro valor conflita e não debita de novo', async () => {
  const opened = await open('100.00');
  await bet(opened.id, '10.00', 'bet-1');
  await expect(bet(opened.id, '15.00', 'bet-1')).rejects.toBeInstanceOf(ConflictException);
  const current = await wallets.get(opened.id);
  expect(current.balance).toEqual({ amount: '90.00', currency: 'BRL' });
});

test('moeda diferente é rejeitada sem mover o saldo', async () => {
  const opened = await open('40.00');
  const current = await wallets.get(opened.id);
  const result = await wagering.submit(`provider-a:usd:${opened.id}`, {
    ...body(opened.id, '10.00', `usd-${opened.id}`),
    playerId: current.playerId,
    money: { amount: '10.00', currency: 'USD' },
  });
  expect(result.statusCode).toBe(422);
  expect(result.body.failureCode).toBe('CURRENCY_MISMATCH');
  const after = await wallets.get(opened.id);
  expect(after.balance).toEqual({ amount: '40.00', currency: 'BRL' });
  expect(after.version).toBe(1);
});

test('LOSS registra a rodada e deixa o saldo no lugar', async () => {
  const opened = await open('40.00');
  const result = await bet(opened.id, '40.00', 'loss-1', 'LOSS');
  expect(result.statusCode).toBe(200);
  expect(result.body.status).toBe('PROCESSED');
  const current = await wallets.get(opened.id);
  expect(current.balance).toEqual({ amount: '40.00', currency: 'BRL' });
  expect(current.version).toBe(1);
});

test('WIN credita a carteira', async () => {
  const opened = await open('40.00');
  const result = await bet(opened.id, '15.00', 'win-1', 'WIN');
  expect(result.body.balance).toEqual({ amount: '55.00', currency: 'BRL' });
  const current = await wallets.get(opened.id);
  expect(current.version).toBe(2);
  await expectConsistent(opened.id);
});

test('WIN que aponta para uma aposta ausente fica pendente e não move o saldo', async () => {
  const opened = await open('40.00');
  const current = await wallets.get(opened.id);
  const external = `win-missing-${opened.id}`;
  const result = await wagering.submit(`provider-a:${external}`, {
    ...body(opened.id, '10.00', external),
    playerId: current.playerId,
    kind: 'WIN',
    referenceExternalTransactionId: `missing-${opened.id}`,
  });
  expect(result.statusCode).toBe(202);
  expect(result.body.status).toBe('PENDING_REFERENCE');
  const after = await wallets.get(opened.id);
  expect(after.balance).toEqual({ amount: '40.00', currency: 'BRL' });
  expect(after.version).toBe(1);
});

test('WIN que aponta para uma aposta processada credita a carteira', async () => {
  const opened = await open('40.00');
  await bet(opened.id, '10.00', 'ref-bet');
  const current = await wallets.get(opened.id);
  const external = `win-linked-${opened.id}`;
  const result = await wagering.submit(`provider-a:${external}`, {
    ...body(opened.id, '25.00', external),
    playerId: current.playerId,
    kind: 'WIN',
    referenceExternalTransactionId: `ref-bet-${opened.id}`,
  });
  expect(result.statusCode).toBe(200);
  expect(result.body.balance).toEqual({ amount: '55.00', currency: 'BRL' });
  await expectConsistent(opened.id);
});

test('duas apostas disputando o mesmo saldo geram um débito', async () => {
  const opened = await open('100.00');
  const results = await Promise.all([
    bet(opened.id, '80.00', 'race-1'),
    bet(opened.id, '80.00', 'race-2'),
  ]);
  const processed = results.filter((item) => item.body.status === 'PROCESSED');
  const rejected = results.filter((item) => item.body.failureCode === 'INSUFFICIENT_FUNDS');
  expect(processed).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(processed[0]?.body.balance).toEqual({ amount: '20.00', currency: 'BRL' });

  const current = await wallets.get(opened.id);
  expect(current.balance).toEqual({ amount: '20.00', currency: 'BRL' });
  const ledger = await wallets.ledger(opened.id);
  const debits = (ledger.items as Array<{ direction: string }>).filter((item) => item.direction === 'DEBIT');
  expect(debits).toHaveLength(1);
  await expectConsistent(opened.id);
}, { timeout: 20_000 });

test('cinquenta cópias paralelas da mesma aposta debitam uma vez', async () => {
  const opened = await open('100.00');
  const results = await Promise.all(
    Array.from({ length: 50 }, () => bet(opened.id, '25.00', 'same-bet')),
  );
  const writes = results.filter((item) => item.body.idempotentReplay === false);
  expect(writes).toHaveLength(1);
  expect(new Set(results.map((item) => item.body.transactionId)).size).toBe(1);
  const current = await wallets.get(opened.id);
  expect(current.balance).toEqual({ amount: '75.00', currency: 'BRL' });
  const ledger = await wallets.ledger(opened.id);
  const debits = (ledger.items as Array<{ direction: string }>).filter((item) => item.direction === 'DEBIT');
  expect(debits).toHaveLength(1);
  await expectConsistent(opened.id);
}, { timeout: 30_000 });

test('REFUND de uma aposta processada devolve o valor', async () => {
  const opened = await open('100.00');
  await move(opened.id, '40.00', 'bet-refund');
  const result = await move(opened.id, '40.00', 'refund-1', 'REFUND', 'bet-refund');
  expect(result.statusCode).toBe(200);
  expect(result.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  const replay = await move(opened.id, '40.00', 'refund-1', 'REFUND', 'bet-refund');
  expect(replay.body.idempotentReplay).toBe(true);
  expect(replay.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  expect(replay.body.transactionId).toBe(result.body.transactionId);
  const current = await wallets.get(opened.id);
  expect(current.version).toBe(3);
  const ledger = await wallets.ledger(opened.id);
  const credits = (ledger.items as Array<{ direction: string }>).filter((item) => item.direction === 'CREDIT');
  expect(credits).toHaveLength(2);
  await expectConsistent(opened.id);
});

test('o segundo REFUND da mesma aposta é rejeitado', async () => {
  const opened = await open('100.00');
  await move(opened.id, '40.00', 'bet-twice');
  await move(opened.id, '40.00', 'refund-a', 'REFUND', 'bet-twice');
  const again = await move(opened.id, '40.00', 'refund-b', 'REFUND', 'bet-twice');
  expect(again.statusCode).toBe(422);
  expect(again.body.failureCode).toBe('ALREADY_REVERSED');
  const current = await wallets.get(opened.id);
  expect(current.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  await expectConsistent(opened.id);
});

test('REFUND com valor diferente é rejeitado', async () => {
  const opened = await open('100.00');
  await move(opened.id, '40.00', 'bet-amount');
  const result = await move(opened.id, '10.00', 'refund-amount', 'REFUND', 'bet-amount');
  expect(result.statusCode).toBe(422);
  expect(result.body.failureCode).toBe('AMOUNT_MISMATCH');
  const current = await wallets.get(opened.id);
  expect(current.balance).toEqual({ amount: '60.00', currency: 'BRL' });
});

test('REFUND de um WIN é rejeitado', async () => {
  const opened = await open('40.00');
  await move(opened.id, '10.00', 'win-kind', 'WIN');
  const result = await move(opened.id, '10.00', 'refund-win', 'REFUND', 'win-kind');
  expect(result.statusCode).toBe(422);
  expect(result.body.failureCode).toBe('REFERENCE_KIND_NOT_ALLOWED');
  const current = await wallets.get(opened.id);
  expect(current.balance).toEqual({ amount: '50.00', currency: 'BRL' });
});

test('REFUND de outra rodada é rejeitado', async () => {
  const opened = await open('100.00');
  await move(opened.id, '40.00', 'bet-scope');
  const current = await wallets.get(opened.id);
  const external = `refund-scope-${opened.id}`;
  const result = await wagering.submit(`provider-a:${external}`, {
    ...body(opened.id, '40.00', external),
    playerId: current.playerId,
    kind: 'REFUND',
    roundId: 'outra-rodada',
    referenceExternalTransactionId: `bet-scope-${opened.id}`,
  });
  expect(result.statusCode).toBe(422);
  expect(result.body.failureCode).toBe('REFERENCE_SCOPE_MISMATCH');
});

test('REFUND sem a aposta fica pendente', async () => {
  const opened = await open('40.00');
  const result = await move(opened.id, '10.00', 'refund-missing', 'REFUND', 'aposta-ausente');
  expect(result.statusCode).toBe(202);
  expect(result.body.status).toBe('PENDING_REFERENCE');
  const current = await wallets.get(opened.id);
  expect(current.balance).toEqual({ amount: '40.00', currency: 'BRL' });
  expect(current.version).toBe(1);
});

test('REFUND sem referência é payload inválido', async () => {
  const opened = await open('40.00');
  const current = await wallets.get(opened.id);
  const external = `refund-noref-${opened.id}`;
  await expect(
    wagering.submit(`provider-a:${external}`, {
      ...body(opened.id, '10.00', external),
      playerId: current.playerId,
      kind: 'REFUND',
    }),
  ).rejects.toBeInstanceOf(BadRequestException);
});

test('ROLLBACK de uma aposta credita o valor', async () => {
  const opened = await open('100.00');
  await move(opened.id, '40.00', 'bet-rollback');
  const result = await move(opened.id, '40.00', 'rollback-bet', 'ROLLBACK', 'bet-rollback');
  expect(result.statusCode).toBe(200);
  expect(result.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  await expectConsistent(opened.id);
});

test('ROLLBACK de um WIN debita o valor', async () => {
  const opened = await open('40.00');
  await move(opened.id, '15.00', 'win-rollback', 'WIN');
  const result = await move(opened.id, '15.00', 'rollback-win', 'ROLLBACK', 'win-rollback');
  expect(result.statusCode).toBe(200);
  expect(result.body.balance).toEqual({ amount: '40.00', currency: 'BRL' });
  const current = await wallets.get(opened.id);
  expect(current.version).toBe(3);
  await expectConsistent(opened.id);
});

test('ROLLBACK de um REFUND desfaz o crédito', async () => {
  const opened = await open('100.00');
  await move(opened.id, '30.00', 'bet-chain');
  await move(opened.id, '30.00', 'refund-chain', 'REFUND', 'bet-chain');
  const result = await move(opened.id, '30.00', 'rollback-chain', 'ROLLBACK', 'refund-chain');
  expect(result.statusCode).toBe(200);
  expect(result.body.balance).toEqual({ amount: '70.00', currency: 'BRL' });
  await expectConsistent(opened.id);
});

test('ROLLBACK que deixaria o saldo negativo é rejeitado', async () => {
  const opened = await open('20.00');
  await move(opened.id, '10.00', 'win-over', 'WIN');
  await move(opened.id, '25.00', 'bet-over');
  const result = await move(opened.id, '10.00', 'rollback-over', 'ROLLBACK', 'win-over');
  expect(result.statusCode).toBe(422);
  expect(result.body.failureCode).toBe('REVERSAL_WOULD_OVERDRAW');
  const current = await wallets.get(opened.id);
  expect(current.balance).toEqual({ amount: '5.00', currency: 'BRL' });
  expect(current.version).toBe(3);
  await expectConsistent(opened.id);
});

test('ROLLBACK de um WIN ainda pendente também fica pendente', async () => {
  const opened = await open('40.00');
  await move(opened.id, '10.00', 'win-wait', 'WIN', 'aposta-futura');
  const result = await move(opened.id, '10.00', 'rollback-wait', 'ROLLBACK', 'win-wait');
  expect(result.statusCode).toBe(202);
  expect(result.body.status).toBe('PENDING_REFERENCE');
  const current = await wallets.get(opened.id);
  expect(current.balance).toEqual({ amount: '40.00', currency: 'BRL' });
});

test('dois REFUND paralelos da mesma aposta creditam uma vez', async () => {
  const opened = await open('100.00');
  await move(opened.id, '40.00', 'bet-race');
  const results = await Promise.all([
    move(opened.id, '40.00', 'refund-race-a', 'REFUND', 'bet-race'),
    move(opened.id, '40.00', 'refund-race-b', 'REFUND', 'bet-race'),
  ]);
  const processed = results.filter((item) => item.body.status === 'PROCESSED');
  const rejected = results.filter((item) => item.body.failureCode === 'ALREADY_REVERSED');
  expect(processed).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  const current = await wallets.get(opened.id);
  expect(current.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  await expectConsistent(opened.id);
}, { timeout: 20_000 });

test('REFUND que chega antes da aposta conclui quando o worker roda', async () => {
  const opened = await open('100.00');
  const pending = await move(opened.id, '40.00', 'refund-early', 'REFUND', 'bet-early');
  expect(pending.statusCode).toBe(202);
  await move(opened.id, '40.00', 'bet-early');
  const worked = await wagering.reprocessDue(new Date(), opened.id);
  expect(worked).toBe(1);
  const current = await wallets.get(opened.id);
  expect(current.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  await expectConsistent(opened.id);
});

test('referência pendente expira em quinze minutos', async () => {
  const opened = await open('40.00');
  await move(opened.id, '10.00', 'refund-ttl', 'REFUND', 'aposta-ttl');
  await wagering.reprocessDue(new Date(Date.now() + 16 * 60 * 1000), opened.id);
  const current = await wallets.get(opened.id);
  expect(current.balance).toEqual({ amount: '40.00', currency: 'BRL' });
  const external = `refund-ttl-${opened.id}`;
  const stored = await wagering.getByExternal('provider-a', external);
  expect(stored.status).toBe('REJECTED');
  expect(stored.failureCode).toBe('REFERENCE_NOT_FOUND');
  await expectConsistent(opened.id);
});

test('dez tentativas esgotam a referência pendente', async () => {
  const opened = await open('40.00');
  await move(opened.id, '10.00', 'refund-tries', 'REFUND', 'aposta-tries');
  let clock = new Date(Date.now() + 1000);
  for (let attempt = 0; attempt < 9; attempt++) {
    await wagering.reprocessDue(clock, opened.id);
    clock = new Date(clock.getTime() + 61_000);
  }
  const mid = await wagering.getByExternal('provider-a', `refund-tries-${opened.id}`);
  expect(mid.status).toBe('PENDING_REFERENCE');
  await wagering.reprocessDue(clock, opened.id);
  const stored = await wagering.getByExternal('provider-a', `refund-tries-${opened.id}`);
  expect(stored.status).toBe('REJECTED');
  expect(stored.failureCode).toBe('REFERENCE_NOT_FOUND');
  await expectConsistent(opened.id);
});

test('carteiras distintas seguem em paralelo', async () => {
  const first = await open('50.00');
  const second = await open('80.00');
  await Promise.all([bet(first.id, '20.00', 'paralela-a'), bet(second.id, '30.00', 'paralela-b')]);
  expect((await wallets.get(first.id)).balance).toEqual({ amount: '30.00', currency: 'BRL' });
  expect((await wallets.get(second.id)).balance).toEqual({ amount: '50.00', currency: 'BRL' });
  await expectConsistent(first.id);
  await expectConsistent(second.id);
});

test('três processos na mesma carteira deixam o saldo em vinte', async () => {
  const opened = await open('100.00');
  const current = await wallets.get(opened.id);
  const results = await Promise.all(
    [0, 1, 2].map((index) => submitProcess(opened.id, String(current.playerId), `proc-${index}`, '40.00')),
  );
  const processed = results.filter((item) => item.body.status === 'PROCESSED');
  const rejected = results.filter((item) => item.body.failureCode === 'INSUFFICIENT_FUNDS');
  expect(processed).toHaveLength(2);
  expect(rejected).toHaveLength(1);
  orm.em.clear();
  expect((await wallets.get(opened.id)).balance).toEqual({ amount: '20.00', currency: 'BRL' });
  await expectConsistent(opened.id);
}, { timeout: 30_000 });

test('três processos com a mesma aposta debitam uma vez', async () => {
  const opened = await open('100.00');
  const current = await wallets.get(opened.id);
  const results = await Promise.all(
    [0, 1, 2].map(() => submitProcess(opened.id, String(current.playerId), 'proc-same', '25.00')),
  );
  expect(new Set(results.map((item) => item.body.transactionId)).size).toBe(1);
  orm.em.clear();
  expect((await wallets.get(opened.id)).balance).toEqual({ amount: '75.00', currency: 'BRL' });
  await expectConsistent(opened.id);
}, { timeout: 30_000 });

test('o cursor do ledger percorre os lançamentos sem pular', async () => {
  const opened = await open('30.00');
  await bet(opened.id, '5.00', 'page-1');
  await bet(opened.id, '5.00', 'page-2');
  const first = await wallets.ledger(opened.id, undefined, '1');
  const items = first.items as unknown[];
  expect(items).toHaveLength(1);
  expect(typeof first.nextCursor).toBe('string');
  const rest = await wallets.ledger(opened.id, String(first.nextCursor), '50');
  expect(rest.items as unknown[]).toHaveLength(2);
  expect(rest.nextCursor).toBeNull();
});

async function open(amount: string): Promise<{ id: string; balance: { amount: string; currency: string }; version: number }> {
  const result = await wallets.open({
    playerId: newId(),
    initialBalance: { amount, currency: 'BRL' },
  });
  return result.body as { id: string; balance: { amount: string; currency: string }; version: number };
}

function body(walletId: string, amount: string, externalTransactionId: string) {
  return {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: newId(),
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

async function bet(walletId: string, amount: string, name: string, kind = 'BET'): Promise<ApiResult> {
  return move(walletId, amount, name, kind);
}

async function move(
  walletId: string,
  amount: string,
  name: string,
  kind = 'BET',
  referenceName?: string,
): Promise<ApiResult> {
  const current = await wallets.get(walletId);
  const externalTransactionId = `${name}-${walletId}`;
  return wagering.submit(`provider-a:${externalTransactionId}`, {
    ...body(walletId, amount, externalTransactionId),
    playerId: current.playerId,
    kind,
    ...(referenceName ? { referenceExternalTransactionId: `${referenceName}-${walletId}` } : {}),
  });
}

async function submitProcess(
  walletId: string,
  playerId: string,
  name: string,
  amount: string,
): Promise<{ statusCode: number; body: { status?: string; failureCode?: string; transactionId?: string } }> {
  const directory = mkdtempSync(join(tmpdir(), 'wager-'));
  const output = join(directory, 'result.json');
  const externalTransactionId = `${name}-${walletId}`;
  const payload = {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    body: {
      ...body(walletId, amount, externalTransactionId),
      playerId,
    },
  };
  const proc = Bun.spawn([process.execPath, 'src/wagering/submit-once.ts', JSON.stringify(payload), output], {
    cwd: process.cwd(),
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(stderr);
  return JSON.parse(await Bun.file(output).text()) as {
    statusCode: number;
    body: { status?: string; failureCode?: string; transactionId?: string };
  };
}

async function expectConsistent(walletId: string): Promise<void> {
  const report = await wallets.reconcile(walletId);
  expect(report.consistent).toBe(true);
  expect(report.difference).toEqual({ amount: '0.00', currency: 'BRL' });
}
