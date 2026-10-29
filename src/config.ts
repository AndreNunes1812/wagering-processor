function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value == null || value === '' ? fallback : value;
}

export const config = {
  port: Number(env('PORT', '3000')),
  database: {
    host: env('DB_HOST', 'localhost'),
    port: Number(env('DB_PORT', '5434')),
    user: env('DB_USER', 'wagering'),
    password: env('DB_PASSWORD', 'wagering'),
    name: env('DB_NAME', 'wagering'),
  },
  sqs: {
    region: env('AWS_REGION', 'us-east-1'),
    endpoint: env('SQS_ENDPOINT', 'http://localhost:4566'),
    accessKeyId: env('AWS_ACCESS_KEY_ID', 'test'),
    secretAccessKey: env('AWS_SECRET_ACCESS_KEY', 'test'),
    wagerQueueUrl: env(
      'WAGER_QUEUE_URL',
      'http://localhost:4566/000000000000/wager-transactions.fifo',
    ),
    eventsQueueUrl: env(
      'EVENTS_QUEUE_URL',
      'http://localhost:4566/000000000000/wager-events.fifo',
    ),
    dlqQueueUrl: env(
      'DLQ_QUEUE_URL',
      'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
    ),
  },
};
