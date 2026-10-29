import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from './config';
import { InfrastructureFilter } from './http-errors';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new InfrastructureFilter());
  app.enableShutdownHooks();
  await app.listen(config.port);
}

void bootstrap();
