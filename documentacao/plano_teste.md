# Plano de teste

Este roteiro é para você executar e saber o que cada passo está provando. A conta que tem de fechar em tudo é esta: o saldo da carteira é a soma do ledger. Rejeição não lança. Repetir a mesma operação devolve o saldo daquela hora, não o saldo de agora.

Pare a API antes de `bun test`. Com ela no ar, o processo consome a fila e reprocessa referência pendente, e a suíte disputa essas mesmas filas.

## Subir

```sh
docker-compose up -d
```

O comando `bun` mora em `~/.bun/bin`. O terminal que já estava aberto responde `command not found`. Carregue o PATH e siga:

```sh
source ~/.zshrc
bun install
bun run db:up
bun run start:dev
```

Se o `source` não resolver, use `export PATH="$HOME/.bun/bin:$PATH"` e repita os três comandos. Um terminal novo já lê isso do `~/.zshrc`.

Postgres no host é a porta `5434`. As filas são `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo` no LocalStack (`localhost:4566`).

O banco já tem linhas de execuções anteriores da suíte. Isso não atrapalha: cada carteira nova é de um jogador novo. No log podem aparecer rejeições de referências velhas. São restos, não o seu cenário.

`bun run start:dev` ocupa esse terminal. Abra outro. `api` não é um programa instalado: é uma função daquele shell. Sem colar o bloco abaixo, o zsh responde `command not found: api`.

```sh
api() {
  curl -sS -w "\nHTTP %{http_code}\n" -X "$1" "http://localhost:3000$2" \
    -H 'content-type: application/json' "${@:3}"
}
PLAYER=$(uuidgen | tr '[:upper:]' '[:lower:]')
echo "$PLAYER"
```

Dinheiro vai sempre como string com duas casas (`"40.00"`). Um número JSON no amount é payload inválido.

## O que cada HTTP significa

| Código | Situação |
| --- | --- |
| 201 | carteira criada |
| 200 | transação processada, ou reconciliação |
| 202 | aceita e ainda pendente da referência |
| 422 | regra de negócio, com `failureCode`, gravada |
| 409 | mesma carteira de novo, ou a mesma chave com outro payload |
| 400 | payload inválido |
| 404 | carteira ou transação que não existe |
| 503 | Postgres ou fila fora |

## 1. Processo e dependências

No segundo terminal, depois de colar a função `api`:

```sh
api GET /health/live
api GET /health/ready
```

`live` só diz que o processo responde. `ready` fala com o Postgres e com as filas. Os dois ficam sem autenticação.

## 2. Abrir a carteira

```sh
api POST /wallets -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}"
```

Guarde o `id` que voltar:

```sh
WALLET=cole-o-id
```

Esperado: HTTP 201, `balance.amount` `100.00`, `version` 1. A versão já nasce em 1 com o saldo aplicado. O crédito inicial é um lançamento `OPENING`, não um segundo incremento de versão.

```sh
api GET "/wallets/$WALLET/ledger?limit=50"
```

Um item, `direction` `CREDIT`, `balanceBefore` `0.00`, `balanceAfter` `100.00`.

Saldo zero não gera lançamento. Vale abrir outra carteira com `"0.00"` e ver `items` vazio e `version` 1.

A mesma pessoa e a mesma moeda de novo:

```sh
api POST /wallets -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}"
```

HTTP 409. A unicidade é do banco (`player` + moeda), não de uma checagem solta.

## 3. Aposta, e o saldo que o replay guarda

```sh
api POST /wagering/transactions \
  -H 'Idempotency-Key: provider-a:aposta-40' \
  -H 'X-Correlation-Id: roteiro-aposta' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"aposta-40\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"40.00\",\"currency\":\"BRL\"}}"
```

HTTP 200, `status` `PROCESSED`, `balance.amount` `60.00`, `idempotentReplay` false. Guarde o `transactionId`.

O log da API traz `correlationId`, `transactionId`, `walletId` e `providerId`. Não traz o valor da aposta.

Agora um ganho, para o saldo vivo andar:

```sh
api POST /wagering/transactions \
  -H 'Idempotency-Key: provider-a:ganho-10' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"ganho-10\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"WIN\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}"
```

HTTP 200, saldo `70.00`. `WIN` sem referência credita na hora.

Repita a aposta com a mesma chave e o mesmo corpo:

```sh
api POST /wagering/transactions \
  -H 'Idempotency-Key: provider-a:aposta-40' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"aposta-40\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"40.00\",\"currency\":\"BRL\"}}"
```

