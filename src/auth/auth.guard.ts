import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config';

const keys = createRemoteJWKSet(new URL(config.oidc.jwksUrl));

type Incoming = {
  url?: string;
  originalUrl?: string;
  headers?: { authorization?: string };
};

@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Incoming>();
    const path = (request.originalUrl ?? request.url ?? '').split('?')[0];
    if (path === '/health/live' || path === '/health/ready') return true;

    const header = request.headers?.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
    try {
      await jwtVerify(header.slice('Bearer '.length), keys, { issuer: config.oidc.issuer });
    } catch {
      throw new UnauthorizedException();
    }
    return true;
  }
}
