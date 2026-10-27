import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { crawlSite } from '../src/crawl.ts';

async function fixture(t, handler) {
  const visits = [];
  const server = createServer((req, res) => {
    visits.push(req.url);
    handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}/`, visits };
}

test('crawler obeys robots and builds a real same-origin page graph', async t => {
  const { url, visits } = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') return res.end('User-agent: *\nDisallow: /private\nAllow: /private/public$\n');
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/' ? '<title>Root &amp; page</title><h1>Hello</h1><script>hidden-token</script><a href="/about">About</a><a href="/about#two">Repeat</a><a href="/private">Secret</a><a href="/private/public">Public</a><a href="https://example.com/off">Off-site</a>' : '<title>Child</title><p>Visible words</p>');
  });
  const report = await crawlSite(url, { allowLocal: true, delayMs: 0 });
  assert.equal(report.pages.length, 3);
  assert.equal(report.pages[0].title, 'Root & page');
  assert.ok(!report.pages[0].text.includes('hidden-token'));
  assert.ok(!visits.includes('/private'));
  assert.ok(report.skipped.some(item => item.url.endsWith('/private') && /robots/.test(item.reason)));
  assert.ok(report.links.every(link => link.from.startsWith(url) && link.to.startsWith(url)));
});

test('crawler checks robots before fetching redirect destinations', async t => {
  const { url, visits } = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') return res.end('User-agent: *\nDisallow: /private\n');
    if (req.url === '/') { res.writeHead(302, { location: '/private' }); return res.end(); }
    res.setHeader('content-type', 'text/html'); res.end('<p>Private</p>');
  });
  const report = await crawlSite(url, { allowLocal: true, delayMs: 0 });
  assert.deepEqual(visits, ['/robots.txt', '/']);
  assert.equal(report.pages.length, 0);
  assert.match(report.skipped[0].reason, /robots/i);
});

test('compressed responses stop as a controlled skipped page', async t => {
  const { url } = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    res.end('compressed-bytes');
  });
  const report = await crawlSite(url, { allowLocal: true, delayMs: 0 });
  assert.equal(report.pages.length, 0);
  assert.match(report.skipped[0].reason, /Compressed/);
});

test('crawler rejects excessive declared response sizes before waiting for the body', async t => {
  const { url } = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': 3 * 1024 * 1024 });
    res.flushHeaders();
  });
  const report = await crawlSite(url, { allowLocal: true, delayMs: 0, timeoutMs: 100 });
  assert.match(report.skipped[0].reason, /2 MiB/);
});

test('robots crawl delay applies before the first page request', async t => {
  const starts = [];
  const { url } = await fixture(t, (req, res) => {
    starts.push(Date.now());
    if (req.url === '/robots.txt') return res.end('User-agent: Qeth\nCrawl-delay: 0.04\n');
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>Page</p>');
  });
  const report = await crawlSite(url, { allowLocal: true, delayMs: 0 });
  assert.equal(report.pages.length, 1);
  assert.ok(starts[1] - starts[0] >= 35, `delay was ${starts[1] - starts[0]} ms`);
});

test('redirect aliases do not fetch an already collected destination twice', async t => {
  const { url, visits } = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    if (req.url === '/alias') { res.writeHead(302, { location: '/destination' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/' ? '<a href="/alias">Alias</a><a href="/destination">Destination</a>' : '<p>Destination</p>');
  });
  const report = await crawlSite(url, { allowLocal: true, delayMs: 0 });
  assert.equal(report.pages.length, 2);
  assert.equal(visits.filter(path => path === '/destination').length, 1);
});

test('explicit invalid option values are rejected before networking', async () => {
  for (const [key, value] of [['maxPages', null], ['maxPages', 0], ['maxPages', 101], ['maxDepth', -1],
    ['maxDepth', 11], ['timeoutMs', 99], ['timeoutMs', Infinity], ['delayMs', -1], ['delayMs', 10001], ['allowLocal', 'yes']]) {
    await assert.rejects(crawlSite('http://127.0.0.1/', { [key]: value }), error => error.exitCode === 2 && !/destination/.test(error.message));
  }
});

test('crawler blocks loopback, private and mapped private roots by default', async () => {
  for (const host of ['127.0.0.1', '0x7f000001', '2130706433', '10.0.0.1', '172.16.0.1', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '[::1]', '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]', '[fc00::1]', '[fe80::1]']) {
    await assert.rejects(crawlSite(`http://${host}/`), error => error.exitCode === 2 && /blocked/.test(error.message));
  }
  for (const host of ['10.0.0.1', '169.254.169.254', '[fc00::1]', '[::ffff:10.0.0.1]']) {
    await assert.rejects(crawlSite(`http://${host}/`, { allowLocal: true }), /blocked/);
  }
});

