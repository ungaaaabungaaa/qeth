import { QethError } from './errors.ts';

interface Rule { allow: boolean; parts: string[]; end: boolean; specificity: number; length: number }
interface Group { agents: string[]; rules: Rule[]; delayMs: number }
function normalized(value: string): string {
  const parts: string[] = [];
  const escaped = (byte: number) => '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  for (let index = 0; index < value.length;) {
    const hex = value.slice(index + 1, index + 3);
    if (value[index] === '%' && /^[0-9a-f]{2}$/i.test(hex)) {
      const byte = Number.parseInt(hex, 16);
      const unreserved = byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122 || byte >= 48 && byte <= 57 || [45, 46, 95, 126].includes(byte);
      parts.push(unreserved ? String.fromCharCode(byte) : escaped(byte));
      index += 3;
      continue;
    }
    const point = value.codePointAt(index)!;
    const character = String.fromCodePoint(point);
    if (point > 127) for (const byte of Buffer.from(character, 'utf8')) parts.push(escaped(byte));
    else parts.push(point === 42 || point === 36 ? escaped(point) : character);
    index += character.length;
  }
  return parts.join('');
}
function matches(rule: Rule, target: string): boolean {
  const first = rule.parts[0]!;
  if (!target.startsWith(first)) return false;
  if (rule.parts.length === 1) return !rule.end || target.length === first.length;
  let cursor = first.length;
  for (let index = 1; index < rule.parts.length; index++) {
    const part = rule.parts[index]!;
    if (rule.end && index === rule.parts.length - 1) return target.endsWith(part) && target.length - part.length >= cursor;
    const found = target.indexOf(part, cursor);
    if (found < 0) return false;
    cursor = found + part.length;
  }
  return true;
}
export function robotsPolicy(text: string): { allowed(url: URL): boolean; delayMs: number } {
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new QethError('robots.txt exceeds the 2 MiB limit.', 1);
  const groups: Group[] = [];
  let group: Group = { agents: [], rules: [], delayMs: 0 };
  let directives = false, ruleCount = 0, lines = 0;
  for (let start = 0; start <= text.length;) {
    const found = text.indexOf('\n', start);
    const end = found < 0 ? text.length : found;
    const raw = text.slice(start, end);
    start = end + 1;
    if (++lines > 20000 || raw.length > 4096) throw new QethError('robots.txt parsing limit exceeded.', 1);
    const line = raw.replace(/#.*/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (directives) { groups.push(group); group = { agents: [], rules: [], delayMs: 0 }; directives = false; }
      if (value) group.agents.push(value.toLowerCase());
    } else if (group.agents.length) {
      directives = true;
      if ((key === 'allow' || key === 'disallow') && value.startsWith('/')) {
        if (++ruleCount > 2000) throw new QethError('robots.txt rule limit exceeded.', 1);
        if (value.length > 2048) throw new QethError('robots.txt pattern limit exceeded.', 1);
        const anchored = value.endsWith('$');
        const rawPattern = anchored ? value.slice(0, -1) : value;
        const parts = rawPattern.split('*').map(normalized);
        const literal = parts.join('');
        group.rules.push({ allow: key === 'allow', parts, end: anchored,
          specificity: literal.replace(/%[0-9A-F]{2}/g, 'x').length, length: literal.length });
      }
      if (key === 'crawl-delay' && /^\d+(\.\d+)?$/.test(value)) group.delayMs = Math.max(group.delayMs, Number(value) * 1000);
    }
  }
  groups.push(group);
  const explicit = groups.filter(g => g.agents.some(agent => agent === 'qeth'));
  const matched = explicit.length ? explicit : groups.filter(g => g.agents.includes('*'));
  const rules = matched.flatMap(g => g.rules);
  const delayMs = Math.max(0, ...matched.map(g => g.delayMs));
  let work = 0;
  return { delayMs, allowed(url) {
    const target = normalized(url.pathname + url.search);
    if (target.length > 8192) throw new QethError('robots URL matching limit exceeded.', 1);
    let length = -1, allowed = true;
    for (const rule of rules) {
      work += target.length + rule.length;
      if (work > 50000000) throw new QethError('robots matching work limit exceeded; crawl stopped.', 1);
      if (!matches(rule, target)) continue;
      if (rule.specificity > length || (rule.specificity === length && rule.allow)) { length = rule.specificity; allowed = rule.allow; }
    }
    return allowed;
  } };
}
