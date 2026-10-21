import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Fails when the checked-in migrations do not match the schema.
 *
 * The SQL is generated from `schema.ts` and then inlined into the bundle, so
 * three things have to agree: the schema, the SQL under `migrations/`, and
 * `src/plugins/store/migrations.ts`. Nothing at run time notices when they do
 * not — the store simply applies migrations that no longer describe the
 * columns the queries select, and the first symptom is a broken read on a
 * device.
 *
 * So this regenerates them and asks git whether anything moved. It is the
 * price of inlining, and it is why inlining is allowed.
 */

const root = join(import.meta.dirname, '..');
const watched = ['migrations', 'src/plugins/store/migrations.ts'];

const git = (...args: readonly string[]): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' });

/* A dirty tree before the run would be reported as drift afterwards, which
   would be a lie about what caused it. */
const dirtyBefore = git('status', '--porcelain', '--', ...watched).trim();
if (dirtyBefore !== '') {
  process.stdout.write(
    `the migrations are already modified, so drift cannot be told from your own edits:\n${dirtyBefore}\n`
  );
  process.exit(1);
}

execFileSync('pnpm', ['migrations'], { cwd: root, stdio: 'inherit' });

const drift = git('status', '--porcelain', '--', ...watched).trim();
if (drift === '') {
  process.stdout.write('the migrations match the schema\n');
  process.exit(0);
}

/* What it generated is left where it is: on a real drift that is the answer,
   and the message says how to throw it away when it is not. */
process.stdout.write(
  `the migrations do not match the schema. Run \`pnpm migrations\` and commit what it writes,\n` +
    `or \`git checkout -- ${watched.join(' ')}\` and clean up \`migrations/\` to undo this run:\n${drift}\n\n` +
    git('diff', '--', ...watched)
);
process.exit(1);