test('crawler rejects credentials and unsupported protocols', async () => {
  for (const url of ['ftp://example.com/', 'file:///etc/passwd', 'http://user:pass@example.com/', 'not a URL']) {
    await assert.rejects(crawlSite(url), error => error.exitCode === 2);
  }
  await assert.rejects(crawlSite('http://127.0.0.1/', null), /options/);
});

test('robots 401 and 403 deny access; server failures stop closed', async t => {
  for (const status of [401, 403, 503]) {
    const { url, visits } = await fixture(t, (_req, res) => { res.writeHead(status); res.end(); });
    if (status === 503) await assert.rejects(crawlSite(url, { allowLocal: true, delayMs: 0 }), /503/);
    else {
      const report = await crawlSite(url, { allowLocal: true, delayMs: 0 });
      assert.equal(report.pages.length, 0);
      assert.match(report.skipped[0].reason, /robots/);
    }
    assert.deepEqual(visits, ['/robots.txt']);
  }
});

test('crawler blocks cross-origin redirects before contacting their target', async t => {
  const destination = await fixture(t, (_req, res) => res.end('Never fetch'));
  const source = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.writeHead(302, { location: destination.url }); res.end();
  });
  const report = await crawlSite(source.url, { allowLocal: true, delayMs: 0 });
  assert.match(report.skipped[0].reason, /Cross-origin/);
  assert.deepEqual(destination.visits, []);
});

test('crawler stops a same-origin redirect chain at five redirects', async t => {
  const { url, visits } = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    const index = Number(req.url.slice(2)) || 0;
    res.writeHead(302, { location: `/r${index + 1}` }); res.end();
  });
  const report = await crawlSite(url, { allowLocal: true, delayMs: 0 });
  assert.match(report.skipped[0].reason, /Redirect limit/);
  assert.equal(visits.length, 7);
  assert.ok(!visits.includes('/r6'));
});

test('root query counts toward the four variants permitted per path', async t => {
  const { url } = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(Array.from({ length: 8 }, (_, index) => `<a href="/?v=${index}">Variant</a>`).join(''));
  });
  const report = await crawlSite(url + '?v=0', { allowLocal: true, delayMs: 0 });
  assert.equal(report.pages.length, 4);
});

test('discovered graph URLs remain bounded even when the depth limit prevents queuing', async t => {
  const { url } = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(Array.from({ length: 1100 }, (_, index) => `<a href="/p${index}">Page</a>`).join(''));
  });
  const report = await crawlSite(url, { allowLocal: true, delayMs: 0, maxDepth: 0 });
  const known = new Set([report.root, ...report.links.flatMap(link => [link.from, link.to])]);
  assert.equal(report.pages.length, 1);
  assert.ok(known.size <= 1000);
  assert.ok(report.warnings.includes('URL discovery limit reached.'));
});

test('oversized URLs fail before any network access', async () => {
  await assert.rejects(crawlSite('http://127.0.0.1/' + 'a'.repeat(8200)), /URL.*8192/);
});

test('repeated rejected query variants produce one bounded skipped record', async t => {
  const { url } = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<a href="/?v=1">1</a><a href="/?v=2">2</a><a href="/?v=3">3</a>' + '<a href="/?v=4">4</a>'.repeat(2000));
  });
  const report = await crawlSite(url + '?v=0', { allowLocal: true, delayMs: 0, maxPages: 10 });
  assert.equal(report.skipped.filter(item => /variant/.test(item.reason)).length, 1);
});

