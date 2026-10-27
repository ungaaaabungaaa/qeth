import { createServer } from 'node:http';
export async function startFixture() {
  const server = createServer((req, res) => {
    if (req.url === '/robots.txt') return res.end('User-agent: *\nDisallow: /private\n');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/') return res.end('<title>Qeth local fixture</title><h1>Local evidence</h1><a href="/guide">Guide</a><a href="/private">Excluded</a>');
    if (req.url === '/guide') return res.end('<title>Guide</title><p>This page is served only on your machine.</p>');
    res.statusCode = 404; res.end('Not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
