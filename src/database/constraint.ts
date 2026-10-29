export function constraintOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as { constraint?: unknown; message?: unknown };
  if (typeof record.constraint === 'string') return record.constraint;
  if (typeof record.message === 'string') {
    return record.message.match(/constraint "([^"]+)"/)?.[1];
  }
  return undefined;
}
