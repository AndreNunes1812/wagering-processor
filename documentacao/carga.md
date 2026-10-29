# Teste de carga

Registro de `bun run test:load`, gerado em 2026-10-29T15:56:25.277Z.

## Ambiente

- Máquina: darwin arm64 25.5.0, 8 CPUs (Apple M3), 16384 MB de RAM
- Bun: 1.4.4
- Postgres: PostgreSQL 16.15 (Debian 16.15-1.pgdg13+2) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit
- Banco local em `localhost:5434`, fila de eventos em `http://localhost:4566/000000000000/wager-events.fifo`
- Um processo, pool de 30 conexões. A API estava parada. Sem HTTP e sem várias instâncias.

## Metodologia

A fase fria abre 100 carteiras com `100.00` e aposta `10.00` em cada uma, com até 20 transações ao mesmo tempo. Carteiras diferentes não disputam a mesma trava. O saldo esperado de cada uma é `90.00`.

A fase quente é o cenário da seção 8 com mais concorrência: 20 apostas de `10.00` ao mesmo tempo numa carteira de `100.00`. O esperado é 10 `PROCESSED`, 10 `INSUFFICIENT_FUNDS`, saldo `0.00` e 10 débitos.

A latência é o tempo de `submit`, em milissegundos, medido com `performance.now`. O percentil usa rank mais próximo: a posição `ceil(p/100*n) - 1` da amostra ordenada. A taxa de erro conta exceção e status inesperado. `INSUFFICIENT_FUNDS` na carteira quente é rejeição de negócio, não erro.

O atraso da outbox é a idade do evento mais antigo desta leva ainda não publicado, medida no Postgres antes do envio. O banco já tinha eventos antigos de outras execuções. Eles ficam de fora desta conta e não são publicados aqui. Em seguida um publicador envia só os eventos destas carteiras para `wager-events.fifo`.

## Resultado

| Fase | Operações | Duração | Throughput | p50 | p95 | p99 | máx |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Fria | 100 | 1.24 s | 80.9 /s | 181.41 ms | 602.43 ms | 648.63 ms | 661.97 ms |
| Quente | 20 | 0.63 s | 31.6 /s | 385.11 ms | 605.95 ms | 631.02 ms | 631.02 ms |

- Taxa de erro: 0 de 120 (0.0%).
- Carteira quente: 10 processadas, 10 `INSUFFICIENT_FUNDS`, saldo `0.00`, 10 débitos.
- Carteiras frias fora de `90.00`: 0.
- Conflitos de lock (`wager_lock_conflicts_total`): 0.
- Reconciliação da carteira quente: consistente. Amostra fria: consistente.
- Outbox desta leva, antes de publicar: 432 eventos, atraso 4.289 s.
- Publicados: 432. Falha de envio: nenhuma.
- Outbox desta leva, depois: 0 eventos, atraso 0.000 s.
- Backlog antigo no mesmo banco, não publicado por este teste: 2872 eventos, o mais velho com 75748.5 s.

## Leitura

O saldo fechou com o ledger. A outbox desta leva foi publicada. A fase fria é o throughput sem disputa de carteira. A fase quente é mais lenta porque a trava é a linha da carteira: as apostas passam uma de cada vez, e metade perde o saldo. Não houve deadlock. O conflito observado é a rejeição por saldo insuficiente. Não há meta de RPS. O número é deste laptop, com um processo e o LocalStack na mesma máquina.