HTTP 200, `idempotentReplay` true, `balance.amount` ainda `60.00`. Esse 60 é o saldo gravado na hora da aposta. A carteira, agora, está em 70:

```sh
api GET "/wallets/$WALLET"
```

A mesma chave com outro valor não é replay. O saldo não pode mudar:

```sh
C
```

HTTP 409. `GET /wallets/$WALLET` continua `70.00`.

## 4. Sem saldo, perda, estorno e rollback

Aposta maior que o saldo:

```sh
api POST /wagering/transactions \
  -H 'Idempotency-Key: provider-a:aposta-80' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"aposta-80\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"80.00\",\"currency\":\"BRL\"}}"
```

HTTP 422, `failureCode` `INSUFFICIENT_FUNDS`. A carteira segue em `70.00`. Essa rejeição não entra no ledger.

Perda confirma a rodada e não mexe no saldo:

```sh
api POST /wagering/transactions \
  -H 'Idempotency-Key: provider-a:perda-1' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"perda-1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"LOSS\",\"money\":{\"amount\":\"40.00\",\"currency\":\"BRL\"}}"
```

HTTP 200, saldo `70.00`. No ledger não aparece linha dessa `LOSS`.

Estorno da aposta de 40. O valor tem de ser o mesmo, a rodada a mesma, e a referência uma `BET` já processada:

```sh
api POST /wagering/transactions \
  -H 'Idempotency-Key: provider-a:estorno-40' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"estorno-40\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"REFUND\",\"money\":{\"amount\":\"40.00\",\"currency\":\"BRL\"},\"referenceExternalTransactionId\":\"aposta-40\"}"
```

HTTP 200, saldo `110.00`. Um crédito no ledger.

O segundo estorno da mesma aposta:

```sh
api POST /wagering/transactions \
  -H 'Idempotency-Key: provider-a:estorno-40-de-novo' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"estorno-40-de-novo\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"REFUND\",\"money\":{\"amount\":\"40.00\",\"currency\":\"BRL\"},\"referenceExternalTransactionId\":\"aposta-40\"}"
```

HTTP 422, `ALREADY_REVERSED`. Saldo continua `110.00`.

Rollback desfaz o estorno. A referência agora é o `REFUND`, e o lançamento é o inverso (um débito):

```sh
api POST /wagering/transactions \
  -H 'Idempotency-Key: provider-a:rollback-estorno' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"rollback-estorno\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"ROLLBACK\",\"money\":{\"amount\":\"40.00\",\"currency\":\"BRL\"},\"referenceExternalTransactionId\":\"estorno-40\"}"
```

HTTP 200, saldo `70.00`.

Sem `referenceExternalTransactionId`, `REFUND` e `ROLLBACK` são HTTP 400. Não chega a gravar transação.

## 5. Ledger e reconciliação

```sh
api POST "/wallets/$WALLET/reconciliation"
```

HTTP 200, `consistent` true, `storedBalance` e `calculatedBalance` em `70.00`, `difference` `0.00`.

A soma que você está conferindo: crédito inicial 100, débito da aposta 40, crédito do ganho 10, crédito do estorno 40, débito do rollback 40. `100 - 40 + 10 + 40 - 40 = 70`. A perda e a aposta rejeitada ficam de fora.

O cursor é opaco. Peça uma linha por vez e vá passando `nextCursor` até vir `null`. São cinco lançamentos, sem pular e sem repetir o último da página anterior.

```sh
api GET "/wallets/$WALLET/ledger?limit=1"
```

Se um dia `consistent` vier false, o processo escreve `wallet.diverged` e soma `wallet_reconciliation_divergences_total`. Ele não corrige o saldo sozinho.

## 6. Estorno que chega antes da aposta

Carteira nova, para não misturar com a conta de cima.

```sh
PLAYER2=$(uuidgen | tr '[:upper:]' '[:lower:]')
api POST /wallets -d "{\"playerId\":\"$PLAYER2\",\"initialBalance\":{\"amount\":\"50.00\",\"currency\":\"BRL\"}}"
```

Guarde esse `id` em `WALLET2`. Mande o estorno antes da aposta:

```sh
api POST /wagering/transactions \
  -H 'Idempotency-Key: provider-a:estorno-cedo' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"estorno-cedo\",\"playerId\":\"$PLAYER2\",\"walletId\":\"$WALLET2\",\"roundId\":\"round-2\",\"gameId\":\"fortune-chimp\",\"kind\":\"REFUND\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"},\"referenceExternalTransactionId\":\"aposta-cedo\"}"
```

