// Defensive redaction of snippet text (PLAN M8). Engines already redact their snippets; this second pass only makes
// sure nothing that looks like a credential reaches an agent if an engine missed it. It errs on the side of hiding.

const RULES: [RegExp, string | ((m: string) => string)][] = [
  // key = value / key: value where the key names a secret
  [/((?:pass(?:word|wd)?|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|connection[-_]?string|credential)s?["']?\s*[:=]\s*)(["'`]?)[^\s"'`,;)]+\2/gi, '$1$2<redacted>$2'],
  // credentials inside URLs
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1<redacted>@'],
  // JSON web tokens
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '<redacted>'],
  // bearer tokens
  [/(\bbearer\s+)[\w.~+/-]{16,}=*/gi, '$1<redacted>'],
  // long opaque strings: hex of 32 or more (except Git object ids of 40 or 64), or base64-like runs mixing upper case,
  // lower case and digits
  [/(?<![\w-])[0-9a-fA-F]{32,}(?![\w-])/g, (m: string) => (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(m) ? m : '<redacted>')],
  [/(?<![\w+/-])(?=[\w+/-]*[0-9])(?=[\w+/-]*[a-z])(?=[\w+/-]*[A-Z])[\w+/-]{32,}={0,2}(?![\w+/-])/g, '<redacted>'],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of RULES) out = typeof rep === 'string' ? out.replace(re, rep) : out.replace(re, rep);
  return out;
}

/** One line, collapsed whitespace, redacted, at most `max` characters. */
export function snippet(text: unknown, max = 160): string {
  if (text == null) return '';
  const one = redact(String(text)).replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 3) + '...' : one;
}
