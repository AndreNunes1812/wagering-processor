import { CanActivate, Injectable } from '@nestjs/common';

// Ponto de extensão do IdP. A checagem do token entra aqui; hoje a request segue.
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
