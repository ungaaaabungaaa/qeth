import test from 'node:test';
import assert from 'node:assert/strict';
import { robotsPolicy } from '../src/robots.ts';

test('robots parsing rejects excessive rule count and pattern length before matching', () => {
  assert.throws(() => robotsPolicy('User-agent: *\n' + 'Disallow: /x\n'.repeat(2001)), /rule limit/);
  assert.throws(() => robotsPolicy('User-agent: *\nDisallow: /' + '*x'.repeat(1100)), /pattern limit/);
});

test('robots wildcard, anchors, normalized escapes, and allow ties use the intended path', () => {
  const policy = robotsPolicy('User-agent: *\nDisallow: /private*\nAllow: /private/public$\nDisallow: /same\nAllow: /same\nDisallow: /search?secret=*\n');
  for (const path of ['/private', '/private/public?query=1', '/%70rivate/other', '/search?secret=yes']) {
    assert.equal(policy.allowed(new URL(path, 'https://example.com')), false, path);
  }
  for (const path of ['/private/public', '/same', '/search?public=yes']) {
    assert.equal(policy.allowed(new URL(path, 'https://example.com')), true, path);
  }
});

test('Qeth groups take priority; partial unrelated agent names do not match', () => {
  const own = robotsPolicy('User-agent: *\nDisallow: /\nUser-agent: QETH\nAllow: /allowed\nCrawl-delay: 0.2\n');
  assert.equal(own.allowed(new URL('https://example.com/allowed')), true);
  assert.equal(own.allowed(new URL('https://example.com/unlisted')), true);
  assert.equal(own.delayMs, 200);
  const partial = robotsPolicy('User-agent: q\nDisallow: /\nUser-agent: *\nAllow: /\n');
  assert.equal(partial.allowed(new URL('https://example.com/')), true);
});

test('wildcard matching does not backtrack and total matching work is bounded', () => {
  const safe = robotsPolicy('User-agent: *\nDisallow: /' + '*a'.repeat(400) + 'b$\n');
  assert.equal(safe.allowed(new URL('https://example.com/' + 'a'.repeat(1500))), true);
  const bounded = robotsPolicy('User-agent: *\n' + 'Disallow: /x\n'.repeat(2000));
  assert.throws(() => { for (let i = 0; i < 10; i++) bounded.allowed(new URL('https://example.com/' + 'a'.repeat(8000))); }, /work limit/);
  assert.throws(() => robotsPolicy('\n'.repeat(20001)), /parsing limit/);
  assert.throws(() => robotsPolicy('a'.repeat(2 * 1024 * 1024 + 1)), /2 MiB/);
});

test('encoded stars and dollars remain literal robots path octets', () => {
  const star = robotsPolicy('User-agent: *\nDisallow: /private\nAllow: /private%2A\n');
  assert.equal(star.allowed(new URL('https://example.com/private/data')), false);
  assert.equal(star.allowed(new URL('https://example.com/private%2a')), true);
  assert.equal(star.allowed(new URL('https://example.com/private*')), true);
  const dollar = robotsPolicy('User-agent: *\nDisallow: /private\nAllow: /private%24\n');
  assert.equal(dollar.allowed(new URL('https://example.com/private%24/child')), true);
  assert.equal(dollar.allowed(new URL('https://example.com/private$/child')), true);
  assert.equal(dollar.allowed(new URL('https://example.com/private/child')), false);
});

test('unreserved ASCII is normalized even beside invalid UTF-8 octets', () => {
  const policy = robotsPolicy('User-agent: *\nDisallow: /private%FF\n');
  assert.equal(policy.allowed(new URL('https://example.com/private%FF')), false);
  assert.equal(policy.allowed(new URL('https://example.com/%70rivate%ff')), false);
  const prefix = robotsPolicy('User-agent: *\nDisallow: /private\n');
  assert.equal(prefix.allowed(new URL('https://example.com/%70rivate%FF')), false);
});

test('raw Unicode patterns match their percent-encoded UTF-8 URL octets', () => {
  const raw = robotsPolicy('User-agent: *\nDisallow: /café/\n');
  const encoded = robotsPolicy('User-agent: *\nDisallow: /caf%C3%A9/\n');
  for (const path of ['/café/guide', '/caf%C3%A9/guide', '/caf%c3%a9/guide']) {
    assert.equal(raw.allowed(new URL(path, 'https://example.com')), false, path);
    assert.equal(encoded.allowed(new URL(path, 'https://example.com')), false, path);
  }
});
