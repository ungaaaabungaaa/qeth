#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { scanDocuments, type RagReport } from './rag.ts';
import { analyzeTrace, type TraceReport } from './trace.ts';
import { planMission, type MissionReport, type MissionOptions } from './mission.ts';
import { crawlSite, type CrawlReport } from './crawl.ts';
import { readJsonInput, writeNewJson } from './io.ts';
import { QethError } from './errors.ts';
import { VERSION } from './version.ts';

const HELP = `Qeth ${VERSION} — local inspection and offline planning

Usage:
  qeth rag scan PATH [--chunk-size 1000]
  qeth trace FILE [--baseline FILE] [--timeline-limit 100]
  qeth crawl URL [--max-pages 10] [--max-depth 2] [--timeout 10000]
                  [--delay 250] [--allow-local]
  qeth mission plan FILE [--spacing 20] [--speed 5] [--altitude 30]
                         [--battery-minutes 25] [--reserve 20]
                         [--optimize battery|distance]
  qeth doctor

Options:
  --json             Print a measured JSON report
  --out FILE         Write JSON to a new file; refuse overwrite
  --help, -h         Show this help
  --version, -v      Print the package version

Exit codes: 0 completed, 2 invalid input, 1 runtime failure.
No account, API key, or model required. Mission routes are offline estimates.
Reference: https://github.com/ungaaaabungaaa/qeth
`;
const optionDefinitions = {
  help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' }, out: { type: 'string' },
  'chunk-size': { type: 'string' }, baseline: { type: 'string' }, 'timeline-limit': { type: 'string' },
  'max-pages': { type: 'string' }, 'max-depth': { type: 'string' }, timeout: { type: 'string' }, delay: { type: 'string' }, 'allow-local': { type: 'boolean' },
  spacing: { type: 'string' }, speed: { type: 'string' }, altitude: { type: 'string' }, 'battery-minutes': { type: 'string' }, reserve: { type: 'string' }, optimize: { type: 'string' }
} as const;
type Values = ReturnType<typeof parseArgs<{ options: typeof optionDefinitions }>>['values'];
type Report = RagReport | TraceReport | MissionReport | CrawlReport | {
  schemaVersion: 1; kind: 'doctor'; version: string; node: string; platform: string; architecture: string; basicCommandsNeedAccount: false;
};

function commandFor(parts: string[]): { kind: 'rag' | 'trace' | 'crawl' | 'mission' | 'doctor'; input: string } {
  if (parts[0] === 'rag' && parts[1] === 'scan' && parts.length === 3) return { kind: 'rag', input: parts[2]! };
  if (parts[0] === 'mission' && parts[1] === 'plan' && parts.length === 3) return { kind: 'mission', input: parts[2]! };
  if ((parts[0] === 'trace' || parts[0] === 'crawl') && parts.length === 2) return { kind: parts[0], input: parts[1]! };
  if (parts[0] === 'doctor' && parts.length === 1) return { kind: 'doctor', input: '' };
  throw new QethError('Unknown or incomplete command. Run qeth --help.');
}

function numeric(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!value.trim() || !Number.isFinite(Number(value))) throw new QethError(`${name} must be a finite number.`);
  return Number(value);
}

function allowedOptions(kind: string, values: Values): void {
  const specific: Record<string, string[]> = { rag: ['chunk-size'], trace: ['baseline', 'timeline-limit'], crawl: ['max-pages', 'max-depth', 'timeout', 'delay', 'allow-local'], mission: ['spacing', 'speed', 'altitude', 'battery-minutes', 'reserve', 'optimize'], doctor: [] };
  const allowed = new Set(['help', 'json', 'out', ...specific[kind]!]);
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new QethError(`--${key} is not an option for ${kind}.`);
}

async function reportFor(kind: string, input: string, values: Values): Promise<Report> {
  if (kind === 'rag') return scanDocuments(input, values['chunk-size'] === undefined ? {} : { chunkSize: numeric(values['chunk-size'], 'chunk-size')! });
  if (kind === 'trace') return analyzeTrace(await readJsonInput(input), values.baseline === undefined ? undefined : await readJsonInput(values.baseline),
    values['timeline-limit'] === undefined ? {} : { timelineLimit: numeric(values['timeline-limit'], 'timeline-limit')! });
  if (kind === 'crawl') {
    const options = {
      ...(values['max-pages'] === undefined ? {} : { maxPages: numeric(values['max-pages'], 'max-pages')! }),
      ...(values['max-depth'] === undefined ? {} : { maxDepth: numeric(values['max-depth'], 'max-depth')! }),
      ...(values.timeout === undefined ? {} : { timeoutMs: numeric(values.timeout, 'timeout')! }),
      ...(values.delay === undefined ? {} : { delayMs: numeric(values.delay, 'delay')! }),
      ...(values['allow-local'] === undefined ? {} : { allowLocal: values['allow-local'] })
    };
    return crawlSite(input, options);
  }
  if (kind === 'mission') {
    const options: MissionOptions = {};
    const numbers = { spacing: 'spacingM', speed: 'speedMps', altitude: 'altitudeM', 'battery-minutes': 'batteryMinutes', reserve: 'reservePercent' } as const;
    for (const [flag, field] of Object.entries(numbers)) {
      const value = values[flag as keyof typeof numbers];
      if (value !== undefined) options[field] = numeric(value, flag)!;
    }
    if (values.optimize !== undefined) {
      if (values.optimize !== 'battery' && values.optimize !== 'distance') throw new QethError('optimize must be battery or distance.');
      options.optimize = values.optimize;
    }
    return planMission(await readJsonInput(input), options);
  }
  return { schemaVersion: 1, kind: 'doctor', version: VERSION, node: process.versions.node, platform: process.platform, architecture: process.arch, basicCommandsNeedAccount: false };
}

