import 'reflect-metadata';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/core';
import { config as appConfig } from '../config';
import config from '../database/mikro-orm.config';
import { newId } from '../ids';
import { Metrics } from '../metrics';
import { WalletService } from '../wallet/wallet.service';
import { WageringService } from '../wagering/wagering.service';
import { InboxMessageEntity } from './inbox.entity';
import { OutboxMessageEntity } from './outbox.entity';
import { OutboxWorker } from './outbox.worker';
import { SqsQueue } from './sqs.client';
import { WageringConsumer, type Delivery } from './wagering.consumer';

let orm: MikroORM;
let wallets: WalletService;
let wagering: WageringService;
let outbox: OutboxWorker;
let consumer: WageringConsumer;
let sqs: SqsQueue;
let metrics: Metrics;

beforeAll(async () => {
  orm = await MikroORM.init({ ...config, allowGlobalContext: true });
  await orm.connect();
  metrics = new Metrics();
  wallets = new WalletService(orm.em);
  wagering = new WageringService(orm.em, metrics);
  sqs = new SqsQueue();
  outbox = new OutboxWorker(orm.em, sqs, metrics);
  consumer = new WageringConsumer(orm.em, wagering, sqs, metrics);
  await sqs.ensureEventsQueue();
  await sqs.purge(appConfig.sqs.wagerQueueUrl);
  await sqs.purge(appConfig.sqs.eventsQueueUrl);
  await sqs.purge(appConfig.sqs.dlqQueueUrl);
});

afterAll(async () => {
  await orm.close().catch(() => undefined);
});

test('o saldo negativo e o ledger imutável ficam no banco', async () => {
  const playerId = newId();
  await expect(
    orm.em.getConnection().execute(
      `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       values (?, ?, 'BRL', -1, 1, now(), now())`,
      [newId(), playerId],
    ),
  ).rejects.toThrow();

  const opened = await wallets.open({
    playerId: newId(),
    initialBalance: { amount: '10.00', currency: 'BRL' },
  });
  const walletId = String((opened.body as { id: string }).id);
  await expect(
    orm.em.getConnection().execute('delete from wallet_ledger_entries where wallet_id = ?', [walletId]),
  ).rejects.toThrow();
});

test('a outbox publicada sobrevive a um processo que morre antes do envio', async () => {
  const opened = await open('30.00');
  await bet(opened.id, opened.playerId, '10.00', 'outbox-bet');
  await postponeOthers(opened.id);
  const pending = await orm.em.find(OutboxMessageEntity, { aggregateId: opened.id, publishedAt: null });
  expect(pending.length).toBeGreaterThan(0);
  await publishAll();
  orm.em.clear();
  const left = await orm.em.find(OutboxMessageEntity, { aggregateId: opened.id, publishedAt: null });
  expect(left).toHaveLength(0);
  const found = await readEvents(pending.map((row) => row.id));
  expect(found.size).toBe(pending.length);
}, { timeout: 20_000 });

test('dois publicadores concluem a mesma outbox', async () => {
  const opened = await open('30.00');
  await bet(opened.id, opened.playerId, '5.00', 'publish-race');
  await postponeOthers(opened.id);
  const ids = (await orm.em.find(OutboxMessageEntity, { aggregateId: opened.id, publishedAt: null })).map((row) => row.id);
  expect(ids.length).toBeGreaterThan(0);
  await Promise.all([publishAll(), publishAll()]);
  orm.em.clear();
  const rows = await orm.em.find(OutboxMessageEntity, { id: { $in: ids } });
  expect(rows.every((row) => row.publishedAt && row.attempts === 0)).toBe(true);
  const found = await readEvents(ids);
  expect(found.size).toBe(ids.length);
}, { timeout: 20_000 });

