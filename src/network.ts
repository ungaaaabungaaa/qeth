import { Resolver } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { setTimeout as delay } from 'node:timers/promises';
import { QethError } from './errors.ts';
import { VERSION } from './version.ts';

export interface HttpResult { url: URL; status: number; headers: http.IncomingHttpHeaders; body: string }
export interface NetworkOptions { origin: string; allowLocal: boolean; timeoutMs: number; delayMs: number; deadline: number }

export function crawlUrl(value: string, base?: URL): URL {
  if (typeof value !== 'string' || value.length > 8192) throw new QethError('URL must be a string of at most 8192 characters.');
  let url: URL;
  try { url = new URL(value, base); } catch { throw new QethError('Use a valid HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new QethError('Only HTTP(S) URLs without credentials are supported.');
  url.hash = '';
  if (url.href.length > 8192) throw new QethError('URL must be at most 8192 characters.');
  return url;
}

function publicAddress(address: string, allowLocal: boolean): boolean {
  try {
    const parsed = ipaddr.process(address);
    const range = parsed.range();
    return range === 'unicast' || (allowLocal && range === 'loopback');
  } catch { return false; }
}

async function addresses(host: string, allowLocal: boolean, timeout: number): Promise<{ address: string; family: number }[]> {
  const literal = host.replace(/^\[|\]$/g, '');
  let resolver: Resolver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let result: { address: string; family: number }[];
    if (isIP(literal)) result = [{ address: literal, family: isIP(literal) }];
    else if (literal.toLowerCase() === 'localhost') result = [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }];
    else {
      resolver = new Resolver({ timeout, tries: 1 });
      const queries = [resolver.resolve4(literal), resolver.resolve6(literal)];
      const answers = await Promise.race([
        Promise.allSettled(queries),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new QethError('DNS lookup timed out.', 1)); resolver?.cancel(); }, timeout); })
      ]);
      result = [];
      for (const [index, answer] of answers.entries()) {
        if (answer.status === 'fulfilled') result.push(...answer.value.map(address => ({ address, family: index ? 6 : 4 })));
        else if (!['ENODATA', 'ENOTFOUND'].includes((answer.reason as NodeJS.ErrnoException)?.code ?? '')) throw new QethError('DNS lookup failed; crawl stopped.', 1);
      }
    }
    if (!result.length || result.some(item => !publicAddress(item.address, allowLocal))) throw new QethError('Crawler destination includes a blocked non-public address. Use --allow-local only for loopback testing.');
    return result.sort((a, b) => a.family - b.family);
  } finally { if (timer) clearTimeout(timer); resolver?.cancel(); }
}

export class CrawlNetwork {
  readonly options: NetworkOptions;
  private lastCompleted = -Infinity;
  constructor(options: NetworkOptions) { this.options = options; }
  async get(start: URL, allowed: (url: URL) => boolean = () => true): Promise<HttpResult> {
    let url = start;
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (url.origin !== this.options.origin) throw new QethError('Cross-origin redirects are blocked.');
      if (!allowed(url)) throw new QethError('Redirect target disallowed by robots.txt.');
      const result = await this.request(url);
      if (![301, 302, 303, 307, 308].includes(result.status)) return result;
      if (!result.headers.location) throw new QethError('Redirect has no location.', 1);
      url = crawlUrl(result.headers.location, url);
    }
    throw new QethError('Redirect limit exceeded.', 1);
  }
  private async request(url: URL): Promise<HttpResult> {
    const waiting = Math.max(0, this.lastCompleted + this.options.delayMs - Date.now());
    if (Date.now() + waiting >= this.options.deadline) throw new QethError('Crawl reached its 120-second deadline.', 1);
    if (waiting) await delay(waiting);
    const timeout = Math.min(this.options.timeoutMs, this.options.deadline - Date.now());
    if (timeout <= 0) throw new QethError('Crawl reached its deadline.', 1);
    const requestDeadline = Date.now() + timeout;
    const resolved = await addresses(url.hostname, this.options.allowLocal, timeout);
    const destination = resolved[0]!;
    const remaining = Math.min(requestDeadline, this.options.deadline) - Date.now();
    if (remaining <= 0) throw new QethError('Crawl reached its deadline.', 1);
    const requestFn = url.protocol === 'https:' ? https.request : http.request;
    return new Promise<HttpResult>((resolve, reject) => {
      const req = requestFn({
        hostname: destination.address, family: destination.family, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search, method: 'GET', agent: false,
        ...(url.protocol === 'https:' && !isIP(url.hostname.replace(/^\[|\]$/g, '')) ? { servername: url.hostname } : {}),
        headers: { host: url.host, 'user-agent': `Qeth/${VERSION} (+https://github.com/ungaaaabungaaa/qeth)`, 'accept-encoding': 'identity', accept: 'text/html,text/plain;q=0.9' },
        signal: AbortSignal.timeout(remaining)
      }, res => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.once('error', reject);
        res.once('aborted', () => reject(new QethError('Response ended before its body completed.', 1)));
        const stop = (error: QethError): void => { reject(error); res.destroy(error); };
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { stop(new QethError('Compressed responses are not supported.', 1)); return; }
        if (Number(res.headers['content-length']) > 2 * 1024 * 1024) { stop(new QethError('Response exceeds the 2 MiB limit.', 1)); return; }
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) { stop(new QethError('Response exceeds the 2 MiB limit.', 1)); return; }
          chunks.push(chunk);
        });
        res.once('end', () => resolve({ url, status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.once('error', reject);
      req.end();
    }).finally(() => { this.lastCompleted = Date.now(); });
  }
}
