import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Fails when the built package names something it must not: a platform in the
 * code, or a dev dependency in the published types.
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

const filesUnder = (folder: string, ending: string): readonly string[] =>
  readdirSync(folder).flatMap(name => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) {
      return filesUnder(path, ending);
    }
    return path.endsWith(ending) ? [path] : [];
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

for (const file of filesUnder(dist, '.js')) {
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

/**
 * A dependency used only for its types must not reach the published types.
 *
 * `openai` and `@anthropic-ai/sdk` are the contract the three wires are written
 * against, and nothing of either survives the build: every import of them is a
 * type. That is what lets them be dev dependencies, which is two large packages
 * a consumer does not install. Exporting a type built out of one puts it back
 * in a `.d.ts`, and the consumer's own typecheck then fails on a package they
 * were never told to add. The compiler cannot see this: here they are
 * installed.
 */
const buildOnly = ['openai', '@anthropic-ai/sdk'];

for (const file of filesUnder(dist, '.d.ts')) {
  const path = relative(dist, file);
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    const named = buildOnly.find(name => line.includes(`'${name}'`));
    if (named !== undefined) {
      broken.push(`dist/${path}:${String(index + 1)} names ${named}, which a consumer does not install`);
    }
  });
}

if (broken.length === 0) {
  process.stdout.write('the build names no platform and no dev dependency\n');
  process.exit(0);
}

process.stdout.write(
  `the build names something it must not. Make a platform a plugin point, or move it under plugins/. Stop exporting a type built out of a dev dependency:\n${broken.join('\n')}\n\n` +
    rules.map(rule => `  ${rule.what}: ${rule.why}`).join('\n') +
    '\n'
);
process.exit(1);
