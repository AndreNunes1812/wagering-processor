import { SpanStatusCode, trace } from '@opentelemetry/api';

const tracer = trace.getTracer('wagering-processor');

export async function traced<T>(
  name: string,
  attributes: Record<string, string>,
  run: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await run();
      span.end();
      return result;
    } catch (error) {
      if (error instanceof Error) span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      throw error;
    }
  });
}
