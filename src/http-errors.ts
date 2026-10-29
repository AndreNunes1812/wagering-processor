import { ConnectionException, DeadlockException } from '@mikro-orm/core';
import { ArgumentsHost, Catch, ExceptionFilter, ServiceUnavailableException } from '@nestjs/common';

@Catch(DeadlockException, ConnectionException)
export class InfrastructureFilter implements ExceptionFilter {
  catch(_error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{ status(code: number): { json(body: unknown): void } }>();
    const exception = new ServiceUnavailableException();
    const body = exception.getResponse();
    response.status(exception.getStatus()).json(body);
  }
}
