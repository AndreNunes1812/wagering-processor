import { Controller, Get, Global, Header, Module } from '@nestjs/common';
import { Metrics } from './metrics';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: Metrics) {}

  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  render(): string {
    return this.metrics.render();
  }
}

@Global()
@Module({
  controllers: [MetricsController],
  providers: [Metrics],
  exports: [Metrics],
})
export class MetricsModule {}
