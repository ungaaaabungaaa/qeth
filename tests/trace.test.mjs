import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrace } from '../src/trace.ts';

test('trace keeps concurrent duration and unmeasured tokens separate', () => {
  const report = analyzeTrace({ events: [
    { id: '1', name: 'web.search', startMs: 100, endMs: 400, status: 'ok', tokens: { input: 10, output: 5 } },
    { id: '2', name: 'vector.query', startMs: 200, endMs: 500, status: 'error' }
  ] }, { events: [] });
  assert.equal(report.eventCount, 2);
  assert.equal(report.failedCount, 1);
  assert.equal(report.wallTimeMs, 400);
  assert.equal(report.totalEventTimeMs, 600);
  assert.equal(report.tokens.total, 15);
  assert.equal(report.tokens.missingEvents, 1);
  assert.equal(report.tokens.complete, false);
  assert.equal(report.comparison.totalTokenDelta, null);
  assert.equal(report.comparison.percentChange, null);
});

test('trace compares only complete token totals and handles a zero baseline', () => {
  const event = { name: 'tool', startMs: 2, endMs: 6, status: 'ok', tokens: { input: 3, output: 1 } };
  const report = analyzeTrace({ events: [event, { ...event }] }, { events: [event] });
  assert.equal(report.comparison.totalTokenDelta, 4);
  assert.equal(report.comparison.percentChange, 100);
  const zero = analyzeTrace({ events: [event] }, { events: [] });
  assert.equal(zero.comparison.totalTokenDelta, 4);
  assert.equal(zero.comparison.percentChange, null);
  assert.equal(analyzeTrace({ events: [] }).wallTimeMs, 0);
  assert.throws(() => analyzeTrace({ events: [{ ...event, tokens: { input: Number.MAX_SAFE_INTEGER, output: 1 } }] }), /numeric range/);
  assert.throws(() => analyzeTrace(null), /events array/);
});

test('trace rejects invalid events before calculation', () => {
  const valid = { id: 'a', name: 'tool', startMs: 0, endMs: 2, status: 'ok' };
  for (const bad of [null, {}, { ...valid, name: '' }, { ...valid, startMs: -1 },
    { ...valid, endMs: NaN }, { ...valid, endMs: -1 }, { ...valid, status: 'success' },
    { ...valid, tokens: { input: -1, output: 2 } }, { ...valid, tokens: { input: 1.2, output: 2 } },
    { ...valid, tokens: { input: 1 } }, { ...valid, id: 4 }]) {
    assert.throws(() => analyzeTrace({ events: [bad] }), error => error.exitCode === 2);
  }
  assert.throws(() => analyzeTrace({ events: [valid, valid] }), /unique/);
  assert.throws(() => analyzeTrace({ events: Array(100001).fill(valid) }), /100000/);
});
