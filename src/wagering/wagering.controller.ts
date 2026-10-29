import { Body, Controller, Get, Headers, Param, Post, Res } from '@nestjs/common';
import { WageringService } from './wagering.service';

@Controller()
export class WageringController {
  constructor(private readonly wagering: WageringService) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { status(code: number): void },
  ) {
    const result = await this.wagering.submit(idempotencyKey, body, correlationId);
    response.status(result.statusCode);
    return result.body;
  }

  @Get('wagering/transactions/:transactionId')
  getById(@Param('transactionId') transactionId: string) {
    return this.wagering.getById(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getByExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.wagering.getByExternal(providerId, externalTransactionId);
  }
}