test('a fila reaproveita o caso de uso e a inbox segura o redelivery', async () => {
  const opened = await open('80.00');
  const external = `queue-bet-${opened.id}`;
  const body = message(opened, external, '25.00');
  await sqs.send(appConfig.sqs.wagerQueueUrl, body, opened.id, external);
  const first = await sqs.receive(appConfig.sqs.wagerQueueUrl, 1, 2, 30);
  expect(first).toHaveLength(1);
  expect(await consumer.settle(first[0]!.body, first[0]!.messageId)).toBe('ack');
  await sqs.changeVisibility(appConfig.sqs.wagerQueueUrl, first[0]!.receiptHandle, 0);
  const second = await sqs.receive(appConfig.sqs.wagerQueueUrl, 1, 2, 30);
  expect(second[0]?.messageId).toBe(first[0]?.messageId);
  expect(await consumer.settle(second[0]!.body, second[0]!.messageId)).toBe('ack');
  await sqs.delete(appConfig.sqs.wagerQueueUrl, second[0]!.receiptHandle);

  const current = await wallets.get(opened.id);
  expect(current.balance).toEqual({ amount: '55.00', currency: 'BRL' });
  const inbox = await orm.em.find(InboxMessageEntity, { messageId: first[0]!.messageId });
  expect(inbox).toHaveLength(1);
  expect(inbox[0]?.processedAt).toBeTruthy();
  const ledger = await wallets.ledger(opened.id);
  const debits = (ledger.items as Array<{ direction: string }>).filter((item) => item.direction === 'DEBIT');
  expect(debits).toHaveLength(1);
  const rows = await orm.em.find(OutboxMessageEntity, { aggregateId: opened.id });
  const processed = rows.filter((row) => {
    const data = eventData(row.payload);
    return row.eventType === 'WagerTransactionProcessed' && data.externalTransactionId === external;
  });
  const changed = rows.filter((row) => {
    const data = eventData(row.payload);
    return row.eventType === 'WalletBalanceChanged' && data.direction === 'DEBIT' && data.money?.amount === '25.00';
  });
  expect(processed).toHaveLength(1);
  expect(changed).toHaveLength(1);
  const report = await wallets.reconcile(opened.id);
  expect(report.consistent).toBe(true);
});

test('rejeição de negócio dá ack e payload inválido vai para a DLQ', async () => {
  const opened = await open('0.00');
  const external = `queue-poor-${opened.id}`;
  const body = message(opened, external, '10.00');
  await sqs.send(appConfig.sqs.wagerQueueUrl, body, opened.id, external);
  await consumer.pollOnce(2);
  const current = await wallets.get(opened.id);
  expect(current.balance).toEqual({ amount: '0.00', currency: 'BRL' });
  const dead = await sqs.receive(appConfig.sqs.dlqQueueUrl, 1, 1, 5);
  expect(dead).toHaveLength(0);

  await sqs.send(appConfig.sqs.wagerQueueUrl, 'isso-nao-e-json', opened.id, `bad-${opened.id}`);
  await consumer.pollOnce(2);
  const poisoned = await sqs.receive(appConfig.sqs.dlqQueueUrl, 1, 2, 5);
  expect(poisoned[0]?.body).toBe('isso-nao-e-json');
});

test('carteira inexistente não grava inbox e pede retry', async () => {
  const walletId = newId();
  const external = `missing-wallet-${walletId}`;
  const body = message({ id: walletId, playerId: newId() }, external, '10.00');
  expect(await consumer.settle(body, external)).toBe('retry');
  const inbox = await orm.em.find(InboxMessageEntity, { messageId: external });
  expect(inbox).toHaveLength(0);
});

test('a quinta leitura de uma carteira inexistente cai na DLQ', async () => {
  const walletId = newId();
  const external = `dlq-missing-${walletId}`;
  const body = message({ id: walletId, playerId: newId() }, external, '10.00');
  await sqs.send(appConfig.sqs.wagerQueueUrl, body, walletId, external);

  let current = await sqs.receive(appConfig.sqs.wagerQueueUrl, 1, 2, 30);
  for (let count = 1; count <= 4; count++) {
    expect(current).toHaveLength(1);
    expect(current[0]?.receiveCount).toBe(count);
    await consumer.handle(current[0]!);
    await sqs.changeVisibility(appConfig.sqs.wagerQueueUrl, current[0]!.receiptHandle, 0);
    current = await sqs.receive(appConfig.sqs.wagerQueueUrl, 1, 2, 30);
  }

  expect(current[0]?.receiveCount).toBe(5);
  await consumer.handle(current[0]!);
  const dead = await sqs.receive(appConfig.sqs.dlqQueueUrl, 10, 2, 5);
  const mine = dead.find((item) => item.body === body);
  expect(mine).toBeTruthy();
  await Promise.all(dead.map((item) => sqs.delete(appConfig.sqs.dlqQueueUrl, item.receiptHandle)));
  const inbox = await orm.em.find(InboxMessageEntity, { messageId: current[0]!.messageId });
  expect(inbox).toHaveLength(0);
});

