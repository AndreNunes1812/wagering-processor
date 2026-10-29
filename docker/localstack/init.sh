#!/bin/sh
set -eu

awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo --attributes FifoQueue=true
awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes FifoQueue=true
awslocal sqs create-queue --queue-name wager-events.fifo --attributes FifoQueue=true

DLQ_URL=$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --output text --query QueueUrl)
QUEUE_URL=$(awslocal sqs get-queue-url --queue-name wager-transactions.fifo --output text --query QueueUrl)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --output text --query Attributes.QueueArn)

awslocal sqs set-queue-attributes \
  --queue-url "$QUEUE_URL" \
  --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"
