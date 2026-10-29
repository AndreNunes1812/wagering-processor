import { trace } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

export function startTelemetry(): void {
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'wagering-processor' }),
    spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
  });
  trace.setGlobalTracerProvider(provider);
}
