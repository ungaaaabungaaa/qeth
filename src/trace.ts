import { QethError } from './errors.ts';

interface TraceEvent {
  id?: string; name: string; kind?: string; startMs: number; endMs: number;
  status: 'ok' | 'error'; tokens?: { input: number; output: number };
}
export interface TraceOptions { timelineLimit?: number }
export interface TraceReport {
  schemaVersion: 1; kind: 'trace'; eventCount: number; failedCount: number;
  wallTimeMs: number; totalEventTimeMs: number;
  failures: { name: string; id: string | null }[];
  tools: { name: string; count: number }[];
  tokens: { input: number; output: number; total: number; measuredEvents: number; missingEvents: number; complete: boolean };
  comparison: { totalTokenDelta: number | null; percentChange: number | null } | null;
  timeline?: { events: { id: string | null; name: string; kind: string | null;
    startMs: number; endMs: number; durationMs: number; status: 'ok' | 'error' }[]; omittedEvents: number };
}
function parseTrace(input: unknown): TraceEvent[] {
  if (!input || typeof input !== 'object' || !('events' in input) || !Array.isArray(input.events)) throw new QethError('Trace must contain an events array.');
  if (input.events.length > 100000) throw new QethError('Trace may contain at most 100000 events.');
  const ids = new Set<string>();
  for (const [index, value] of input.events.entries()) {
    const fail = (reason: string): never => { throw new QethError(`Invalid trace event ${index + 1}: ${reason}`); };
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected an object.');
    const event = value as Record<string, unknown>;
    if (typeof event.name !== 'string' || !event.name.trim()) fail('name must be nonempty.');
    if (event.status !== 'ok' && event.status !== 'error') fail('status must be ok or error.');
    if (typeof event.startMs !== 'number' || !Number.isFinite(event.startMs) || event.startMs < 0 ||
      typeof event.endMs !== 'number' || !Number.isFinite(event.endMs) || event.endMs < event.startMs) fail('timestamps must be finite, nonnegative, and ordered.');
    if (event.kind !== undefined && (typeof event.kind !== 'string' || !event.kind.trim())) fail('kind must be a nonempty string.');
    if (event.id !== undefined) {
      if (typeof event.id !== 'string' || !event.id.trim()) fail('id must be a nonempty string.');
      const id = event.id as string;
      if (ids.has(id)) fail('event ids must be unique.');
      ids.add(id);
    }
    if (event.tokens !== undefined) {
      if (!event.tokens || typeof event.tokens !== 'object' || Array.isArray(event.tokens)) fail('tokens must be an object.');
      const tokens = event.tokens as Record<string, unknown>;
      if (!Number.isSafeInteger(tokens.input) || (tokens.input as number) < 0 ||
        !Number.isSafeInteger(tokens.output) || (tokens.output as number) < 0) fail('tokens need nonnegative safe integer input and output values.');
    }
  }
  return input.events as TraceEvent[];
}
function summarize(events: TraceEvent[]): TraceReport {
  const counts = new Map<string, number>();
  const tokens = { input: 0, output: 0, total: 0, measuredEvents: 0, missingEvents: 0, complete: true };
  let first = Infinity, last = -Infinity, totalEventTimeMs = 0;
  const failures: TraceReport['failures'] = [];
  for (const event of events) {
    first = Math.min(first, event.startMs);
    last = Math.max(last, event.endMs);
    totalEventTimeMs += event.endMs - event.startMs;
    counts.set(event.name, (counts.get(event.name) ?? 0) + 1);
    if (event.status === 'error') failures.push({ name: event.name, id: event.id ?? null });
    if (event.tokens) {
      tokens.input += event.tokens.input; tokens.output += event.tokens.output; tokens.measuredEvents++;
    } else tokens.missingEvents++;
  }
  tokens.total = tokens.input + tokens.output;
  if (!Number.isSafeInteger(tokens.total) || !Number.isFinite(totalEventTimeMs)) throw new QethError('Trace totals exceed the supported numeric range.');
  tokens.complete = tokens.missingEvents === 0;
  return { schemaVersion: 1, kind: 'trace', eventCount: events.length, failedCount: failures.length,
    wallTimeMs: events.length ? last - first : 0, totalEventTimeMs, failures,
    tools: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, count })), tokens, comparison: null };
}
export function analyzeTrace(input: unknown, baseline?: unknown, options: TraceOptions = {}): TraceReport {
  const limit = options.timelineLimit;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) throw new QethError('timelineLimit must be an integer from 1 through 1000.');
  const events = parseTrace(input);
  const report = summarize(events);
  if (limit !== undefined) {
    const timeline = [...events].sort((a, b) => a.startMs - b.startMs).slice(0, limit);
    report.timeline = { events: timeline.map(event => ({ id: event.id ?? null, name: event.name,
      kind: event.kind ?? null, startMs: event.startMs, endMs: event.endMs,
      durationMs: event.endMs - event.startMs, status: event.status })), omittedEvents: events.length - timeline.length };
  }
  if (baseline !== undefined) {
    const previous = summarize(parseTrace(baseline));
    const measured = report.tokens.complete && previous.tokens.complete;
    const delta = measured ? report.tokens.total - previous.tokens.total : null;
    report.comparison = { totalTokenDelta: delta,
      percentChange: delta !== null && previous.tokens.total > 0 ? delta / previous.tokens.total * 100 : null };
  }
  return report;
}
