import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { LockMode, MikroORM } from '@mikro-orm/core';
import { ApiResult } from '../api-result';
import { config as appConfig } from '../config';
import config from '../database/mikro-orm.config';
import { newId } from '../ids';
import { Metrics } from '../metrics';
import { OutboxMessageEntity } from '../messaging/outbox.entity';
import { SqsQueue } from '../messaging/sqs.client';
import { WalletService } from '../wallet/wallet.service';
import { WageringService } from '../wagering/wagering.service';

const COLD_WALLETS = 100;
const COLD_CONCURRENCY = 20;
const HOT_BETS = 20;
const REPORT = 'documentacao/carga.md';

type Sample = {
  ms: number;
  status: number | null;
  failureCode?: string;
  error?: string;
};

async function main(): Promise<void> {
  if (await apiIsUp()) {
    throw new Error('a API está na porta 3000 e consome a fila; pare o start:dev antes de bun run test:load');
  }

  const orm = await MikroORM.init({
    ...config,
    allowGlobalContext: true,
    pool: { min: 1, max: 30 },
  });
  const metrics = new Metrics();
  const wallets = new WalletService(orm.em);
  const wagering = new WageringService(orm.em, metrics);
  const sqs = new SqsQueue();
  const startedAt = new Date();

  try {
    await orm.connect();
    await sqs.ping();
    const postgres = await postgresVersion(orm);
    const before = await backlog(orm);

    const coldWallets = await openMany(wallets, COLD_WALLETS, '100.00');
    const coldStarted = performance.now();
    const cold = await mapPool(coldWallets, COLD_CONCURRENCY, (wallet) =>
      timed(() => bet(wagering, wallet, '10.00', 'cold')),
    );
    const coldMs = performance.now() - coldStarted;

    const hotWallet = await openOne(wallets, '100.00');
    const hotStarted = performance.now();
    const hot = await Promise.all(
      Array.from({ length: HOT_BETS }, (_, index) => timed(() => bet(wagering, hotWallet, '10.00', `hot-${index}`))),
    );
    const hotMs = performance.now() - hotStarted;

    orm.em.clear();
    const broken = await brokenBalances(orm, coldWallets.map((wallet) => wallet.id));
    const hotBalance = balanceAmount(await wallets.get(hotWallet.id));
    const debits = await debitCount(orm, hotWallet.id);
    const hotReport = await wallets.reconcile(hotWallet.id);
    const coldReport = await wallets.reconcile(coldWallets[0]!.id);
    const ours = [...coldWallets.map((wallet) => wallet.id), hotWallet.id];
    const pending = await outboxLag(orm, ours);
    const published = await publishOurs(orm, sqs, ours);
    const left = await outboxLag(orm, ours);

    const report = render({
      startedAt,
      postgres,
      before,
      cold,
      coldMs,
      hot,
      hotMs,
      broken,
      hotBalance,
      debits,
      hotConsistent: hotReport.consistent === true,
      coldConsistent: coldReport.consistent === true,
      pending,
      published,
      left,
      lockConflicts: counter(metrics.render(), 'wager_lock_conflicts_total'),
    });
    writeFileSync(REPORT, report.text);
    process.stdout.write(report.text);
    if (!report.ok) process.exitCode = 1;
  } finally {
    await orm.close();
  }
}

