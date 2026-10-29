import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/core';
import config from './mikro-orm.config';

async function main() {
  const orm = await MikroORM.init(config);
  if (process.argv[2] === 'down') {
    await orm.migrator.down();
  } else {
    await orm.migrator.up();
  }
  await orm.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