test('page requests and crawl depth are independent bounded budgets', async t => {
  const handler = (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/' ? '<a href="/one">One</a><a href="/two">Two</a>' : '<a href="/grandchild">Deep</a>');
  };
  const pageBudget = await fixture(t, handler);
  const short = await crawlSite(pageBudget.url, { allowLocal: true, delayMs: 0, maxPages: 2 });
  assert.equal(short.pages.length, 2);
  assert.deepEqual(pageBudget.visits, ['/robots.txt', '/', '/one']);
  assert.ok(short.warnings.includes('Page request budget reached.'));
  const depthBudget = await fixture(t, handler);
  const shallow = await crawlSite(depthBudget.url, { allowLocal: true, delayMs: 0, maxDepth: 1 });
  assert.equal(shallow.pages.length, 3);
  assert.ok(!depthBudget.visits.includes('/grandchild'));
  assert.ok(shallow.links.some(link => link.to.endsWith('/grandchild')));
});

test('crawler bounds chunked bytes, timeouts, and incomplete response bodies', async t => {
  for (const mode of ['bytes', 'timeout', 'truncated']) {
    const { url } = await fixture(t, (req, res) => {
      if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
      if (mode === 'truncated') {
        res.writeHead(200, { 'content-type': 'text/html', 'content-length': 100 });
        res.write('short'); setImmediate(() => res.destroy()); return;
      }
      res.writeHead(200, { 'content-type': 'text/html', 'transfer-encoding': 'chunked' });
      if (mode === 'bytes') { res.write(Buffer.alloc(2 * 1024 * 1024 + 1)); res.end(); }
      else res.flushHeaders();
    });
    const report = await crawlSite(url, { allowLocal: true, delayMs: 0, timeoutMs: 100 });
    assert.equal(report.pages.length, 0);
    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0].reason, mode === 'bytes' ? /2 MiB/ : /aborted|Response|socket/i);
  }
});

test('unavailable robots fails closed and makes no page request', async t => {
  const { url, visits } = await fixture(t, (_req, res) => res.flushHeaders());
  await assert.rejects(crawlSite(url, { allowLocal: true, delayMs: 0, timeoutMs: 100 }), error => error.exitCode === 1);
  assert.deepEqual(visits, ['/robots.txt']);
});

test('crawler records non-HTML and unsuccessful pages without parsing them', async t => {
  const { url } = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    if (req.url === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"x":1}'); }
    if (req.url === '/missing') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<a href="/json">JSON</a><a href="/missing">Missing</a>');
  });
  const report = await crawlSite(url, { allowLocal: true, delayMs: 0 });
  assert.equal(report.pages.length, 1);
  assert.deepEqual(report.skipped.map(item => item.reason), ['Not HTML.', 'HTTP 404']);
});

test('localhost DNS is pinned while the original host header is preserved', async t => {
  const hosts = [];
  const { url } = await fixture(t, (req, res) => {
    hosts.push(req.headers.host);
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>Local fixture</p>');
  });
  const named = url.replace('127.0.0.1', 'localhost');
  const report = await crawlSite(named, { allowLocal: true, delayMs: 0 });
  assert.equal(report.pages.length, 1);
  assert.ok(hosts.every(host => host === new URL(named).host));
});

