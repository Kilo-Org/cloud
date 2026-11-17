// Line reader for the repo-root `.env.local` the mock's stack entry manages.
// `parseEnvFile` in `dev/local/env-sync/parse.ts` holds the same value rules,
// but that module imports `dev/local/services.ts`, which pulls the CLI's git
// access; a service entry must not load it, so the few lines are mirrored here.

export type EnvEntry = { key: string; value: string };

/**
 * `dotenv` value semantics: one pair of surrounding quotes is stripped (a
 * double-quoted value also unescapes `\"`, `\\` and `\n`), a trailing
 * ` # comment` after the value is not part of it, and an unquoted value loses
 * its own trailing comment the same way.
 */
export function stripEnvValue(raw: string): string {
  let value = raw.trim();
  if (!value.startsWith('"') && !value.startsWith("'")) {
    return value.replace(/\s+#.*$/, '').trim();
  }

  // A quoted value followed by ` # comment` does not end with its quote yet.
  const quote = value[0];
  if (value.length < 2 || !value.endsWith(quote)) {
    value = value.replace(/\s+#.*$/, '').trim();
  }
  if (value.length < 2 || !value.startsWith(quote) || !value.endsWith(quote)) return value;

  const inner = value.slice(1, -1);
  if (quote === "'") return inner;
  return inner.replace(/\\(["\\n])/g, (_match, ch: string) => (ch === 'n' ? '\n' : ch));
}

/**
 * Parses `KEY=value` lines, skipping blanks and comments and accepting the
 * `export KEY=value` spelling. A key that appears more than once yields every
 * entry, in file order, so a caller can tell the managed section's line from
 * one the developer wrote.
 */
export function parseEnvEntries(content: string): EnvEntry[] {
  const entries: EnvEntry[] = [];

  for (const rawLine of content.split('\n')) {
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trimStart();

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    if (key === '') continue;
    entries.push({ key, value: stripEnvValue(line.slice(eqIdx + 1)) });
  }

  return entries;
}