HTTP 202, `status` `PENDING_REFERENCE`. O saldo da carteira continua `50.00`. A linha ficou gravada para o worker, com a primeira tentativa para agora.

Aí a aposta:

```sh
api POST /wagering/transactions \
  -H 'Idempotency-Key: provider-a:aposta-cedo' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"aposta-cedo\",\"playerId\":\"$PLAYER2\",\"walletId\":\"$WALLET2\",\"roundId\":\"round-2\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}"
```

HTTP 200, saldo `40.00`.

O processo da API, no mesmo ciclo, reprocessa pendência, publica a outbox e só então fica até 20 segundos esperando a fila. Por isso o estorno não vira `PROCESSED` no mesmo instante. Consulte de novo por uns 30 segundos:

```sh
api GET /providers/provider-a/wagering/transactions/estorno-cedo
api GET "/wallets/$WALLET2"
```

O estorno passa a `PROCESSED` e a carteira volta a `50.00`: a aposta tirou 10, o estorno devolveu 10. Reconcilie essa carteira também.

Se a referência nunca aparecer, o worker desiste na décima tentativa ou aos 15 minutos e grava `REFERENCE_NOT_FOUND`. Isso a suíte adianta no relógio. No roteiro manual, não espere esse prazo.

## 7. A mesma regra pela fila

Com a API ainda no ar, a aposta pode entrar pela `wager-transactions.fifo`. O consumidor chama o mesmo caso de uso do HTTP. Rode na raiz do projeto, com `WALLET` e `PLAYER` da primeira carteira (saldo `70.00`):

```sh
WALLET="$WALLET" PLAYER="$PLAYER" bun -e '
import { SqsQueue } from "./src/messaging/sqs.client.ts";
const walletId = process.env.WALLET;
const playerId = process.env.PLAYER;
const external = "aposta-fila";
const body = JSON.stringify({
  messageId: external,
  type: "WagerTransactionRequested",
  occurredAt: new Date().toISOString(),
  data: {
    providerId: "provider-a",
    externalTransactionId: external,
    idempotencyKey: "provider-a:" + external,
    playerId,
    walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "10.00", currency: "BRL" },
  },
});
await new SqsQueue().send(
  "http://localhost:4566/000000000000/wager-transactions.fifo",
  body,
  walletId,
  external,
);
console.log(external);
'
```

Espere o ciclo da API (até cerca de 20 segundos) e consulte:

```sh
api GET /providers/provider-a/wagering/transactions/aposta-fila
api GET "/wallets/$WALLET"
```

`PROCESSED` e saldo `60.00`. Mandar o mesmo `external` de novo não debita outra vez: a inbox reconhece a mensagem e a chave de idempotência também.

Uma mensagem que não é JSON vai para `wager-transactions-dlq.fifo` na hora. Carteira que ainda não existe volta para a fila; na quinta leitura vai para a DLQ. Rejeição de saldo (`INSUFFICIENT_FUNDS`) dá ack e não vai para a DLQ: reenviar não mudaria a regra.

## 8. Métricas

```sh
api GET /metrics
```

Conteúdos que o enunciado pede e que esse texto expõe:

| Nome | O que conta |
| --- | --- |
| `wager_transactions_total` | transação por `status` e `kind` |
| `wager_duplicates_total` | replay e redelivery já processado |
| `wager_retries_total` | retry, com `source` `sqs`, `outbox` ou `reference` |
| `wager_dlq_messages_total` | envio à DLQ |
| `wager_lock_conflicts_total` | deadlock |
| `wallet_reconciliation_divergences_total` | reconciliação que não fechou |
| `outbox_lag_seconds` | atraso do evento mais antigo ainda não publicado |
| `wager_processing_seconds` | latência do processamento |

Os contadores não zeram ao subir o processo, e o loop pode ter reprocessado pendências antigas antes do seu roteiro. Leia o número, faça uma aposta, leia de novo e veja o incremento.

## 9. Suíte automática

Pare a API (Ctrl+C no `start:dev`). Docker continua no ar.

```sh
bun test
```

São testes contra Postgres e LocalStack de verdade. Unidade não sobe serviço. A suíte leva por volta de 8 segundos. Dados ficam no banco: o ledger não aceita delete, e o teste que prova isso espera o erro.

Para um caso só:

