import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';
import { QethError } from './errors.ts';
import { CrawlNetwork, crawlUrl } from './network.ts';
import { robotsPolicy } from './robots.ts';

export interface CrawlOptions { maxPages?: number; maxDepth?: number; timeoutMs?: number; delayMs?: number; allowLocal?: boolean }
export interface CrawlReport {
  schemaVersion: 1; kind: 'crawl'; root: string;
  pages: { url: string; title: string; text: string; contentHash: string; depth: number }[];
  links: { from: string; to: string }[]; skipped: { url: string; reason: string }[]; warnings: string[];
}
function numberOption(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isInteger(result) || result < min || result > max) throw new QethError(`${name} must be an integer from ${min} to ${max}.`);
  return result;
}
function htmlData(html: string): { title: string; text: string; links: string[]; baseHref: string | null } {
  let ignored = 0, inTitle = false, title = '', text = '';
  let baseHref: string | null = null;
  const links: string[] = [];
  const skip = new Set(['script', 'style', 'noscript', 'svg', 'template']);
  const parser = new Parser({
    onopentag(name, attrs) {
      if (skip.has(name)) ignored++;
      if (name === 'title') inTitle = true;
      if (!ignored && name === 'base' && baseHref === null && attrs.href !== undefined) baseHref = attrs.href;
      if (!ignored && name === 'a' && attrs.href) links.push(attrs.href);
      if (!ignored) text += ' ';
    },
    ontext(value) { if (!ignored) { text += value; if (inTitle) title += value; } },
    onclosetag(name) { if (skip.has(name)) ignored = Math.max(0, ignored - 1); if (name === 'title') inTitle = false; if (!ignored) text += ' '; }
  }, { decodeEntities: true });
  parser.end(html);
  const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
  return { title: clean(title), text: clean(text), links, baseHref };
}
function documentBase(href: string | null, documentUrl: URL, warnings: string[]): URL | undefined {
  if (href === null) return documentUrl;
  if (href.length > 8192) { warnings.push('Document base exceeds the URL limit; only absolute links are considered.'); return undefined; }
  try {
    const base = new URL(href, documentUrl);
    if (base.protocol === 'data:' || base.protocol === 'javascript:') return documentUrl;
    if (base.href.length > 8192) { warnings.push('Document base exceeds the URL limit; only absolute links are considered.'); return undefined; }
    return base;
  } catch { warnings.push('Invalid document base; relative links use the document URL.'); return documentUrl; }
}
export async function crawlSite(value: string, options: CrawlOptions = {}): Promise<CrawlReport> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new QethError('Crawler options must be an object.');
  if (options.allowLocal !== undefined && typeof options.allowLocal !== 'boolean') throw new QethError('allowLocal must be a boolean.');
  const root = crawlUrl(value);
  const maxPages = numberOption(options.maxPages, 10, 1, 100, 'max-pages');
  const maxDepth = numberOption(options.maxDepth, 2, 0, 10, 'max-depth');
  const timeoutMs = numberOption(options.timeoutMs, 10000, 100, 60000, 'timeout');
  const delayMs = numberOption(options.delayMs, 250, 0, 10000, 'delay');
  const network = new CrawlNetwork({ origin: root.origin, allowLocal: options.allowLocal === true, timeoutMs, delayMs, deadline: Date.now() + 120000 });
  const report: CrawlReport = { schemaVersion: 1, kind: 'crawl', root: root.href, pages: [], links: [], skipped: [], warnings: [] };
  let policy = robotsPolicy('');
  try {
    const robots = await network.get(new URL('/robots.txt', root));
    if (robots.status === 401 || robots.status === 403) { report.skipped.push({ url: root.href, reason: 'robots.txt denies access.' }); return report; }
    if (robots.status === 200) policy = robotsPolicy(robots.body);
    else if (robots.status !== 404) throw new QethError(`robots.txt returned HTTP ${robots.status}; crawl stopped.`, 1);
  } catch (error) { if (error instanceof QethError) throw error; throw new QethError('Could not retrieve robots.txt; crawl stopped.', 1); }
  if (!Number.isFinite(policy.delayMs) || policy.delayMs >= 120000) throw new QethError('robots.txt crawl delay exceeds the crawl deadline.', 1);
  network.options.delayMs = Math.max(delayMs, policy.delayMs);
  const queue = [{ url: root, depth: 0 }];
  const seen = new Set([root.href]);
  const discovered = new Set([root.href]);
  const collected = new Set<string>();
  const edges = new Set<string>();
  const variants = new Map<string, Set<string>>();
  const rejectedVariants = new Set<string>();
  function remember(url: URL, required = false): boolean {
    if (discovered.has(url.href)) return true;
    if (discovered.size >= 1000) {
      if (!report.warnings.includes('URL discovery limit reached.')) report.warnings.push('URL discovery limit reached.');
      if (required) throw new QethError('URL discovery limit reached before redirect request.', 1);
      return false;
    }
    discovered.add(url.href); return true;
  }
  let pageRequests = 0;
  function admit(url: URL): boolean {
    remember(url, true);
    if (!policy.allowed(url)) return false;
    if (pageRequests >= maxPages) {
      if (!report.warnings.includes('Page request budget reached.')) report.warnings.push('Page request budget reached.');
      throw new QethError('Page request budget reached before request.', 1);
    }
    const key = url.origin + url.pathname;
    const group = variants.get(key) ?? new Set<string>();
    if (!group.has(url.href) && group.size >= 4) throw new QethError('Query variant limit reached before request.', 1);
    group.add(url.href); variants.set(key, group);
    pageRequests++;
    return true;
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]!;
    if (collected.has(current.url.href)) continue;
    if (pageRequests >= maxPages) {
      if (!report.warnings.includes('Page request budget reached.')) report.warnings.push('Page request budget reached.');
      break;
    }
    if (!policy.allowed(current.url)) { report.skipped.push({ url: current.url.href, reason: 'Disallowed by robots.txt.' }); continue; }
    if (Date.now() >= network.options.deadline) { report.warnings.push('Crawl reached its 120-second deadline.'); break; }
    try {
      const result = await network.get(current.url, admit);
      if (result.status < 200 || result.status >= 300) { report.skipped.push({ url: current.url.href, reason: `HTTP ${result.status}` }); continue; }
      if (!/^(text\/html|application\/xhtml\+xml)(\s*;|$)/i.test(result.headers['content-type'] ?? '')) { report.skipped.push({ url: result.url.href, reason: 'Not HTML.' }); continue; }
      const data = htmlData(result.body);
      if (!report.pages.some(page => page.url === result.url.href)) report.pages.push({ url: result.url.href, title: data.title, text: data.text, contentHash: createHash('sha256').update(data.text).digest('hex'), depth: current.depth });
      collected.add(current.url.href); collected.add(result.url.href);
      seen.add(result.url.href);
      const base = documentBase(data.baseHref, result.url, report.warnings);
      for (const href of data.links) {
        let next: URL;
        try { next = crawlUrl(href, base); } catch { continue; }
        if (next.origin !== root.origin) continue;
        if (!remember(next)) continue;
        const edge = `${result.url.href}\n${next.href}`;
        if (!edges.has(edge) && edges.size < 10000) { edges.add(edge); report.links.push({ from: result.url.href, to: next.href }); }
        if (seen.has(next.href) || current.depth >= maxDepth) continue;
        const key = next.origin + next.pathname;
        if ((variants.get(key)?.size ?? 0) >= 4 && !variants.get(key)?.has(next.href)) {
          if (!rejectedVariants.has(next.href)) { rejectedVariants.add(next.href); report.skipped.push({ url: next.href, reason: 'Query variant limit reached.' }); }
          continue;
        }
        seen.add(next.href); queue.push({ url: next, depth: current.depth + 1 });
      }
    } catch (error) { report.skipped.push({ url: current.url.href, reason: error instanceof Error ? error.message : 'Request failed.' }); }
  }
  return report;
}