test('o desligamento devolve a mensagem que ainda está em curso', async () => {
  const walletId = newId();
  const external = `shutdown-${walletId}`;
  const body = message({ id: walletId, playerId: newId() }, external, '10.00');
  await sqs.send(appConfig.sqs.wagerQueueUrl, body, walletId, external);

  const parked = new ParkedConsumer(orm.em, wagering, sqs, metrics);
  const polling = parked.pollOnce(2);
  await parked.ready;
  await parked.releaseInflight(200);
  parked.finish();
  await polling;

  const again = await sqs.receive(appConfig.sqs.wagerQueueUrl, 1, 2, 5);
  expect(again[0]?.body).toBe(body);
  await sqs.delete(appConfig.sqs.wagerQueueUrl, again[0]!.receiptHandle);
});

test('divergência de reconciliação entra na métrica', async () => {
  const opened = await open('10.00');
  await orm.em.getConnection().execute(`update wallets set balance_amount = '15.00' where id = ?`, [opened.id]);
  orm.em.clear();
  const local = new Metrics();
  const report = await new WalletService(orm.em, local).reconcile(opened.id);
  expect(report.consistent).toBe(false);
  expect(report.difference).toEqual({ amount: '5.00', currency: 'BRL' });
  expect(local.render()).toContain('wallet_reconciliation_divergences_total 1');
});

test('um orm novo ainda reconcilia o saldo depois do restart', async () => {
  const opened = await open('20.00');
  await bet(opened.id, opened.playerId, '5.00', 'restart-bet');
  await orm.close();
  orm = await MikroORM.init({ ...config, allowGlobalContext: true });
  await orm.connect();
  wallets = new WalletService(orm.em);
  wagering = new WageringService(orm.em, metrics);
  outbox = new OutboxWorker(orm.em, sqs, metrics);
  consumer = new WageringConsumer(orm.em, wagering, sqs, metrics);
  const report = await wallets.reconcile(opened.id);
  expect(report.consistent).toBe(true);
  expect(report.storedBalance).toEqual({ amount: '15.00', currency: 'BRL' });
});

async function open(amount: string): Promise<{ id: string; playerId: string }> {
  const result = await wallets.open({
    playerId: newId(),
    initialBalance: { amount, currency: 'BRL' },
  });
  const body = result.body as { id: string; playerId: string };
  return { id: body.id, playerId: body.playerId };
}

async function bet(walletId: string, playerId: string, amount: string, name: string): Promise<void> {
  const external = `${name}-${walletId}`;
  await wagering.submit(`provider-a:${external}`, {
    providerId: 'provider-a',
    externalTransactionId: external,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  });
}

function message(wallet: { id: string; playerId: string }, external: string, amount: string): string {
  return JSON.stringify({
    messageId: external,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId: external,
      idempotencyKey: `provider-a:${external}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    },
  });
}

async function postponeOthers(walletId: string): Promise<void> {
  await orm.em.getConnection().execute(
    `update outbox_messages
        set next_attempt_at = now() + interval '1 day'
      where published_at is null and aggregate_id <> ?`,
    [walletId],
  );
}

async function publishAll(): Promise<void> {
  for (let step = 0; step < 40; step++) {
    const published = await outbox.publishDue();
    if (published === 0) return;
  }
}

function eventData(payload: Record<string, unknown>): {
  externalTransactionId?: string;
  direction?: string;
  money?: { amount?: string };
} {
  const data = payload.data;
  if (typeof data !== 'object' || data === null) return {};
  return data as { externalTransactionId?: string; direction?: string; money?: { amount?: string } };
}

class ParkedConsumer extends WageringConsumer {
  readonly ready: Promise<void>;
  private openReady!: () => void;
  private readonly parked: Promise<void>;
  private resume!: () => void;

  constructor(...args: ConstructorParameters<typeof WageringConsumer>) {
    super(...args);
    this.ready = new Promise((resolve) => {
      this.openReady = resolve;
    });
    this.parked = new Promise((resolve) => {
      this.resume = resolve;
    });
  }

  override async settle(): Promise<Delivery> {
    this.openReady();
    await this.parked;
    return 'retry';
  }

  finish(): void {
    this.resume();
  }
}

async function readEvents(ids: string[]): Promise<Set<string>> {
  const wanted = new Set(ids);
  const found = new Set<string>();
  const deadline = Date.now() + 8_000;
  while (found.size < wanted.size && Date.now() < deadline) {
    const messages = await sqs.receive(appConfig.sqs.eventsQueueUrl, 10, 1, 2);
    if (messages.length === 0) continue;
    for (const item of messages) {
      await sqs.delete(appConfig.sqs.eventsQueueUrl, item.receiptHandle);
      for (const id of wanted) {
        if (item.body.includes(id)) found.add(id);
      }
    }
  }
  return found;
}
