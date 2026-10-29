import { MikroORM } from '@mikro-orm/core';
import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SqsQueue } from '../messaging/sqs.client';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SqsQueue,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      if (!(await this.orm.isConnected())) {
        await this.orm.connect();
      }
      await this.orm.em.getConnection().execute('select 1');
      await this.sqs.ping();
      return { status: 'ok' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'readiness check failed';
      this.logger.warn(message);
      throw new ServiceUnavailableException();
    }
  }
}