test('page request budget includes every redirect transaction', async t => {
  const handler = (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    if (req.url === '/') { res.writeHead(302, { location: '/final' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>Final</p>');
  };
  const limited = await fixture(t, handler);
  const stopped = await crawlSite(limited.url, { allowLocal: true, delayMs: 0, maxPages: 1 });
  assert.deepEqual(limited.visits, ['/robots.txt', '/']);
  assert.equal(stopped.pages.length, 0);
  assert.ok(stopped.warnings.includes('Page request budget reached.'));
  assert.match(stopped.skipped[0].reason, /Page request budget/);
  const enough = await fixture(t, handler);
  const collected = await crawlSite(enough.url, { allowLocal: true, delayMs: 0, maxPages: 2 });
  assert.deepEqual(enough.visits, ['/robots.txt', '/', '/final']);
  assert.equal(collected.pages.length, 1);
});

test('redirect query targets share the same four-variant admission limit', async t => {
  const { url, visits } = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    const query = Number(new URL(req.url, 'http://fixture.invalid').searchParams.get('v'));
    if (query < 5) { res.writeHead(302, { location: `/?v=${query + 1}` }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>Final</p>');
  });
  const report = await crawlSite(url + '?v=0', { allowLocal: true, delayMs: 0, maxPages: 10 });
  assert.deepEqual(visits, ['/robots.txt', '/?v=0', '/?v=1', '/?v=2', '/?v=3']);
  assert.equal(report.pages.length, 0);
  assert.match(report.skipped[0].reason, /variant/);
});

test('anchors use the first base href resolved against the document URL', async t => {
  const { url, visits } = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/app/index.html' ? '<base target="_blank"><base href="/docs/"><base href="/ignored/"><a href="guide.html">Guide</a>' : '<p>Guide</p>');
  });
  const report = await crawlSite(url + 'app/index.html', { allowLocal: true, delayMs: 0 });
  assert.deepEqual(visits, ['/robots.txt', '/app/index.html', '/docs/guide.html']);
  assert.ok(report.links.some(link => link.to === url + 'docs/guide.html'));
});

test('off-origin document bases exclude relative links but permit absolute same-origin links', async t => {
  const site = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/app/index.html' ? `<base href="https://example.com/docs/"><base href="/ignored/"><a href="guide.html">External relative</a><a href="${site.url}own">Own absolute</a>` : '<p>Own</p>');
  });
  const report = await crawlSite(site.url + 'app/index.html', { allowLocal: true, delayMs: 0 });
  assert.deepEqual(site.visits, ['/robots.txt', '/app/index.html', '/own']);
  assert.equal(report.links.length, 1);
});

test('malformed, empty, data and javascript first bases use the document fallback', async t => {
  for (const base of ['http://[', '', 'data:text/plain,ignored', 'javascript:void(0)']) {
    const { url, visits } = await fixture(t, (req, res) => {
      if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(req.url === '/app/index.html' ? `<base href="${base}"><base href="/ignored/"><a href="guide.html">Guide</a>` : '<p>Guide</p>');
    });
    await crawlSite(url + 'app/index.html', { allowLocal: true, delayMs: 0 });
    assert.deepEqual(visits, ['/robots.txt', '/app/index.html', '/app/guide.html'], base);
  }
});

test('robots retrieval has its own five-redirect allowance outside the page budget', async t => {
  const { url, visits } = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(302, { location: '/rules1' }); return res.end(); }
    if (req.url.startsWith('/rules')) {
      const index = Number(req.url.slice(6));
      if (index < 5) { res.writeHead(302, { location: `/rules${index + 1}` }); return res.end(); }
      return res.end('User-agent: *\nAllow: /\n');
    }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>Only page</p>');
  });
  const report = await crawlSite(url, { allowLocal: true, delayMs: 0, maxPages: 1 });
  assert.equal(report.pages.length, 1);
  assert.deepEqual(visits, ['/robots.txt', '/rules1', '/rules2', '/rules3', '/rules4', '/rules5', '/']);
});

test('encoded robots metacharacters cannot authorize protected page requests', async t => {
  const { url, visits } = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') return res.end('User-agent: *\nDisallow: /private\nAllow: /private%2A\n');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/' ? '<a href="/private/data">Protected</a><a href="/%70rivate%FF">Encoded protected</a><a href="/private%2A">Literal star</a>' : '<p>Literal path</p>');
  });
  const report = await crawlSite(url, { allowLocal: true, delayMs: 0 });
  assert.equal(report.pages.length, 2);
  assert.deepEqual(visits, ['/robots.txt', '/', '/private%2A']);
});
