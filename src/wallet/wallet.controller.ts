import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { WalletService } from './wallet.service';

@Controller('wallets')
export class WalletController {
  constructor(private readonly wallets: WalletService) {}

  @Post()
  async open(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: { status(code: number): void },
  ) {
    const result = await this.wallets.open(body, correlationId);
    response.status(result.statusCode);
    return result.body;
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.wallets.get(walletId);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.wallets.ledger(walletId, cursor, limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(
    @Param('walletId') walletId: string,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
    return this.wallets.reconcile(walletId, correlationId);
  }
}
