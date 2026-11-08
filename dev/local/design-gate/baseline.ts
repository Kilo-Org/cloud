import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { evaluate, listPages, openSession, selectPage } from './cdp';
import type { RunOutcome } from './capture';
import { normalize, parseDump } from './tree';
import type { Finding } from './findings';
import { collapseFindings, type CollapsedFinding } from './report';
import { baselineGit, containedProofSource } from './baseline-preflight';

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const SourcePath = z
  .string()
  .regex(/^apps\/mobile\/src\/components\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.tsx$/);
const TargetSchema = z
  .object({
    id: Id,
    link: z
      .string()
      .url()
      .refine(value => value.startsWith('kiloapp:///')),
    route: z.string().startsWith('/').max(256),
    screen: z
      .string()
      .max(256)
      .regex(/^(?:[^/]+(?:\/[^/]+)*)?$/),
    readyTestID: z.string().min(1).max(128),
    diagnostic: z
      .object({
        component: SourcePath,
        exportName: z
          .string()
          .regex(/^(?:default|[A-Z][a-zA-Z0-9]*)$/)
          .default('default'),
        props: z.record(z.string(), z.json()).default({}),
      })
      .strict()
      .optional(),
  })
  .strict();
export const ProofManifestSchema = z
  .object({
    version: z.literal(1),
    targets: z.array(TargetSchema).min(1).max(32),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const ids = new Set<string>();
    for (const target of manifest.targets) {
      if (ids.has(target.id)) ctx.addIssue({ code: 'custom', message: 'Duplicate target id' });
      ids.add(target.id);
      if (target.diagnostic !== undefined) {
        const route = `/design-proof-${target.id}`;
        if (
          target.route !== route ||
          target.screen !== `(auth)/${route.slice(1)}` ||
          target.link !== `kiloapp://${route}`
        ) {
          ctx.addIssue({
            code: 'custom',
            message: `Diagnostic ${target.id} must use kiloapp://${route}, route ${route} and screen (auth)/${route.slice(1)}`,
          });
        }
      }
    }
  });