async function apiIsUp(): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${appConfig.port}/health/live`, {
      signal: AbortSignal.timeout(400),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function openMany(wallets: WalletService, count: number, amount: string): Promise<Opened[]> {
  const opened: Opened[] = [];
  for (let index = 0; index < count; index += 1) opened.push(await openOne(wallets, amount));
  return opened;
}

async function openOne(wallets: WalletService, amount: string): Promise<Opened> {
  const result = await wallets.open({
    playerId: newId(),
    initialBalance: { amount, currency: 'BRL' },
  });
  const body = result.body as { id?: string; playerId?: string };
  if (result.statusCode !== 201 || !body.id || !body.playerId) {
    throw new Error(`abertura de carteira respondeu ${result.statusCode}`);
  }
  return { id: body.id, playerId: body.playerId };
}

function bet(wagering: WageringService, wallet: Opened, amount: string, name: string): Promise<ApiResult> {
  const external = `${name}-${wallet.id}`;
  return wagering.submit(`provider-a:${external}`, {
    providerId: 'provider-a',
    externalTransactionId: external,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-load',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  });
}

async function timed(run: () => Promise<ApiResult>): Promise<Sample> {
  const start = performance.now();
  try {
    const result = await run();
    const failureCode = result.body.failureCode;
    return {
      ms: performance.now() - start,
      status: result.statusCode,
      ...(typeof failureCode === 'string' ? { failureCode } : {}),
    };
  } catch (error) {
    return {
      ms: performance.now() - start,
      status: null,
      error: error instanceof Error ? error.message : 'falha',
    };
  }
}

async function mapPool<T>(items: T[], limit: number, run: (item: T) => Promise<Sample>): Promise<Sample[]> {
  const samples: Sample[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item !== undefined) samples[index] = await run(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return samples;
}

async function publishOurs(orm: MikroORM, sqs: SqsQueue, ids: string[]): Promise<{ published: number; failed: string | null }> {
  let published = 0;
  let failed: string | null = null;
  for (;;) {
    const outcome = await orm.em.transactional(async (em) => {
      const row = await em.findOne(
        OutboxMessageEntity,
        {
          publishedAt: null,
          aggregateId: { $in: ids },
          $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: new Date() } }],
        },
        { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, orderBy: { occurredAt: 'asc', id: 'asc' } },
      );
      if (!row) return 'empty' as const;
      try {
        await sqs.publishEvent(row.payload, row.aggregateId, row.id);
        row.publishedAt = new Date();
        row.nextAttemptAt = null;
        return 'published' as const;
      } catch (error) {
        return error instanceof Error ? error.message : 'publish failed';
      }
    });
    if (outcome === 'empty') break;
    if (outcome === 'published') {
      published += 1;
      continue;
    }
    failed = outcome;
    break;
  }
  return { published, failed };
}

async function postgresVersion(orm: MikroORM): Promise<string> {
  const rows = await orm.em.getConnection().execute<{ version: string }>('select version() as version');
  return rows[0]?.version ?? 'desconhecida';
}

async function backlog(orm: MikroORM): Promise<{ rows: number; seconds: number }> {
  const rows = await orm.em.getConnection().execute<{ rows: number; seconds: string }>(
    `select count(*)::int as rows,
            coalesce(extract(epoch from (clock_timestamp() - min(occurred_at))), 0) as seconds
       from outbox_messages
      where published_at is null`,
  );
  return { rows: Number(rows[0]?.rows ?? 0), seconds: Number(rows[0]?.seconds ?? 0) };
}

async function outboxLag(orm: MikroORM, ids: string[]): Promise<{ rows: number; seconds: number }> {
  const rows = await orm.em.getConnection().execute<{ rows: number; seconds: string }>(
    `select count(*)::int as rows,
            coalesce(extract(epoch from (clock_timestamp() - min(occurred_at))), 0) as seconds
       from outbox_messages
      where published_at is null
        and aggregate_id = any(string_to_array(?, ','))`,
    [ids.join(',')],
  );
  return { rows: Number(rows[0]?.rows ?? 0), seconds: Number(rows[0]?.seconds ?? 0) };
}

async function brokenBalances(orm: MikroORM, ids: string[]): Promise<number> {
  const rows = await orm.em.getConnection().execute<{ wrong: number }>(
    `select count(*)::int as wrong
       from wallets
      where id = any(string_to_array(?, ',')::uuid[])
        and balance_amount <> 90.00`,
    [ids.join(',')],
  );
  return Number(rows[0]?.wrong ?? 0);
}

async function debitCount(orm: MikroORM, walletId: string): Promise<number> {
  const rows = await orm.em.getConnection().execute<{ debits: number }>(
    `select count(*)::int as debits
       from wallet_ledger_entries
      where wallet_id = ? and direction = 'DEBIT'`,
    [walletId],
  );
  return Number(rows[0]?.debits ?? 0);
}

function balanceAmount(wallet: Record<string, unknown>): string {
  const balance = wallet.balance as { amount?: string } | undefined;
  return balance?.amount ?? '';
}

function counter(rendered: string, name: string): number {
  const line = rendered.split('\n').find((item) => item.startsWith(`${name} `));
  return Number(line?.split(' ').at(-1) ?? 0);
}

function render(input: Report): { text: string; ok: boolean } {
  const coldStats = summarize(input.cold.map((sample) => sample.ms));
  const hotStats = summarize(input.hot.map((sample) => sample.ms));
  const coldErrors = input.cold.filter((sample) => sample.error || sample.status !== 200);
  const hotProcessed = input.hot.filter((sample) => sample.status === 200).length;
  const hotRejected = input.hot.filter((sample) => sample.failureCode === 'INSUFFICIENT_FUNDS').length;
  const hotErrors = input.hot.filter((sample) => sample.error || (sample.status !== 200 && sample.failureCode !== 'INSUFFICIENT_FUNDS'));
  const attempts = input.cold.length + input.hot.length;
  const errors = coldErrors.length + hotErrors.length;
  const moneyOk = input.broken === 0 && input.hotBalance === '0.00' && input.debits === 10 && input.hotConsistent && input.coldConsistent;
  const outboxOk = input.left.rows === 0 && input.published.failed === null && input.published.published === input.pending.rows;
  const cpu = cpus()[0]?.model ?? 'desconhecido';

  const text = `# Teste de carga

