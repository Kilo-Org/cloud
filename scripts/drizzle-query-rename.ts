#!/usr/bin/env tsx
/**
 * Type-aware rewrite of `.query` -> `._query` for every drizzle db / transaction
 * receiver. Used both as a one-shot codemod and as a CI verifier.
 *
 * Usage:
 *   tsx scripts/drizzle-query-rename.ts --check        # exit 1 if any drizzle .query remain
 *   tsx scripts/drizzle-query-rename.ts --fix          # rewrite in place
 *   tsx scripts/drizzle-query-rename.ts --fix --dry    # report what --fix would do
 *
 * The check is authoritative: it consults the TypeScript type checker. oxlint's
 * `drizzle/prefer-underscore-query` rule only sees AST and is gated on a name
 * allowlist (db / ctx.db / this.db / tx / trx); this script catches everything
 * else (e.g. dbs renamed at destructuring, helpers returning a drizzle db,
 * transactions bound to unusual callback param names).
 */

import { Project, Node, SyntaxKind } from 'ts-morph';
import { globSync } from 'node:fs';
import path from 'node:path';

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const FIX = args.has('--fix');
const DRY = args.has('--dry');

if (!CHECK && !FIX) {
  console.error('usage: drizzle-query-rename.ts --check | --fix [--dry]');
  process.exit(2);
}

const repoRoot = path.resolve(__dirname, '..');

function findTsconfigs(): string[] {
  const patterns = [
    'apps/*/tsconfig.json',
    'packages/*/tsconfig.json',
    'services/*/tsconfig.json',
    'services/*/wrapper/tsconfig.json',
    'services/gastown/container/tsconfig.json',
    'services/deploy-infra/*/tsconfig.json',
  ];
  const out: string[] = [];
  for (const pattern of patterns) {
    for (const f of globSync(pattern, { cwd: repoRoot })) {
      out.push(path.join(repoRoot, f));
    }
  }
  return out.sort();
}

// Files under dev/ and scripts/ run directly via tsx and are not covered by
// any workspace tsconfig. Scan them under an ad-hoc synthetic project so the
// codemod doesn't miss them.
function findOrphanFiles(): string[] {
  const patterns = ['dev/**/*.ts', 'scripts/**/*.ts'];
  const out: string[] = [];
  for (const pattern of patterns) {
    for (const f of globSync(pattern, { cwd: repoRoot })) {
      if (f.includes('/node_modules/')) continue;
      out.push(path.join(repoRoot, f));
    }
  }
  return out.sort();
}

// A member access `receiver.query` is a drizzle RQB access iff the type of
// `receiver` has a `query` property whose declaration sits inside the
// drizzle-orm package. This covers PgDatabase, PgTransaction,
// BaseSQLiteDatabase, SQLiteTransaction, and anything else drizzle exports.
function isDrizzleQueryAccess(node: Node): boolean {
  if (!Node.isPropertyAccessExpression(node)) return false;
  if (node.getNameNode().getText() !== 'query') return false;

  const checker = node.getProject().getTypeChecker();
  const receiverType = checker.getTypeAtLocation(node.getExpression());
  const queryProp = receiverType.getProperty('query');
  if (!queryProp) return false;

  for (const decl of queryProp.getDeclarations()) {
    const file = decl.getSourceFile().getFilePath();
    if (file.includes('/node_modules/') && /\/drizzle-orm(@[^/]+)?\//.test(file)) {
      return true;
    }
    // Handle pnpm virtual store too.
    if (/\/drizzle-orm\//.test(file) && file.includes('node_modules')) {
      return true;
    }
  }
  return false;
}

type Hit = { file: string; line: number; col: number };

const hits: Hit[] = [];
const seen = new Set<string>();

function scanProject(project: Project) {
  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();
    if (filePath.includes('/node_modules/')) continue;
    if (!filePath.startsWith(repoRoot)) continue;
    if (seen.has(filePath)) continue;
    seen.add(filePath);

    let fileChanged = false;
    const nodes = sourceFile
      .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
      .filter(isDrizzleQueryAccess);

    for (const node of nodes) {
      const nameNode = node.getNameNode();
      const { line, column } = sourceFile.getLineAndColumnAtPos(nameNode.getStart());
      hits.push({ file: path.relative(repoRoot, filePath), line, col: column });

      if (FIX && !DRY) {
        nameNode.replaceWithText('_query');
        fileChanged = true;
      }
    }

    if (fileChanged) sourceFile.saveSync();
  }
}

const tsconfigs = findTsconfigs();
console.log(`[drizzle-query-rename] scanning ${tsconfigs.length} tsconfigs`);

for (const tsconfig of tsconfigs) {
  scanProject(
    new Project({
      tsConfigFilePath: tsconfig,
      skipAddingFilesFromTsConfig: false,
    })
  );
}

const orphans = findOrphanFiles();
if (orphans.length > 0) {
  console.log(`[drizzle-query-rename] scanning ${orphans.length} orphan files (dev/, scripts/)`);
  const synthetic = new Project({
    compilerOptions: {
      target: 99, // ESNext
      module: 99, // ESNext
      moduleResolution: 100, // Bundler
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      allowJs: false,
      types: ['node'],
    },
  });
  for (const f of orphans) synthetic.addSourceFileAtPath(f);
  scanProject(synthetic);
}

if (hits.length === 0) {
  console.log('[drizzle-query-rename] no drizzle `.query` receivers found');
  process.exit(0);
}

const byFile = new Map<string, Hit[]>();
for (const h of hits) {
  const arr = byFile.get(h.file) ?? [];
  arr.push(h);
  byFile.set(h.file, arr);
}
for (const [file, list] of [...byFile.entries()].sort()) {
  console.log(`${file}: ${list.length} hit(s)`);
  for (const h of list) console.log(`  ${h.line}:${h.col}`);
}
console.log(`[drizzle-query-rename] total: ${hits.length} hit(s) in ${byFile.size} file(s)`);

if (CHECK) {
  console.error(
    '[drizzle-query-rename] failing: use `pnpm drizzle:query-rename` or `oxlint --fix` to migrate.'
  );
  process.exit(1);
}

if (FIX && DRY) {
  console.log('[drizzle-query-rename] dry run, no files written');
}
