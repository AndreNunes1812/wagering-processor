import { expect, test } from 'bun:test';
import { nextStep } from './wagering.consumer';

test('a quinta leitura de um erro transitório vai para a DLQ', () => {
  expect(nextStep('retry', 4)).toBe('retry');
  expect(nextStep('retry', 5)).toBe('dlq');
  expect(nextStep('ack', 5)).toBe('ack');
  expect(nextStep('dlq', 1)).toBe('dlq');
});
