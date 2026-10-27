import test from 'node:test';
import assert from 'node:assert/strict';
import dns, { Resolver } from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { CrawlNetwork } from '../src/network.ts';
import { crawlSite } from '../src/crawl.ts';

test('DNS timeout cancels pending resolver work instead of leaving a process handle', async t => {
  const rejectQueries = [];
  let cancelled = false;
  t.mock.method(dns, 'lookup', () => new Promise(() => {}));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(Resolver.prototype, 'resolve4', () => new Promise((_resolve, reject) => rejectQueries.push(reject)));
  t.mock.method(Resolver.prototype, 'resolve6', () => new Promise((_resolve, reject) => rejectQueries.push(reject)));
  t.mock.method(Resolver.prototype, 'cancel', () => {
    cancelled = true;
    for (const reject of rejectQueries) reject(new Error('cancelled'));
  });
  const client = new CrawlNetwork({ origin: 'http://example.invalid', allowLocal: false, timeoutMs: 100, delayMs: 0, deadline: Date.now() + 1000 });
  await assert.rejects(client.get(new URL('http://example.invalid/')), /DNS lookup timed out/);
  assert.equal(cancelled, true);
});

test('expired global deadline prevents DNS and HTTP work', async () => {
  const client = new CrawlNetwork({ origin: 'http://127.0.0.1', allowLocal: true, timeoutMs: 100, delayMs: 0, deadline: Date.now() - 1 });
  await assert.rejects(client.get(new URL('http://127.0.0.1/')), /deadline/);
});

test('mixed public and private DNS answers fail closed before connecting', async t => {
  t.mock.method(Resolver.prototype, 'resolve4', async () => ['8.8.8.8', '127.0.0.1']);
  t.mock.method(Resolver.prototype, 'resolve6', async () => []);
  const client = new CrawlNetwork({ origin: 'http://example.invalid', allowLocal: false, timeoutMs: 100, delayMs: 0, deadline: Date.now() + 1000 });
  await assert.rejects(client.get(new URL('http://example.invalid/')), /blocked/);
});

test('validated DNS results are pinned to the connection and retain the requested host', async t => {
  const hosts = [];
  const server = createServer((req, res) => { hosts.push(req.headers.host); res.end('pinned'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  t.mock.method(Resolver.prototype, 'resolve4', async () => ['127.0.0.1']);
  t.mock.method(Resolver.prototype, 'resolve6', async () => []);
  const origin = `http://fixture.invalid:${server.address().port}`;
  const client = new CrawlNetwork({ origin, allowLocal: true, timeoutMs: 1000, delayMs: 0, deadline: Date.now() + 2000 });
  const result = await client.get(new URL(origin));
  assert.equal(result.body, 'pinned');
  assert.deepEqual(hosts, [new URL(origin).host]);
});

test('unexpected DNS failure is not ignored when another answer family succeeds', async t => {
  t.mock.method(Resolver.prototype, 'resolve4', async () => { throw Object.assign(new Error('resolver failure'), { code: 'ESERVFAIL' }); });
  t.mock.method(Resolver.prototype, 'resolve6', async () => ['2001:4860:4860::8888']);
  const client = new CrawlNetwork({ origin: 'http://example.invalid', allowLocal: false, timeoutMs: 100, delayMs: 0, deadline: Date.now() + 1000 });
  await assert.rejects(client.get(new URL('http://example.invalid/')), error => error.exitCode === 1 && /DNS/.test(error.message));
});

test('request pacing remains effective after a slow first DNS resolution', async t => {
  const starts = [];
  const server = createServer((_req, res) => { starts.push(Date.now()); res.end('paced'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  let resolutions = 0;
  t.mock.method(Resolver.prototype, 'resolve4', async () => {
    if (++resolutions === 1) await delay(180);
    return ['127.0.0.1'];
  });
  t.mock.method(Resolver.prototype, 'resolve6', async () => []);
  const origin = `http://fixture.invalid:${server.address().port}`;
  const client = new CrawlNetwork({ origin, allowLocal: true, timeoutMs: 1000, delayMs: 100, deadline: Date.now() + 3000 });
  await client.get(new URL(origin));
  await client.get(new URL(origin));
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 90, `HTTP requests were ${starts[1] - starts[0]} ms apart`);
});

test('exhausted redirect page budget prevents the next DNS lookup', async t => {
  const paths = [];
  const server = createServer((req, res) => {
    paths.push(req.url);
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.writeHead(302, { location: '/next' }); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  let lookups = 0;
  t.mock.method(Resolver.prototype, 'resolve4', async () => { lookups++; return ['127.0.0.1']; });
  t.mock.method(Resolver.prototype, 'resolve6', async () => []);
  const origin = `http://fixture.invalid:${server.address().port}`;
  await crawlSite(origin, { allowLocal: true, delayMs: 0, maxPages: 1 });
  assert.equal(lookups, 2);
  assert.deepEqual(paths, ['/robots.txt', '/']);
});
