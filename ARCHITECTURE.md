# Arquitetura

O serviço aplica aposta, ganho, perda, estorno e rollback na mesma transação SQL da carteira. A fila e a outbox entram depois do commit, não no lugar dele.

## Dinheiro

`Money` guarda centavos em `bigint`. O contrato e o banco usam string decimal com duas casas (`numeric(20,2)`). Se o driver devolver `number`, a persistência falha em vez de gravar um valor arredondado.

A carteira nasce na versão 1, já com o saldo inicial. Saldo positivo gera um crédito interno `OPENING` no mesmo commit. Saldo zero não gera lançamento. Débito e crédito sobem a versão. `LOSS` confirma a rodada e não mexe no saldo.

A unidade de concorrência é a carteira: `SELECT … FOR UPDATE` nela antes de mudar o saldo. Duas carteiras seguem em paralelo. A versão otimista continua no registro, mas a trava pessimista é a garantia contra lost update.

## Idempotência

O header `Idempotency-Key` é a chave. O hash é SHA-256 do JSON canônico dos campos de negócio, sem header e sem metadado de transporte. A mesma chave com o mesmo payload devolve o saldo gravado naquela hora. Outro payload na mesma chave responde 409. A unicidade de `(provider, externalTransactionId)` também é do banco.

Na fila, a inbox `(consumer_name, message_id)` entra na mesma transação do saldo. Ack só depois do commit. Um redelivery encontra a inbox processada e não debita de novo.

## Referência

`WIN` pode apontar para uma `BET`. `REFUND` só reverte uma `BET` processada, com o mesmo valor. `ROLLBACK` reverte `BET`, `WIN` ou `REFUND` e lança o movimento inverso. A referência tem de ser do mesmo provedor, jogador, carteira, moeda e rodada. Cada tipo só reverte a mesma referência uma vez. Um rollback que deixaria o saldo negativo é `REVERSAL_WOULD_OVERDRAW`, distinto de `INSUFFICIENT_FUNDS`.

Se a referência ainda não existe, a transação fica `PENDING_REFERENCE` e responde 202. O worker tenta de novo com backoff de 2, 4, 8… até 60 segundos. Desiste aos 10 attempts ou aos 15 minutos, o que vier primeiro, e rejeita com `REFERENCE_NOT_FOUND`. Dez tentativas cobrem uma aposta atrasada alguns minutos. Os quinze minutos limitam uma linha esquecida se o relógio do worker escorregar.

## Outbox e fila

O evento é gravado no mesmo commit do saldo. O publicador trava a linha com `FOR UPDATE SKIP LOCKED`, envia para `wager-events.fifo` e só então marca `published_at`. Se o processo morre entre o envio e o commit, outro publicador envia de novo. O `MessageDeduplicationId` é o id do evento, então a fila FIFO absorve a repetição por cinco minutos e o id segue no payload para quem quiser deduplicar além disso.

O consumidor da `wager-transactions.fifo` chama o mesmo caso de uso do HTTP. Rejeição de negócio dá ack. Payload inválido vai para a DLQ na hora. Erro transitório (carteira ainda inexistente, deadlock, falha de conexão) devolve a mensagem com backoff. Na quinta leitura, a DLQ. No `SIGTERM`, o processo para de receber, espera o que está em curso e zera a visibilidade do que não terminou. Uma entrega que ainda não acabou quando a espera estoura volta para a fila e não recebe ack.

## Falhas

| Código | Quando |
| --- | --- |
| `INSUFFICIENT_FUNDS` | aposta sem saldo |
| `REVERSAL_WOULD_OVERDRAW` | rollback deixaria o saldo negativo |
| `CURRENCY_MISMATCH` | moeda diferente da carteira |
| `PLAYER_WALLET_MISMATCH` | jogador não é o dono da carteira |
| `REFERENCE_KIND_NOT_ALLOWED` | tipo de referência incompatível, ou referência rejeitada |
| `REFERENCE_SCOPE_MISMATCH` | outro jogador, carteira, rodada ou moeda |
| `AMOUNT_MISMATCH` | estorno ou rollback com valor diferente |
| `ALREADY_REVERSED` | a mesma referência já foi revertida por aquele tipo |
| `REFERENCE_NOT_FOUND` | a espera da referência esgotou |

`WALLET_NOT_FOUND` existe na taxonomia, mas a carteira ausente não vira linha: a chave estrangeira exige a carteira. No HTTP isso é 404. Na fila, a mensagem volta até a DLQ, porque a carteira pode ser criada logo em seguida.

## Auth

O IdP é o Zitadel do Compose, na porta 8081, com o Postgres que o projeto já sobe. O `AuthGuard` valida o access token nas chaves públicas de `http://localhost:8081/oauth/v2/keys`. Health fica aberto. O resto da API exige `Authorization: Bearer`. O token do roteiro sai de `bun run token`, assinado com a chave da conta de serviço `wagering-api`. Mensagem da fila continua canal interno e não carrega token; o `providerId` do corpo segue sujeito às regras da carteira.

## Limites

Não há estorno parcial. `REFUND` e `ROLLBACK` da mesma aposta são operações diferentes e as duas podem ser aplicadas. A publicação é at-least-once. O OpenTelemetry escreve o trace de `wager.submit`, `wager.consume` e `outbox.publish` no stdout do processo. Não há collector nem dashboard. O teste de carga é `bun run test:load` e o registro fica em `documentacao/carga.md`: um processo, várias transações ao mesmo tempo, Postgres e LocalStack na mesma máquina. Não mede HTTP nem várias instâncias. A reconciliação aponta divergência, soma `wallet_reconciliation_divergences_total` e não corrige sozinha.
