import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Fails when the built package names a platform where it must not.
 *
 * Principle 12 says anything a runtime does differently is a plugin point, and
 * `tsconfig.json` sets `"types": []` so a first-party `process` or `Buffer` is
 * a compile error. That is all the compiler can do: it cannot see a
 * dependency's own imports, and `skipLibCheck` removes the rest of the
 * leverage. So the rule is checked by reading the build, which AGENTS.md has
 * asked a person to do by hand until now.
 *
 * It reads `dist/`, so `pnpm build` runs first.
 */

const root = join(import.meta.dirname, '..');
const dist = join(root, 'dist');

const filesUnder = (folder: string): readonly string[] =>
  readdirSync(folder).flatMap(name => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) {
      return filesUnder(path);
    }
    return path.endsWith('.js') ? [path] : [];
  });

/**
 * Each rule is a pattern that must not appear, and the files it applies to.
 * The patterns match code, not prose: `node:crypto` is named in a comment in
 * `core/id.ts` explaining why the package does not import it, and that comment
 * is the opposite of a violation.
 */
const rules: readonly {
  readonly what: string;
  readonly pattern: RegExp;
  readonly where: (path: string) => boolean;
  readonly why: string;
}[] = [
  {
    what: 'an import of a Node builtin',
    pattern: /(?:from|import|require)\s*\(?\s*['"]node:/u,
    where: () => true,
    why: 'the package must import on a runtime that has no Node builtins',
  },
  {
    what: '`globalThis`',
    pattern: /\bglobalThis\b/u,
    where: path => path.startsWith('core/'),
    why: 'reading the global is a plugin’s job, and every plugin lives outside core/',
  },
  {
    what: '`process` or `Buffer`',
    pattern: /\b(?:process\.[a-z]|Buffer\.)/u,
    where: path => path.startsWith('core/'),
    why: 'neither exists in a browser or in a React Native release build',
  },
];

const broken: string[] = [];

for (const file of filesUnder(dist)) {
  const path = relative(dist, file);
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const rule of rules) {
    if (!rule.where(path)) {
      continue;
    }
    lines.forEach((line, index) => {
      if (rule.pattern.test(line)) {
        broken.push(`dist/${path}:${String(index + 1)} names ${rule.what}: ${line.trim()}`);
      }
    });
  }
}

if (broken.length === 0) {
  process.stdout.write('the build names no platform\n');
  process.exit(0);
}

process.stdout.write(
  `the build names a platform it must not. Make it a plugin point, or move it under plugins/:\n${broken.join('\n')}\n\n` +
    rules.map(rule => `  ${rule.what}: ${rule.why}`).join('\n') +
    '\n'
);
process.exit(1);
