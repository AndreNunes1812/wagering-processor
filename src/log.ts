export function logInfo(event: string, fields: Record<string, string | number | boolean | undefined>): void {
  writeLog('info', event, fields);
}

export function logWarn(event: string, fields: Record<string, string | number | boolean | undefined>): void {
  writeLog('warn', event, fields);
}

function writeLog(
  level: 'info' | 'warn',
  event: string,
  fields: Record<string, string | number | boolean | undefined>,
): void {
  const payload: Record<string, unknown> = { level, event, time: new Date().toISOString() };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) payload[key] = value;
  }
  console.log(JSON.stringify(payload));
}
