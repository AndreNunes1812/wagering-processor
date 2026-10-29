import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from '../config';

const issuer = config.oidc.issuer;
const keyPath = 'docker/zitadel/machine.json';
const patPath = 'docker/zitadel/admin.pat';

type MachineKey = { keyId: string; key: string; userId: string };

function signAssertion(machine: MachineKey, audience: string, now: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({ alg: 'RS256', kid: machine.keyId })}.${part({
    iss: machine.userId,
    sub: machine.userId,
    aud: audience,
    iat: now,
    exp: now + 60,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(machine.key).toString('base64url');
  return `${unsigned}.${signature}`;
}

async function preferJwt(pat: string, userId: string): Promise<void> {
  await fetch(`${issuer}/management/v1/users/${userId}/machine`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${pat}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'wagering-api',
      description: 'wagering-api',
      accessTokenType: 'ACCESS_TOKEN_TYPE_JWT',
    }),
  });
}

async function main(): Promise<void> {
  const machine = JSON.parse(readFileSync(keyPath, 'utf8')) as MachineKey;
  const pat = readFileSync(patPath, 'utf8').trim();
  await preferJwt(pat, machine.userId);
  const now = Math.floor(Date.now() / 1000);
  const assertion = signAssertion(machine, issuer, now);
  const response = await fetch(`${issuer}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      scope: 'openid',
      assertion,
    }),
  });
  const payload = (await response.json()) as { access_token?: string; error?: string };
  if (!response.ok || !payload.access_token?.startsWith('eyJ')) {
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
  process.stdout.write(payload.access_token);
}

main();