export type ProofManifest = z.infer<typeof ProofManifestSchema>;
const PreparedFileSchema = z
  .object({ path: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
const RevisionSchema = z
  .object({
    directory: z.string(),
    commit: Sha,
    productTree: Sha,
    prepared: z.array(PreparedFileSchema),
  })
  .strict();
const PreparationSchema = z
  .object({
    version: z.literal(1),
    base: RevisionSchema,
    head: RevisionSchema,
    manifest: ProofManifestSchema,
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type Preparation = z.infer<typeof PreparationSchema>;
export type Revision = 'base' | 'head';
const INTENT = 'apps/mobile/src/app/+native-intent.tsx';
const MARKER = '__kiloDesignProofSource';
const LIMIT = 1024 * 1024;

const digest = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16 * LIMIT,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}
function readJson(file: string): unknown {
  if (fs.statSync(file).size > LIMIT) throw new Error('Proof JSON exceeds 1 MiB');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
export function readProofManifest(file: string): ProofManifest {
  return ProofManifestSchema.parse(readJson(file));
}
export function readPreparation(file: string): Preparation {
  const preparation = PreparationSchema.parse(readJson(file));
  if (digest(JSON.stringify(preparation.manifest)) !== preparation.manifestSha256) {
    throw new Error('Preparation manifest digest mismatch');
  }
  return preparation;
}
function trackedFile(repo: string, commit: string, file: string): string {
  const mode = git(repo, ['ls-tree', commit, '--', file]);
  if (!mode.startsWith('100644 blob ') && !mode.startsWith('100755 blob ')) {
    throw new Error(`Missing regular source file at ${commit}: ${file}`);
  }
  return git(repo, ['show', `${commit}:${file}`]);
}
function generatedFiles(
  repo: string,
  commit: string,
  manifest: ProofManifest,
  marker: string
): Map<string, string> {
  let intent = trackedFile(repo, commit, INTENT);
  const files = new Map<string, string>();
  const branches: string[] = [];
  for (const target of manifest.targets) {
    const diagnostic = target.diagnostic;
    if (diagnostic === undefined) continue;
    // The manifest describes data and a product component, never executable source,
    // auth replacement, environment files, or an arbitrary head-to-base copy.
    trackedFile(repo, commit, diagnostic.component);
    const file = `apps/mobile/src/app/(auth)/design-proof-${target.id}.tsx`;
    if (git(repo, ['ls-tree', commit, '--', file]).trim() !== '') {
      throw new Error(`Diagnostic would overwrite existing product source: ${file}`);
    }
    const componentImport = `@/${diagnostic.component.slice('apps/mobile/src/'.length, -4)}`;
    let binding = 'Component';
    if (diagnostic.exportName !== 'default') binding = `{ ${diagnostic.exportName} as Component }`;
    files.set(
      file,
      `// Temporary generated design-proof diagnostic, not product source.\nimport React from 'react';\nimport { Redirect } from 'expo-router';\nimport ComponentBinding from ${JSON.stringify(componentImport)};\nexport default function DesignProofFixture() {\n  if (!__DEV__) return React.createElement(Redirect, { href: '/(auth)/login' });\n  return React.createElement(Component, JSON.parse(${JSON.stringify(JSON.stringify(diagnostic.props))}));\n}\n`.replace(
        'ComponentBinding',
        binding
      )
    );
    branches.push(
      `  if (__DEV__ && ${JSON.stringify([target.link, target.route, target.route.slice(1)])}.includes(path)) return ${JSON.stringify(`/${target.screen}`)};`
    );
  }
  const declaration =
    'export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {';
  if (branches.length > 0) {
    if (intent.split(declaration).length !== 2)
      throw new Error('Unsupported native-intent diagnostic insertion point');
    intent = intent.replace(declaration, `${declaration}\n${branches.join('\n')}`);
  }
  intent += `\n// Temporary diagnostic source receipt; forces stale Metro bundles to fail closed.\nif (__DEV__) (globalThis as typeof globalThis & { ${MARKER}?: string }).${MARKER} = ${JSON.stringify(marker)};\n`;
  files.set(INTENT, intent);
  return files;
}
export function sourceMarker(preparation: Preparation, revision: Revision): string {
  return `${preparation[revision].commit}:${preparation.manifestSha256}`;
}

/** Creates only new detached worktrees. Existing branches, env and runtime are untouched. */
export async function prepareProof(
  input: {
    repo: string;
    base: string;
    head: string;
    targets: string;
    out: string;
  },
  signal?: AbortSignal
): Promise<Preparation> {
  Sha.parse(input.base);
  Sha.parse(input.head);
  const repo = fs.realpathSync(input.repo);
  const manifest = readProofManifest(input.targets);
  const manifestSha256 = digest(JSON.stringify(manifest));
  for (const commit of [input.base, input.head]) {
    if (git(repo, ['rev-parse', '--verify', `${commit}^{commit}`]).trim() !== commit) {
      throw new Error('Proof requires exact commit objects');
    }
  }
  git(repo, ['merge-base', '--is-ancestor', input.base, input.head]);
  const plans = (['base', 'head'] as const).map(revision => {
    const commit = input[revision];
    return {
      revision,
      commit,
      productTree: git(repo, ['rev-parse', `${commit}^{tree}`]).trim(),
      files: generatedFiles(repo, commit, manifest, `${commit}:${manifestSha256}`),
    };
  });
  // Claim a new output directory before cleanup is armed; never remove preexisting output.
  fs.mkdirSync(input.out);
  const output = fs.realpathSync(input.out);
  const outputIdentity = fs.statSync(output);
  const attempted: string[] = [];
  try {
    signal?.throwIfAborted();
    const revisions = {} as Record<Revision, z.infer<typeof RevisionSchema>>;
    for (const plan of plans) {
      const directory = path.join(output, plan.revision);
      attempted.push(directory);
      await baselineGit(repo, ['worktree', 'add', '--detach', directory, plan.commit], signal);
      const prepared: z.infer<typeof PreparedFileSchema>[] = [];
      for (const [file, text] of plan.files) {
        signal?.throwIfAborted();
        const destination = containedProofSource(directory, file, true);
        await fs.promises.writeFile(destination, text, {
          signal,
          flag:
            fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_TRUNC |
            fs.constants.O_NOFOLLOW,
        });
        prepared.push({ path: file, sha256: digest(text) });
      }
      revisions[plan.revision] = {
        directory,
        commit: plan.commit,
        productTree: plan.productTree,
        prepared,
      };
    }
    const preparation: Preparation = { version: 1, ...revisions, manifest, manifestSha256 };
    await fs.promises.writeFile(
      path.join(output, 'preparation.json'),
      JSON.stringify(preparation, null, 2),
      { signal, flag: 'wx' }
    );
    signal?.throwIfAborted();
    return preparation;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const directory of attempted.reverse()) {
      try {
        const registered = (await baselineGit(repo, ['worktree', 'list', '--porcelain', '-z']))
          .split('\0')
          .includes(`worktree ${directory}`);
        if (registered)
          await baselineGit(repo, ['worktree', 'remove', '--force', '--force', directory]);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length === 0) {
      try {
        const currentIdentity = fs.lstatSync(output);
        if (
          currentIdentity.dev !== outputIdentity.dev ||
          !currentIdentity.isDirectory() ||
          currentIdentity.isSymbolicLink() ||
          currentIdentity.ino !== outputIdentity.ino
        ) {
          throw new Error('Preparation output ownership changed; refusing cleanup');
        }
        fs.rmSync(output, { recursive: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `Preparation failed and owned output cleanup was incomplete: ${output}`
      );
    }
    throw error;
  }
}

export function validatePreparedSource(
  preparation: Preparation,
  revision: Revision,
  cwd: string
): void {
  const source = preparation[revision];
  if (fs.realpathSync(cwd) !== fs.realpathSync(source.directory))
    throw new Error(`Run from prepared ${revision} worktree ${source.directory}`);
  if (
    git(cwd, ['rev-parse', 'HEAD']).trim() !== source.commit ||
    git(cwd, ['rev-parse', 'HEAD^{tree}']).trim() !== source.productTree
  ) {
    throw new Error('Prepared product source identity changed');
  }
  const expected = generatedFiles(
    cwd,
    source.commit,
    preparation.manifest,
    sourceMarker(preparation, revision)
  );
  if (
    JSON.stringify([...expected].map(([file, text]) => ({ path: file, sha256: digest(text) }))) !==
    JSON.stringify(source.prepared)
  ) {
    throw new Error('Diagnostic provenance differs from generated plumbing');
  }
  for (const [file, text] of expected) {
    const sourceFile = containedProofSource(cwd, file);
    if (fs.readFileSync(sourceFile, 'utf8') !== text) {
      throw new Error(`Prepared diagnostic source changed: ${file}`);
    }
  }
  const changed = git(cwd, ['diff', 'HEAD', '--name-only', '-z']).split('\0').filter(Boolean);
  const untracked = git(cwd, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    'apps/mobile',
  ])
    .split('\0')
    .filter(Boolean);
  if ([...changed, ...untracked].some(file => !expected.has(file)))
    throw new Error('Unrelated product source changes in prepared worktree');
}

/** Verify the device loaded this exact prepared bundle, not just a running Metro. */
export async function verifyRuntimeSource(
  preparation: Preparation,
  revision: Revision,
  metro: string,
  names: readonly string[],
  deps: {
    listPages: typeof listPages;
    openSession: typeof openSession;
    evaluate: typeof evaluate;
  } = { listPages, openSession, evaluate }
): Promise<void> {
  const pages = await deps.listPages(metro);
  const wanted = names.map(name => name.toLowerCase()).filter(name => name.length > 0);
  const matching = pages.filter(
    page =>
      (page.webSocketDebuggerUrl ?? '').length > 0 &&
      wanted.some(name =>
        [page.deviceName, page.title].some(field => field?.toLowerCase().includes(name) === true)
      )
  );
  if (matching.length !== 1) {
    throw new Error(
      'Prepared proof requires exactly one positively device-matched connected runtime'
    );
  }
  const page = selectPage(matching, names);
  if (page?.webSocketDebuggerUrl === undefined) throw new Error('No unique prepared runtime');
  const session = await deps.openSession(page.webSocketDebuggerUrl);
  try {
    const observed = await deps.evaluate(session, `globalThis.${MARKER}`);
    if (observed !== sourceMarker(preparation, revision))
      throw new Error('Runtime is stale or not the prepared product bundle');
  } finally {
    session.close();
  }
}

type ReadinessRun = {
  cells: { id: string; screens: { target: string; link: string; dump: string }[] }[];
  findings: { cell: string; target: string; rule: string }[];
};
function artifactPath(out: string, file: string): string {
  const resolved = fs.realpathSync(path.resolve(out, file));
  if (!resolved.startsWith(`${fs.realpathSync(out)}${path.sep}`)) {
    throw new Error('Capture artifact escapes its run directory');
  }
  return resolved;
}
export function targetReadiness(
  outcome: ReadinessRun,
  manifest: ProofManifest,
  out: string
): string[] {
  const failures: string[] = [];
  if (outcome.cells.length === 0) failures.push('No matrix cells captured');
  if (new Set(outcome.cells.map(cell => cell.id)).size !== outcome.cells.length)
    failures.push('Duplicate matrix cells');
  for (const cell of outcome.cells) {
    if (
      cell.screens.length !== manifest.targets.length ||
      cell.screens.some(screen => !manifest.targets.some(target => target.id === screen.target))
    ) {
      failures.push(`${cell.id}: target coverage differs from manifest`);
    }
    for (const target of manifest.targets) {
      const screen = cell.screens.find(candidate => candidate.target === target.id);
      if (screen === undefined) {
        failures.push(`${cell.id}/${target.id}: missing screen`);
        continue;
      }
      const dump = parseDump(readJson(artifactPath(out, screen.dump)));
      if (
        cell.screens.filter(candidate => candidate.target === target.id).length !== 1 ||
        screen.link !== target.link
      ) {
        failures.push(`${cell.id}/${target.id}: duplicate or mismatched target`);
      }
      const blocked = /(?:^|\/)(?:login|sign-in|signin|splash|onboarding)(?:\/|$)/i.test(
        `${dump.env.route}/${dump.env.screen ?? ''}`
      );
      const ready = normalize(dump).nodes.some(
        node =>
          node.probe.testID === target.readyTestID &&
          node.visibleRect[2] > 0 &&
          node.visibleRect[3] > 0
      );
      const warning = outcome.findings.some(
        finding =>
          finding.cell === cell.id &&
          finding.target === target.id &&
          ['env-mismatch', 'unsettled', 'capture-alignment', 'blank-frame'].includes(finding.rule)
      );
      if (
        blocked ||
        !ready ||
        warning ||
        dump.env.route !== target.route ||
        dump.env.screen !== target.screen
      ) {
        failures.push(
          `${cell.id}/${target.id}: target not ready or screen identity differs (${dump.env.route}, ${dump.env.screen ?? 'unknown'})`
        );
      }
    }
  }
  if (
    outcome.findings.some(
      finding =>
        !manifest.targets.some(target => target.id === finding.target) ||
        !outcome.cells.some(cell => cell.id === finding.cell)
    )
  ) {
    failures.push('Findings are outside the prepared target matrix');
  }
  return failures;
}

const CaptureReceiptSchema = z
  .object({
    version: z.literal(1),
    revision: z.enum(['base', 'head']),
    source: RevisionSchema,
    manifestSha256: z.string(),
    findingsSha256: z.string(),
    readiness: z.array(z.string()),
    artifacts: z.array(PreparedFileSchema),
  })
  .strict();
export function writeCaptureReceipt(
  preparation: Preparation,
  revision: Revision,
  outcome: RunOutcome,
  out: string
): string[] {
  const readiness = targetReadiness(outcome, preparation.manifest, out);
  const artifacts = outcome.cells
    .flatMap(cell => cell.screens.flatMap(screen => [screen.dump, screen.screenshot]))
    .map(file => ({
      path: file,
      sha256: digest(fs.readFileSync(artifactPath(out, file))),
    }));
  fs.writeFileSync(
    path.join(out, 'proof-source.json'),
    JSON.stringify(
      {
        version: 1,
        revision,
        source: preparation[revision],
        manifestSha256: preparation.manifestSha256,
        findingsSha256: digest(fs.readFileSync(path.join(out, 'findings.json'))),
        readiness,
        artifacts,
      },
      null,
      2
    )
  );
  return readiness;
}

const ElementSchema = z
  .object({
    index: z.number().int().nonnegative(),
    path: z.string(),
    tag: z.string(),
    rect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    owners: z.array(z.string()).optional(),
    text: z.string().optional(),
    testID: z.string().optional(),
    label: z.string().optional(),
  })
  .passthrough();
const ComparisonFindingSchema = z
  .object({
    rule: z.enum([
      'clipped',
      'cut-off',
      'overlap',
      'touch-overlap',
      'row-misaligned',
      'ink-off-center',
      'touch-target',
      'inset-asymmetry',
      'layout-shift',
      'rtl-mirror',
      'safe-area',
      'unsettled',
      'capture-alignment',
      'blank-frame',
      'env-mismatch',
    ]),
    severity: z.enum(['error', 'warning']),
    cell: z.string(),
    target: z.string(),
    element: ElementSchema,
    related: z.array(ElementSchema).optional(),
    measured: z.number(),
    expected: z.string(),
    unit: z.enum(['dp', 'ms', 'ratio']),
    message: z.string(),
    count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1),
  })
  .passthrough();
const FindingsSchema = z.object({
  run: z.object({ restoreError: z.string().optional() }).passthrough().optional(),
  cells: z.array(
    z.object({
      id: z.string(),
      config: z.unknown(),
      screens: z.array(
        z.object({
          target: z.string(),
          link: z.string(),
          dump: z.string(),
          screenshot: z.string(),
          annotated: z.string(),
        })
      ),
    })
  ),
  findings: z.array(ComparisonFindingSchema),
});
export async function compareProof(
  preparation: Preparation,
  baseRun: string,
  headRun: string,
  out: string,
  signal?: AbortSignal
): Promise<{
  status: 'comparable' | 'inconclusive';
  introduced: CollapsedFinding[];
  reasons: string[];
}> {
  if (fs.existsSync(out))
    throw new Error(
      'Comparison output must be a new directory; prior evidence is never overwritten'
    );
  const reasons: string[] = [];
  const runs = (['base', 'head'] as const).map(revision => {
    const dir = revision === 'base' ? baseRun : headRun;
    const receipt = CaptureReceiptSchema.parse(readJson(path.join(dir, 'proof-source.json')));
    const bytes = fs.readFileSync(path.join(dir, 'findings.json'));
    if (
      receipt.revision !== revision ||
      receipt.manifestSha256 !== preparation.manifestSha256 ||
      JSON.stringify(receipt.source) !== JSON.stringify(preparation[revision]) ||
      receipt.findingsSha256 !== digest(bytes)
    ) {
      throw new Error(`Unbound ${revision} capture provenance`);
    }
    const run = FindingsSchema.parse(JSON.parse(bytes.toString()));
    for (const artifact of receipt.artifacts) {
      if (digest(fs.readFileSync(artifactPath(dir, artifact.path))) !== artifact.sha256)
        throw new Error(`Changed ${revision} capture artifact: ${artifact.path}`);
    }
    const required = run.cells.flatMap(cell =>
      cell.screens.flatMap(screen => [screen.dump, screen.screenshot])
    );
    if (required.some(file => !receipt.artifacts.some(artifact => artifact.path === file)))
      throw new Error('Unbound capture artifacts');
    if (run.run?.restoreError !== undefined) reasons.push(`${revision}: device restoration failed`);
    // Re-read the actual captured dumps; never trust a claimed readiness boolean.
    const readiness = targetReadiness(run, preparation.manifest, dir);
    reasons.push(
      ...readiness.map(reason => `${revision}: ${reason}`),
      ...receipt.readiness.map(reason => `${revision}: ${reason}`)
    );
    return run;
  });
  const [base, head] = runs;
  if (
    JSON.stringify(base.cells.map(cell => [cell.id, cell.config])) !==
    JSON.stringify(head.cells.map(cell => [cell.id, cell.config]))
  )
    reasons.push('Matrix cells/configuration differ');
  const environments = (run: typeof base, dir: string): unknown[] =>
    run.cells.flatMap(cell =>
      cell.screens.map(screen => {
        const env = parseDump(readJson(artifactPath(dir, screen.dump))).env;
        return [
          cell.id,
          screen.target,
          env.platform,
          env.osVersion,
          env.window,
          env.pixelRatio,
          env.fontScale,
          env.colorScheme,
          env.isRTL,
          env.language,
          env.safeArea,
        ];
      })
    );
  if (JSON.stringify(environments(base, baseRun)) !== JSON.stringify(environments(head, headRun)))
    reasons.push('Captured device environments differ');
  const introduced: CollapsedFinding[] = [];
  if (reasons.length === 0) {
    const allFindings = [...base.findings, ...head.findings];
    const counts = new Map<Finding, number>(allFindings.map(finding => [finding, finding.count]));
    const baseMembers = new Set<Finding>(base.findings);
    // Use the report's exact grouping, including sibling-index stripping and
    // rounded measurement identity; never compare a collapsed group's first path.
    for (const group of collapseFindings(allFindings)) {
      if (group.finding.severity !== 'error') continue;
      let baseCount = 0;
      let headCount = 0;
      let representative: Finding | undefined;
      for (const member of group.members) {
        const count = counts.get(member);
        if (count === undefined)
          throw new Error('Finding group lost its original count provenance');
        if (baseMembers.has(member)) {
          baseCount += count;
        } else {
          headCount += count;
          representative ??= member;
        }
      }
      if (!Number.isSafeInteger(baseCount) || !Number.isSafeInteger(headCount)) {
        throw new Error('Collapsed finding count exceeds safe integer range');
      }
      if (headCount > baseCount && representative !== undefined) {
        introduced.push({ ...representative, count: headCount });
      }
    }
  }
  const result = {
    status: reasons.length === 0 ? ('comparable' as const) : ('inconclusive' as const),
    introduced,
    reasons: [...new Set(reasons)],
  };
  fs.mkdirSync(out);
  const outputIdentity = fs.lstatSync(out);
  try {
    signal?.throwIfAborted();
    await fs.promises.writeFile(
      path.join(out, '.comparison.json.tmp'),
      JSON.stringify(
        {
          ...result,
          base: preparation.base.commit,
          head: preparation.head.commit,
          manifestSha256: preparation.manifestSha256,
        },
        null,
        2
      ),
      { signal, flag: 'wx' }
    );
    signal?.throwIfAborted();
    await fs.promises.rename(
      path.join(out, '.comparison.json.tmp'),
      path.join(out, 'comparison.json')
    );
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    const current = fs.lstatSync(out);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== outputIdentity.dev ||
      current.ino !== outputIdentity.ino
    ) {
      throw new AggregateError([error], 'Comparison output ownership changed; refusing cleanup');
    }
    await fs.promises.rm(out, { recursive: true });
    throw error;
  }
}
