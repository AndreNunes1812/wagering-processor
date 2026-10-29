export function retryDelaySeconds(attempt: number): number {
  return Math.min(60, 2 ** Math.min(attempt, 6));
}