function human(report: Report): string {
  if (report.kind === 'rag-scan') return `RAG scan\nFiles: ${report.fileCount}\nChunks: ${report.chunkCount}\nDuplicate content groups: ${report.duplicateGroups.length}\nDuplicate IDs: ${report.duplicateIds.length}\nMissing metadata: ${report.missingMetadata.length}\nInvalid records: ${report.invalidRecords.length}\nEmbeddings supplied: ${report.embedding.provided}; missing: ${report.embedding.missing}\nInvalid embeddings: ${report.embedding.invalid.length}; dimension mismatches: ${report.embedding.dimensionMismatches.length}`;
  if (report.kind === 'trace') {
    let result = `Agent trace\nEvents: ${report.eventCount}; failed: ${report.failedCount}\nElapsed time: ${report.wallTimeMs} ms; summed event time: ${report.totalEventTimeMs} ms\nKnown tokens: ${report.tokens.total}; events without token data: ${report.tokens.missingEvents}\nToken totals complete: ${report.tokens.complete ? 'yes' : 'no'}`;
    if (report.comparison) {
      const { totalTokenDelta: delta, percentChange: percent } = report.comparison;
      if (delta === null) result += '\nBaseline comparison: unavailable (token data is incomplete)';
      else result += `\nBaseline token change: ${delta >= 0 ? '+' : ''}${delta}` +
        (percent === null ? ' (percent unknown: zero-token baseline)' : ` (${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%)`);
    }
    if (report.timeline) result += `\nTimeline: ${report.timeline.events.length} included; ${report.timeline.omittedEvents} omitted (use --json or --out for events)`;
    return result;
  }
  if (report.kind === 'crawl') return `Site crawl\nPages: ${report.pages.length}\nLinks: ${report.links.length}\nSkipped requests: ${report.skipped.length}`;
  if (report.kind === 'mission-plan') return `Offline mission plan\nWaypoints: ${report.waypoints.length}\nDistance: ${report.distanceM.toFixed(1)} m\nEstimated time: ${report.estimatedSeconds.toFixed(1)} s\nEstimated battery: ${report.estimatedBatteryPercent.toFixed(1)}%\nWithin assumed battery budget: ${report.withinBatteryBudget ? 'yes' : 'no'}`;
  return `Qeth ${report.version}\nNode: ${report.node}\nPlatform: ${report.platform} ${report.architecture}\nBasic commands need no account or model.`;
}

async function main(): Promise<void> {
  let parsed;
  try { parsed = parseArgs({ args: process.argv.slice(2), options: optionDefinitions, allowPositionals: true, strict: true }); }
  catch (error) { throw new QethError(error instanceof Error ? error.message : 'Invalid command options.'); }
  const { values, positionals } = parsed;
  if (values.version && positionals.length === 0) { process.stdout.write(VERSION + '\n'); return; }
  if (positionals.length === 0 && (values.help || process.argv.length === 2)) { process.stdout.write(HELP); return; }
  if (values.help) {
    const prefix = positionals.join(' ');
    if (!['rag', 'rag scan', 'trace', 'crawl', 'mission', 'mission plan', 'doctor'].includes(prefix)) commandFor(positionals);
    allowedOptions(positionals[0]!, values);
    process.stdout.write(HELP); return;
  }
  const { kind, input } = commandFor(positionals);
  allowedOptions(kind, values);
  const report = await reportFor(kind, input, values);
  const json = values.json || values.out !== undefined ? JSON.stringify(report, null, 2) + '\n' : undefined;
  if (values.out !== undefined) await writeNewJson(values.out, json!);
  process.stdout.write(values.json ? json! : human(report) + '\n');
  if (!values.json && 'warnings' in report) for (const warning of report.warnings) process.stderr.write(`Note: ${warning}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unexpected runtime failure.';
  process.stderr.write(`qeth: ${message.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}\n`);
  process.exitCode = error instanceof QethError ? error.exitCode : 1;
});
