/**
 * A small reader for the OpenSSH client config format (`~/.ssh/config`).
 *
 * `ssh-config` on npm parses this format and is maintained, but its entry point
 * imports `node:child_process` and `node:os` at the top of the module, so Metro
 * cannot resolve it for Hermes. This reader covers the directives the importer
 * maps and keeps no Node dependency.
 */

export type SshConfigEntry = Readonly<{ key: string; value: string }>;

type SshConfigBlockBase = Readonly<{ entries: SshConfigEntry[] }>;

/**
 * One section of a config file. `global` holds the directives before any
 * `Host` (a default for every host), `host` one `Host` line and the
 * directives under it, and `match` a `Match` block (a conditional default the
 * importer does not apply).
 */
export type SshConfigBlock =
  | (SshConfigBlockBase & { kind: 'global' })
  | (SshConfigBlockBase & { kind: 'host'; patterns: string[] })
  | (SshConfigBlockBase & { kind: 'match' });

function stripComment(line: string): string {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line.charAt(index);
    if (character === '"') {
      quoted = !quoted;
    } else if (character === '#' && !quoted && (index === 0 || /\s/.test(line.charAt(index - 1)))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function splitTokens(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  for (const character of text) {
    if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && /\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += character;
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/** The directive and its arguments: `Port 2222`, `Port=2222`, `Key "a b"`. */
function splitDirective(line: string): string[] {
  const withoutComment = stripComment(line);
  const equals = withoutComment.indexOf('=');
  const space = withoutComment.search(/\s/);
  if (equals > 0 && (space === -1 || equals < space)) {
    return [
      withoutComment.slice(0, equals).trim(),
      ...splitTokens(withoutComment.slice(equals + 1)),
    ];
  }
  return splitTokens(withoutComment);
}

export function parseSshConfig(text: string): SshConfigBlock[] {
  const blocks: SshConfigBlock[] = [{ kind: 'global', entries: [] }];
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));

  for (const line of lines) {
    const [directive = '', ...args] = splitDirective(line);
    const key = directive.toLowerCase();
    if (key === 'host') {
      blocks.push({ kind: 'host', patterns: args, entries: [] });
    } else if (key === 'match') {
      blocks.push({ kind: 'match', entries: [] });
    } else if (key.length > 0) {
      blocks.at(-1)?.entries.push({ key, value: args.join(' ').trim() });
    }
  }
  return blocks;
}