Registro de \`bun run test:load\`, gerado em ${input.startedAt.toISOString()}.

## Ambiente

- Máquina: ${platform()} ${arch()} ${release()}, ${cpus().length} CPUs (${cpu}), ${Math.round(totalmem() / (1024 * 1024))} MB de RAM
- Bun: ${Bun.version}
- Postgres: ${input.postgres}
- Banco local em \`${appConfig.database.host}:${appConfig.database.port}\`, fila de eventos em \`${appConfig.sqs.eventsQueueUrl}\`
- Um processo, pool de 30 conexões. A API estava parada. Sem HTTP e sem várias instâncias.

## Metodologia

A fase fria abre ${COLD_WALLETS} carteiras com \`100.00\` e aposta \`10.00\` em cada uma, com até ${COLD_CONCURRENCY} transações ao mesmo tempo. Carteiras diferentes não disputam a mesma trava. O saldo esperado de cada uma é \`90.00\`.

A fase quente é o cenário da seção 8 com mais concorrência: ${HOT_BETS} apostas de \`10.00\` ao mesmo tempo numa carteira de \`100.00\`. O esperado é 10 \`PROCESSED\`, 10 \`INSUFFICIENT_FUNDS\`, saldo \`0.00\` e 10 débitos.

A latência é o tempo de \`submit\`, em milissegundos, medido com \`performance.now\`. O percentil usa rank mais próximo: a posição \`ceil(p/100*n) - 1\` da amostra ordenada. A taxa de erro conta exceção e status inesperado. \`INSUFFICIENT_FUNDS\` na carteira quente é rejeição de negócio, não erro.

O atraso da outbox é a idade do evento mais antigo desta leva ainda não publicado, medida no Postgres antes do envio. O banco já tinha eventos antigos de outras execuções. Eles ficam de fora desta conta e não são publicados aqui. Em seguida um publicador envia só os eventos destas carteiras para \`wager-events.fifo\`.

## Resultado

| Fase | Operações | Duração | Throughput | p50 | p95 | p99 | máx |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Fria | ${input.cold.length} | ${seconds(input.coldMs)} | ${rate(input.cold.length, input.coldMs)} | ${ms(coldStats.p50)} | ${ms(coldStats.p95)} | ${ms(coldStats.p99)} | ${ms(coldStats.max)} |
| Quente | ${input.hot.length} | ${seconds(input.hotMs)} | ${rate(input.hot.length, input.hotMs)} | ${ms(hotStats.p50)} | ${ms(hotStats.p95)} | ${ms(hotStats.p99)} | ${ms(hotStats.max)} |

- Taxa de erro: ${errors} de ${attempts} (${percent(errors, attempts)}).
- Carteira quente: ${hotProcessed} processadas, ${hotRejected} \`INSUFFICIENT_FUNDS\`, saldo \`${input.hotBalance}\`, ${input.debits} débitos.
- Carteiras frias fora de \`90.00\`: ${input.broken}.
- Conflitos de lock (\`wager_lock_conflicts_total\`): ${input.lockConflicts}.
- Reconciliação da carteira quente: ${input.hotConsistent ? 'consistente' : 'divergente'}. Amostra fria: ${input.coldConsistent ? 'consistente' : 'divergente'}.
- Outbox desta leva, antes de publicar: ${input.pending.rows} eventos, atraso ${input.pending.seconds.toFixed(3)} s.
- Publicados: ${input.published.published}. Falha de envio: ${input.published.failed ?? 'nenhuma'}.
- Outbox desta leva, depois: ${input.left.rows} eventos, atraso ${input.left.seconds.toFixed(3)} s.
- Backlog antigo no mesmo banco, não publicado por este teste: ${input.before.rows} eventos, o mais velho com ${input.before.seconds.toFixed(1)} s.

## Leitura

${moneyOk ? 'O saldo fechou com o ledger.' : 'O saldo não fechou com o ledger.'} ${outboxOk ? 'A outbox desta leva foi publicada.' : 'A outbox desta leva ficou incompleta.'} A fase fria é o throughput sem disputa de carteira. A fase quente é mais lenta porque a trava é a linha da carteira: as apostas passam uma de cada vez, e metade perde o saldo. ${input.lockConflicts === 0 ? 'Não houve deadlock. O conflito observado é a rejeição por saldo insuficiente.' : `Houve ${input.lockConflicts} deadlocks, e o serviço tentou de novo.`} Não há meta de RPS. O número é deste laptop, com um processo e o LocalStack na mesma máquina.
${errors === 0 ? '' : `\nFalhas:\n\n${[...coldErrors, ...hotErrors].map((sample) => `- ${sample.error ?? sample.failureCode ?? sample.status}`).join('\n')}\n`}
`;
  return { text, ok: moneyOk && outboxOk && errors === 0 };
}

function summarize(samples: number[]): { p50: number; p95: number; p99: number; max: number } {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    p50: rank(sorted, 50),
    p95: rank(sorted, 95),
    p99: rank(sorted, 99),
    max: sorted.at(-1) ?? 0,
  };
}

function rank(sorted: number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function ms(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function seconds(value: number): string {
  return `${(value / 1000).toFixed(2)} s`;
}

function rate(count: number, elapsedMs: number): string {
  if (elapsedMs <= 0) return '0 /s';
  return `${(count / (elapsedMs / 1000)).toFixed(1)} /s`;
}

function percent(count: number, total: number): string {
  if (total === 0) return '0%';
  return `${((count / total) * 100).toFixed(1)}%`;
}

type Opened = { id: string; playerId: string };

type Report = {
  startedAt: Date;
  postgres: string;
  before: { rows: number; seconds: number };
  cold: Sample[];
  coldMs: number;
  hot: Sample[];
  hotMs: number;
  broken: number;
  hotBalance: string;
  debits: number;
  hotConsistent: boolean;
  coldConsistent: boolean;
  pending: { rows: number; seconds: number };
  published: { published: number; failed: string | null };
  left: { rows: number; seconds: number };
  lockConflicts: number;
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
