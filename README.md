# Wagering processor

Serviço de transações de apostas do desafio.

## Infra

```sh
docker compose up -d
```

Se o plugin não estiver instalado, use `docker-compose up -d`. O Postgres do Compose fica na porta 5434 do host.

Sobe PostgreSQL 16, Zitadel na porta 8081 e LocalStack com as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`.

O Zitadel usa o mesmo Postgres. A conta de serviço é `wagering-api`. Health não pede token. O restante da API pede o access token:

```sh
bun run token
```

O trace do OpenTelemetry sai no log do processo (`wager.submit`, `wager.consume`, `outbox.publish`). Não há dashboard.

## API

O runtime é o Bun 1.4. Se `bun` não existir:

```sh
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4"
source ~/.zshrc
```

O instalador grava o binário em `~/.bun/bin` e o `PATH` no `~/.zshrc`. Um terminal que já estava aberto continua sem o comando. Nesse caso, `source ~/.zshrc`. Se ainda falhar:

```sh
export PATH="$HOME/.bun/bin:$PATH"
```

```sh
bun install
bun run db:up
bun run start:dev
```

Os defaults batem com o Compose. Para mudar, copie `.env.example` para `.env`.

O processo também reprocessa referência pendente, publica a outbox e consome a fila de apostas.

- `GET /health/live` — processo no ar
- `GET /health/ready` — Postgres e as filas alcançáveis
- `GET /metrics` — contadores e atraso da outbox

## Testes

Pare o `start:dev` antes da suíte. Com a API no ar, ela consome `wager-transactions.fifo` e os testes da fila não encontram a mensagem que acabaram de enviar. No terminal da API, Ctrl+C. A porta 3000 tem de ficar livre:

```sh
lsof -nP -iTCP:3000 -sTCP:LISTEN
bun test
```

O teste de carga usa o mesmo Postgres e o LocalStack. A API também precisa estar parada. O comando regrava `documentacao/carga.md` com o ambiente, a metodologia, o throughput, p50/p95/p99, a taxa de erro, os conflitos e o atraso da outbox.

```sh
bun run test:load
```

## Migrations

```sh
bun run db:up
bun run db:down
```
