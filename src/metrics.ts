const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

type Labels = Record<string, string>;

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly latency = new Map<string, { sum: number; count: number; buckets: number[] }>();

  transactions(status: string, kind: string): void {
    this.inc('wager_transactions_total', { status, kind });
  }

  duplicates(): void {
    this.inc('wager_duplicates_total', {});
  }

  retry(source: string): void {
    this.inc('wager_retries_total', { source });
  }

  dlq(): void {
    this.inc('wager_dlq_messages_total', {});
  }

  lockConflict(): void {
    this.inc('wager_lock_conflicts_total', {});
  }

  divergence(): void {
    this.inc('wallet_reconciliation_divergences_total', {});
  }

  outboxLag(seconds: number): void {
    this.gauges.set(this.key('outbox_lag_seconds', {}), seconds);
  }

  observe(seconds: number, labels: Labels = {}): void {
    const key = this.key('wager_processing_seconds', labels);
    const current = this.latency.get(key) ?? { sum: 0, count: 0, buckets: LATENCY_BUCKETS.map(() => 0) };
    current.sum += seconds;
    current.count += 1;
    LATENCY_BUCKETS.forEach((bucket, index) => {
      if (seconds <= bucket) current.buckets[index] += 1;
    });
    this.latency.set(key, current);
  }

  render(): string {
    const lines: string[] = [];
    for (const [key, value] of this.counters) lines.push(`${key} ${value}`);
    for (const [key, value] of this.gauges) lines.push(`${key} ${value}`);
    for (const [key, histogram] of this.latency) {
      const name = key.split('{')[0] ?? key;
      const labels = key.includes('{') ? key.slice(key.indexOf('{')) : '';
      const suffix = labels.endsWith('}') ? labels.slice(0, -1) : labels;
      LATENCY_BUCKETS.forEach((bucket, index) => {
        const le = suffix ? `${suffix},le="${bucket}"}` : `{le="${bucket}"}`;
        lines.push(`${name}_bucket${le} ${histogram.buckets[index] ?? 0}`);
      });
      const inf = suffix ? `${suffix},le="+Inf"}` : `{le="+Inf"}`;
      lines.push(`${name}_bucket${inf} ${histogram.count}`);
      lines.push(`${name}_sum${labels || ''} ${histogram.sum}`);
      lines.push(`${name}_count${labels || ''} ${histogram.count}`);
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }

  private inc(name: string, labels: Labels): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  private key(name: string, labels: Labels): string {
    const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return name;
    const body = entries.map(([label, value]) => `${label}="${value}"`).join(',');
    return `${name}{${body}}`;
  }
}