```sh
bun test src/wagering/wagering.integration.spec.ts -t "duas apostas disputando"
```

### Dinheiro e regras

Arquivos: `src/money/money.spec.ts`, `src/wallet/wallet.spec.ts`, `src/ledger/ledger-entry.spec.ts`, `src/wagering/wager-transaction.spec.ts`, `src/wagering/payload-hash.spec.ts`, `src/wagering/wagering.integration.spec.ts`.

| Teste | O que você está vendo |
| --- | --- |
| dinheiro mantém duas casas e recusa o resto | amount é string canônica; conta entre moedas diferentes quebra |
| carteira abre na versão 1 | débito sem saldo não altera o objeto |
| ledger fecha o saldo antes e depois | lançamento torto nem nasce |
| `OPENING` só pela fábrica interna | a API não aceita esse tipo |
| hash ignora ordem de chave | o hash da idempotência não leva header |
| abrir carteira grava crédito e versão 1 | o caminho do roteiro manual, no banco |
| segunda carteira conflita | 409 de jogador + moeda |
| saldo zero não cria lançamento | |
| replay devolve o saldo da primeira aposta | o 60 que continua 60 depois do ganho |
| mesma chave com outro valor conflita | 409, um débito só |
| moeda diferente | `CURRENCY_MISMATCH`, saldo parado |
| `LOSS` | rodada registrada, ledger intocado |
| `WIN` | crédito; com aposta da rodada também credita; aposta ausente fica pendente |
| `REFUND` | devolve a aposta uma vez; segundo é `ALREADY_REVERSED`; valor, tipo ou rodada errados rejeitam |
| `REFUND` sem referência | HTTP 400 |
| `ROLLBACK` | credita a aposta, debita o ganho, desfaz o estorno |
| rollback que deixaria saldo negativo | `REVERSAL_WOULD_OVERDRAW`, diferente de aposta sem fundos |
| cursor do ledger | página de 1 e o resto, sem pular |

### Concorrência

A trava é a linha da carteira. Duas carteiras seguem juntas. A mesma carteira é uma de cada vez.

| Teste | Resultado |
| --- | --- |
| duas apostas de 80 em saldo 100 | uma `PROCESSED`, uma `INSUFFICIENT_FUNDS`, saldo `20.00`, um débito |
| cinquenta cópias da mesma aposta | um débito |
| dois `REFUND` paralelos | um crédito |
| carteiras distintas em paralelo | as duas andam |
| três processos na mesma carteira | três apostas de 40 em saldo 100: duas passam, uma rejeita, saldo `20.00` |
| três processos com a mesma chave | um débito, saldo `75.00` |

Os três processos são três `bun` chamando o mesmo serviço e o mesmo Postgres. É isso que mostra que a correção não depende de um único processo na memória.

### Fila, outbox e queda

Arquivo: `src/messaging/messaging.integration.spec.ts`. O limiar da quinta leitura também está em `src/messaging/delivery.spec.ts`.

| Teste | O que você está vendo |
| --- | --- |
| saldo negativo e ledger imutável | o banco recusa os dois, não só o código |
| outbox sobrevive a quem morre antes do envio | o evento está na tabela; publicar vem depois do commit |
| dois publicadores | cada evento sai uma vez |
| fila, inbox e redelivery | commit, a mensagem volta, o segundo processamento não debita de novo; inbox, débito e outbox daquela aposta estão lá |
| rejeição de negócio dá ack | `INSUFFICIENT_FUNDS` não vai para a DLQ; JSON inválido vai |
| carteira inexistente | pede retry e não grava inbox |
| quinta leitura | a mesma mensagem transitória cai na DLQ |
| desligamento | o que ainda está em curso volta com visibilidade zero e não recebe ack |
| divergência | saldo gravado diferente do ledger entra no log e na métrica |
| restart | fecha o ORM, abre outro, a reconciliação continua fechando |

## Quando um passo manual não bater

| O que você viu | Onde olhar |
| --- | --- |
| `ready` em 503 | `docker-compose ps`; Postgres em `5434`, LocalStack em `4566` |
| replay devolve o saldo vivo | a resposta tem de ser o saldo gravado na transação; confira `idempotentReplay` |
| estorno pendente não anda | a API está no ar? O ciclo espera a fila até 20s. Consulte de novo |
| `bun test` falha na fila com saldo estranho | a API ficou consumindo. Pare o `start:dev` e rode outra vez |
| métrica já vem maior que zero | execução anterior e pendência velha. Compare antes e depois do seu passo |
