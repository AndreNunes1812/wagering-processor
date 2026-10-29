import { expect, test } from 'bun:test';
import { payloadHash } from './payload-hash';

test('o hash ignora a ordem das chaves e pula campo vazio', () => {
  const left = payloadHash({ b: '2', a: { d: '4', c: '3' }, skip: undefined });
  const right = payloadHash({ a: { c: '3', d: '4' }, b: '2' });
  expect(left).toBe(right);
  expect(left).toHaveLength(64);
});
