import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { MikroORM } from '@mikro-orm/core';
import config from '../database/mikro-orm.config';
import { WageringService } from './wagering.service';

async function main(): Promise<void> {
  const payload = JSON.parse(process.argv[2] ?? '');
  const target = process.argv[3];
  if (!target) throw new Error('missing output path');
  const orm = await MikroORM.init({ ...config, allowGlobalContext: true });
  try {
    await orm.connect();
    const wagering = new WageringService(orm.em);
    const result = await wagering.submit(payload.idempotencyKey, payload.body);
    writeFileSync(target, JSON.stringify({ statusCode: result.statusCode, body: result.body }));
  } finally {
    await orm.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
