import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z, type RefinementCtx } from 'zod';

import { evaluate, listPages, openSession, selectPage } from './cdp';
import type { RunOutcome } from './capture';
import { normalize, parseDump } from './tree';
import { RULE_IDS, type Finding } from './findings';
import { collapseFindings, type CollapsedFinding } from './report';
import {
  runPixelDiffAdvisory,
  type PixelComparator,
  type PixelDiffSummary,
} from './pixel-diff-advice';
import { baselineGit, containedProofSource } from './baseline-preflight';

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
/**
 * A default export the diagnostic may render, named from the mobile app root.
 *
 * A shared component is the obvious case. A screen file is the necessary one:
 * when a change only alters the props a route passes to an unchanged component,
 * the component renders the same on both revisions and a component target
 * cannot show the difference. Route files carry their group and parameter
 * segments; the tree below `src/app/` grows whichever screens the revision has,
 * so a dotted segment is allowed there and still refused below `components/`.
 */
const COMPONENT_SOURCE =
  /^apps\/mobile\/src\/components\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.tsx$/;
const ROUTE_SOURCE =
  /^apps\/mobile\/src\/app\/(?:[a-zA-Z0-9_()[\]$.-]+\/)*[a-zA-Z0-9_()[\]$.-]+\.tsx$/;
function isRouteScreen(value: string): boolean {
  if (!ROUTE_SOURCE.test(value)) return false;
  const segments = value.slice('apps/mobile/src/app/'.length).split('/');
  const file = segments.pop();
  if (file === undefined) return false;
  // A `.` or `..` segment leaves the app tree, and a hidden segment names no route.
  if (segments.some(segment => segment.startsWith('.'))) return false;
  // The router owns its own files: a layout is not a screen, and a `+` file is
  // reserved for the not-found, HTML and native-intent hooks.
  return !/^_layout\.tsx$/.test(file) && !file.startsWith('+');
}
const SourcePath = z
  .string()
  .refine(value => COMPONENT_SOURCE.test(value) || isRouteScreen(value), {
    message:
      'must name a component below apps/mobile/src/components or a screen below apps/mobile/src/app, not a layout and not a + file',
  });
/**
 * The one element descriptor a diagnostic may pass. The generated route expands
 * it into the trailing cluster the header cells need, mirroring
 * `header-balance-fixture.tsx`'s `SaveCluster`; the shape stays data in the
 * manifest and never reaches the component as one.
 */
const SAVE_ELEMENT = 'save-cluster' as const;
const ElementDescriptorSchema = z.object({ $element: z.literal(SAVE_ELEMENT) }).strict();
/**
 * The prop names that render inside a `View` and therefore refuse a string:
 * React Native's `Text strings must be rendered within a <Text> component.`
 * invariant is what the diagnostic's bare strings produced in the LogBox
 * capture. The header's own string slots (`title`, `eyebrow`, `subtitle`)
 * render inside a `Text` and stay strings; only these node-slot props are
 * checked below. The check is keyed on the prop name alone, so it covers any
 * diagnostic component that declares one of them, not only ScreenHeader.
 */
const SCREEN_HEADER_NODE_SLOT_NAMES = [
  'headerRight',
  'inlineActions',
  'titleContent',
  'titleAccessory',
  'subtitlePlaceholder',
  'eyebrowPlaceholder',
] as const;
const descriptorMessage =
  'must be { "$element": "save-cluster" }, an array of those, or null/false, because only an element (or nothing) can be a child of the slot\'s View';
const descriptorSlotMessage =
  'is not a node-slot prop name; the diagnostic rule matches these prop names on any component, and a { "$element" } descriptor belongs in one of headerRight, inlineActions, titleContent, titleAccessory, subtitlePlaceholder, eyebrowPlaceholder';

/** A diagnostic prop value: plain JSON, which is all a manifest can carry. */
type DiagnosticProp =
  | string
  | number
  | boolean
  | null
  | DiagnosticProp[]
  | { [key: string]: DiagnosticProp };

function checkNodeSlotProps(
  props: { [key: string]: DiagnosticProp },
  ctx: RefinementCtx,
  path: (string | number)[]
): void {
  const slots: readonly string[] = SCREEN_HEADER_NODE_SLOT_NAMES;
  const visit = (name: string, value: DiagnosticProp, at: (string | number)[]): void => {
    const slot = at.find(
      (step): step is string => typeof step === 'string' && slots.includes(step)
    );
    if (slot !== undefined) {
      // The slot renders its value directly inside a `View`, so React accepts
      // only an element there: a string and a number trip the `Text` invariant,
      // a bare object throws `Objects are not valid as a React child`, and
      // `true` paints nothing but is not a slot value either. A descriptor, an
      // array of them, and null/false are the whole contract.
      if (value === null || value === false || value === undefined) return;
      if (Array.isArray(value)) {
        for (const [key, item] of value.entries()) {
          visit(name, item, [...at, key]);
        }
        return;
      }
      if (typeof value === 'object' && '$element' in value) {
        if (!ElementDescriptorSchema.safeParse(value).success) {
          // Rejected in the schema so a descriptor typo fails `prepare` before
          // any worktree is written, instead of rendering as unknown data.
          ctx.addIssue({
            code: 'custom',
            path: at,
            message: `Unknown element descriptor; the only supported kind is ${JSON.stringify(
              SAVE_ELEMENT
            )}`,
          });
        }
        return;
      }
      ctx.addIssue({
        code: 'custom',
        path: at,
        message: `${JSON.stringify(slot)} ${descriptorMessage}`,
      });
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const [key, item] of value.entries()) {
        visit(name, item, [...at, key]);
      }
      return;
    }
    if ('$element' in value) {
      ctx.addIssue({
        code: 'custom',
        path: at,
        message: `${JSON.stringify(String(at[at.length - 1]))} ${descriptorSlotMessage}`,
      });
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      visit(String(key), item, [...at, key]);
    }
  };
  for (const [name, value] of Object.entries(props)) {
    visit(name, value, [...path, name]);
  }
}
const SAVE_CLUSTER_BINDING = 'saveCluster';
/**
 * The cluster a `{ "$element": "save-cluster" }` descriptor expands to, built
 * with `createElement` from `header-balance-fixture.tsx`'s `SaveCluster`; its
 * `ICON_TARGET_BOX_CLASS` box is inlined because the generated file imports no
 * app constant, and `Text` is the shared component, not the RN primitive, so
 * the copy carries the script handling every header text gets.
 */
const SAVE_CLUSTER_SOURCE = `const ${SAVE_CLUSTER_BINDING} = React.createElement(
  View,
  { className: 'flex-row items-center' },
  React.createElement(
    Pressable,
    { accessibilityRole: 'button', accessibilityLabel: 'Fixture secondary', className: 'h-[48px] w-[48px] items-center justify-center' },
    React.createElement(Text, null, '◦')
  ),
  React.createElement(
    Pressable,
    { accessibilityRole: 'button', accessibilityLabel: 'Fixture save', className: 'h-[48px] w-[48px] items-center justify-center ms-3 rounded-full bg-accent' },
    React.createElement(Text, { className: 'text-sm font-semibold text-primary-foreground' }, 'Save')
  )
);
`;

function hasElementDescriptor(value: DiagnosticProp): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasElementDescriptor);
  if ('$element' in value) return true;
  return Object.values(value).some(hasElementDescriptor);
}

/**
 * JSON literal of the diagnostic props, element descriptors spliced as element
 * bindings, for the generated route's `createElement(Component, …)` argument.
 */
function propsLiteral(value: DiagnosticProp, indent: number): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    return `[\n${value.map(item => `${pad}  ${propsLiteral(item, indent + 2)}`).join(',\n')}\n${pad}]`;
  }
  if ('$element' in value) return SAVE_CLUSTER_BINDING;
  const entries = Object.entries(value).map(
    ([key, item]) => `${pad}  ${JSON.stringify(key)}: ${propsLiteral(item, indent + 2)}`
  );
  return `{\n${entries.join(',\n')}\n${pad}}`;
}

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
    readyTestID: z.string().min(1).max(128).optional(),
    diagnostic: z
      .object({
        component: SourcePath,
        exportName: z
          .string()
          .regex(/^(?:default|[A-Z][a-zA-Z0-9]*)$/)
          .default('default'),
        props: z.record(z.string(), z.json()).default({}),
        /**
         * Where the generated route lives, and how it presents the screen.
         *
         * 'card' is a bare route in the auth group: the screen paints straight
         * onto the window, which is right for a component and for a screen the
         * app shows that way.
         *
         * 'picker-sheet' is a route file in the signed-in shell, registering the
         * composer picker's own sheet options — the same ones
         * `apps/mobile/src/app/(app)/_layout.tsx` registers for those routes: a
         * half detent on Android, the app's own `formSheet` options elsewhere.
         * The fixture link only opens warm (`!initial`): a cold replay would
         * present the sheet as its stack's first route at the window top and
         * race the native re-presentation. A bare auth route is refused while
         * signed in, and it would measure the sheet header at the window top
         * instead of inside the sheet.
         */
        presentation: z.enum(['card', 'picker-sheet']).default('card'),
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
    for (const [index, target] of manifest.targets.entries()) {
      const diagnostic = target.diagnostic;
      if (diagnostic === undefined) continue;
      checkNodeSlotProps(diagnostic.props, ctx, ['targets', String(index), 'diagnostic', 'props']);
      if ('$element' in diagnostic.props) {
        // A diagnostic's props must be an object of prop names; a descriptor
        // at the root would replace the whole props argument in the generated
        // `createElement(Component, …)` call.
        ctx.addIssue({
          code: 'custom',
          path: ['targets', String(index), 'diagnostic', 'props', '$element'],
          message: `A diagnostic's props must be an object of prop names, not an element descriptor; ${JSON.stringify(
            '$element'
          )} belongs on one of the node-slot props`,
        });
      }
      // The cluster expansion only wires the imports the bare card route
      // writes; a sheet route would render the binding undefined, so the
      // descriptor is refused where the author sees it, at prepare.
      if (diagnostic.presentation === 'picker-sheet' && hasElementDescriptor(diagnostic.props)) {
        ctx.addIssue({
          code: 'custom',
          path: ['targets', String(index), 'diagnostic', 'presentation'],
          message: 'An element descriptor needs the bare card presentation, not picker-sheet',
        });
      }
    }
  })
  .superRefine((manifest, ctx) => {
    const ids = new Set<string>();
    for (const target of manifest.targets) {
      if (ids.has(target.id)) ctx.addIssue({ code: 'custom', message: 'Duplicate target id' });
      ids.add(target.id);
      if (target.diagnostic !== undefined) {
        const route = `/design-proof-${target.id}`;
        const screen =
          target.diagnostic.presentation === 'picker-sheet'
            ? `(app)/${route.slice(1)}`
            : `(auth)/${route.slice(1)}`;
        if (
          target.route !== route ||
          target.screen !== screen ||
          target.link !== `kiloapp://${route}`
        ) {
          ctx.addIssue({
            code: 'custom',
            message: `Diagnostic ${target.id} must use kiloapp://${route}, route ${route} and screen ${screen}`,
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
// A capture dump walks and serializes the whole screen, so a screen of a couple
// of thousand nodes writes about 1.3 MB. The document bound above is sized for the
// manifest and the preparation receipt, and applying it to a dump aborts a run
// whose measurement is legitimate; the two reads that only ever open a capture
// dump take their own bound instead.
const DUMP_LIMIT = 8 * 1024 * 1024;

const digest = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16 * LIMIT,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}
function readJson(file: string, limit = LIMIT): unknown {
  if (fs.statSync(file).size > limit) throw new Error(`Proof JSON exceeds ${limit} bytes`);
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
/**
 * The app-side probe is the gate's instrument, not product source. Both revisions
 * must therefore be measured by the same one: a branch that repairs the probe
 * would otherwise be compared against a base still running the old instrument,
 * and a probe defect in the base would read as a product defect of the branch.
 * Each revision gets the tool checkout's copy of these files, which is recorded in
 * its `prepared` list exactly like the generated route plumbing.
 */
const INSTRUMENT_FILES = [
  'apps/mobile/src/components/design-gate-probe.tsx',
  'apps/mobile/src/lib/design-gate/collect.ts',
  'apps/mobile/src/lib/design-gate/paint-state.ts',
  'apps/mobile/src/lib/design-gate/probe.ts',
  'apps/mobile/src/lib/design-gate/sampler.ts',
] as const;

/**
 * The index just after the opening brace of `redirectSystemPath`'s body. The
 * declaration's own line breaks belong to the formatter — it wraps the
 * parameters onto separate lines — so the body brace is found by scanning the
 * signature instead of matching one written form. A parentheses depth of zero
 * separates the body brace from the destructured parameter and its object type.
 */
function redirectSystemPathBodyStart(intent: string): number {
  const signature = 'export function redirectSystemPath(';
  const start = intent.indexOf(signature);
  if (start === -1) throw new Error('Unsupported native-intent diagnostic insertion point');
  let parens = 0;
  for (let index = start + signature.length - 1; index < intent.length; index += 1) {
    const character = intent[index];
    if (character === '(') parens += 1;
    else if (character === ')') parens -= 1;
    else if (character === '{' && parens === 0) return index + 1;
  }
  throw new Error('Unsupported native-intent diagnostic insertion point');
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
  for (const file of INSTRUMENT_FILES) {
    // Only a revision that would otherwise run a different probe needs the
    // instrument copied in, and only when that revision tracks the file at all:
    // an unchanged probe, or a product tree without one, keeps its own source.
    if (git(repo, ['ls-tree', commit, '--', file]).trim() === '') continue;
    const fromTool = fs.readFileSync(containedProofSource(repo, file), 'utf8');
    if (trackedFile(repo, commit, file) !== fromTool) {
      files.set(file, fromTool);
    }
  }
  for (const target of manifest.targets) {
    const diagnostic = target.diagnostic;
    if (diagnostic === undefined) continue;
    // The manifest describes data and a product component, never executable source,
    // auth replacement, environment files, or an arbitrary head-to-base copy.
    trackedFile(repo, commit, diagnostic.component);
    // A picker-sheet diagnostic lives in the signed-in shell: its route file is
    // a screen of the app's own (app) stack, the stack the real picker routes
    // are pushed onto, and it registers the composer picker's sheet options on
    // itself. A route anywhere else paints bare or presents inside a nested
    // stack that never presents a native sheet.
    const isSheet = diagnostic.presentation === 'picker-sheet';
    const file = isSheet
      ? `apps/mobile/src/app/(app)/design-proof-${target.id}.tsx`
      : `apps/mobile/src/app/(auth)/design-proof-${target.id}.tsx`;
    if (git(repo, ['ls-tree', commit, '--', file]).trim() !== '') {
      throw new Error(`Diagnostic would overwrite existing product source: ${file}`);
    }
    const componentImport = `@/${diagnostic.component.slice('apps/mobile/src/'.length, -4)}`;
    let binding = 'Component';
    if (diagnostic.exportName !== 'default') binding = `{ ${diagnostic.exportName} as Component }`;
    // A picker-sheet diagnostic presents the screen the way the app presents the
    // picker routes: a half detent on Android, its own formSheet options
    // elsewhere. Without it the screen paints onto the window and its sheet
    // header is measured at the window top, an overlap the product never paints.
    const presents = diagnostic.presentation === 'picker-sheet';
    // The element descriptor expands to a createElement cluster emitted beside
    // the component binding; the shared Text keeps the copy off the bare RN
    // primitive, with the script handling every header text gets.
    const needsCluster = hasElementDescriptor(diagnostic.props);
    const imports = presents
      ? `import React from 'react';\nimport { Redirect, Stack } from 'expo-router';\nimport { Platform } from 'react-native';\nimport { useFormSheetScreenOptions } from '@/lib/form-sheet';\n`
      : `import React from 'react';\nimport { ${
          needsCluster ? 'Pressable, ' : ''
        }View } from 'react-native';\n${
          needsCluster ? `import { Text } from '@/components/ui/text';\n` : ''
        }import { Redirect } from 'expo-router';\nimport { useSafeAreaInsets } from 'react-native-safe-area-context';\n`;
    const presentation = presents
      ? `  const sheetOptions = useFormSheetScreenOptions();\n  const options =\n    Platform.OS === 'android'\n      ? { ...sheetOptions, sheetAllowedDetents: [0.5] }\n      : sheetOptions;\n`
      : '  const insets = useSafeAreaInsets();\n';
    // A painted diagnostic measures against the window origin, so its top text
    // would draw into the status-bar inset the product screens keep clear; a
    // hook runs unconditionally first, and the wrapper fills the window while
    // the pad lifts the component inside the safe area.
    const propsArgument = needsCluster
      ? propsLiteral(diagnostic.props, 6)
      : `JSON.parse(${JSON.stringify(JSON.stringify(diagnostic.props))})`;
    const screen = presents
      ? `React.createElement(\n      React.Fragment,\n      null,\n      React.createElement(Stack.Screen, { options }),\n      React.createElement(Component, ${propsArgument})\n    )`
      : `React.createElement(\n      View,\n      { style: { flex: 1, paddingTop: insets.top } },\n      React.createElement(Component, ${propsArgument})\n    )`;
    files.set(
      file,
      `// Temporary generated design-proof diagnostic, not product source.\n${imports}${
        needsCluster ? SAVE_CLUSTER_SOURCE : ''
      }${needsCluster ? '\n' : ''}import ComponentBinding from ${JSON.stringify(componentImport)};\nexport default function DesignProofFixture() {\n${presentation}  if (!__DEV__) return React.createElement(Redirect, { href: '/(auth)/login' });\n  return ${screen};\n}\n`.replace(
        'ComponentBinding',
        binding
      )
    );
    branches.push(
      `  if (__DEV__ && !initial && ${JSON.stringify([target.link, target.route, target.route.slice(1)])}.includes(path)) return ${JSON.stringify(`/${target.screen}`)};`
    );
  }
  if (branches.length > 0) {
    const bodyStart = redirectSystemPathBodyStart(intent);
    intent = `${intent.slice(0, bodyStart)}\n${branches.join('\n')}${intent.slice(bodyStart)}`;
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
  /** Targets the probe could not read; a run that has any is inconclusive. */
  skipped?: { cell: string; target: string; reason: string }[];
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
  const skipped = outcome.skipped ?? [];
  // Every skip is named exactly once, including one whose cell never made it
  // into the matrix: a cell the runner could not even start has no CellRun, and
  // leaving it to the cell loop would hide the gap from a prepared comparison.
  const reported = new Set<string>();
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
        const skip = skipped.find(entry => entry.cell === cell.id && entry.target === target.id);
        reported.add(`${cell.id}/${target.id}`);
        failures.push(
          skip === undefined
            ? `${cell.id}/${target.id}: missing screen`
            : `${cell.id}/${target.id}: target could not be read (${skip.reason})`
        );
        continue;
      }
      const dump = parseDump(readJson(artifactPath(out, screen.dump), DUMP_LIMIT));
      if (
        cell.screens.filter(candidate => candidate.target === target.id).length !== 1 ||
        screen.link !== target.link
      ) {
        failures.push(`${cell.id}/${target.id}: duplicate or mismatched target`);
      }
      const blocked = /(?:^|\/)(?:login|sign-in|signin|splash|onboarding)(?:\/|$)/i.test(
        `${dump.env.route}/${dump.env.screen ?? ''}`
      );
      // A product screen need not carry a testID. Without a readiness marker the
      // declared route and screen (checked below) plus one laid-out node identify
      // the same prepared screen; a declared marker keeps the stricter rule that
      // this exact node is visible.
      const nodes = normalize(dump).nodes;
      const ready =
        target.readyTestID === undefined
          ? nodes.some(node => node.visibleRect[2] > 0 && node.visibleRect[3] > 0)
          : nodes.some(
              node =>
                node.probe.testID === target.readyTestID &&
                node.visibleRect[2] > 0 &&
                node.visibleRect[3] > 0
            );
      // A tab route keeps the URL at its group root, so opening it can leave the
      // route unchanged and the runner reports `link-unopened`. For a marker-less
      // target the declared screen identity below is what proves the link landed,
      // so only that rule is dropped. Every other finding still fails the target:
      // a cell config that did not apply, a language that did not switch, two
      // targets on one screen, an unsettled or misaligned or blank capture.
      const failed = outcome.findings.some(
        finding =>
          finding.cell === cell.id &&
          finding.target === target.id &&
          ['unsettled', 'capture-alignment', 'blank-frame', 'env-mismatch'].includes(finding.rule)
      );
      // A target that declares a marker keeps the original rule, where a link
      // that did not open is a failure too.
      const landingFailed =
        target.readyTestID !== undefined &&
        outcome.findings.some(
          finding =>
            finding.cell === cell.id &&
            finding.target === target.id &&
            finding.rule === 'link-unopened'
        );
      if (
        blocked ||
        !ready ||
        failed ||
        landingFailed ||
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
  for (const entry of skipped) {
    const key = `${entry.cell}/${entry.target}`;
    if (!reported.has(key)) failures.push(`${key}: target could not be read (${entry.reason})`);
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
    // Shared on purpose: a new rule id cannot be forgotten here.
    rule: z.enum(RULE_IDS),
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
const SkippedTargetSchema = z.object({
  cell: z.string(),
  target: z.string(),
  reason: z.string(),
});
const FindingsSchema = z.object({
  run: z
    .object({
      restoreError: z.string().optional(),
      // `writeArtifacts` stores the skips here, beside the other run metadata.
      skipped: z.array(SkippedTargetSchema).optional(),
    })
    .passthrough()
    .optional(),
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
export type PixelDiffOptions = {
  /** Report vertically moved content as an explanation; counts stay fixed-coordinate. */
  explainShift: boolean;
  /** Defaults to the pinned comparator; tests inject their own. */
  compare?: PixelComparator;
};
export type ComparisonResult = {
  status: 'comparable' | 'inconclusive';
  introduced: CollapsedFinding[];
  reasons: string[];
  /** The advisory pixel diff, present only when the comparison asked for it. */
  pixelDiff?: PixelDiffSummary;
};
export async function compareProof(
  preparation: Preparation,
  baseRun: string,
  headRun: string,
  out: string,
  signal?: AbortSignal,
  pixelDiff?: PixelDiffOptions
): Promise<ComparisonResult> {
  if (fs.existsSync(out))
    throw new Error(
      'Comparison output must be a new directory; prior evidence is never overwritten'
    );
  const reasons: string[] = [];
  // Reasons about the pair as a whole, not about one cell: the pixel diff may not
  // compare a pair the gate itself refused to compare.
  const pairReasons: string[] = [];
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
    if (run.run?.restoreError !== undefined) {
      reasons.push(`${revision}: device restoration failed`);
      pairReasons.push(`${revision}: device restoration failed`);
    }
    // Re-read the actual captured dumps; never trust a claimed readiness boolean.
    // The skips live under `run` in the artifact, which is where the writer put
    // them, so they are handed to the same readiness check the writer ran.
    const readiness = targetReadiness(
      { ...run, skipped: run.run?.skipped ?? [] },
      preparation.manifest,
      dir
    );
    reasons.push(
      ...readiness.map(reason => `${revision}: ${reason}`),
      ...receipt.readiness.map(reason => `${revision}: ${reason}`)
    );
    // A screen captured under a LogBox error shows the toast, not the screen, so
    // the two runs were never compared on that screen. Only the head is
    // blocking: its toast is what the critic would read, and it is a reason to
    // call the pair inconclusive rather than an introduced finding, which would
    // present a dev overlay as a product regression. A base toast with a clean
    // head is a fix, so the pair still compares; the base run's own report and
    // its exit status already carry that error.
    const overlayBlocked = run.findings
      .filter(entry => entry.rule === 'dev-overlay' && entry.severity === 'error')
      .map(entry => `${entry.cell}/${entry.target}: a LogBox overlay painted this screen`);
    if (revision === 'head')
      reasons.push(
        ...run.findings
          .filter(entry => entry.rule === 'dev-overlay' && entry.severity === 'error')
          .map(
            entry =>
              `${revision}: a LogBox error painted over ${entry.cell}/${entry.target}: ${entry.element.text?.trim() || entry.message}`
          )
      );
    // The advisory pixel diff never compares a screenshot that shows an overlay:
    // a toast diffed against a screen is not a product change. These exact cells
    // are handed over as blocked, so a sibling screen still gets its comparison.
    // This blocks the advisory cell for either revision only; the shared result
    // above still treats a base toast as a pass, exactly as it did before.
    return {
      run,
      artifacts: receipt.artifacts,
      readiness: [...readiness, ...receipt.readiness, ...overlayBlocked],
    };
  });
  const [base, head] = runs.map(entry => entry.run);
  if (
    JSON.stringify(base.cells.map(cell => [cell.id, cell.config])) !==
    JSON.stringify(head.cells.map(cell => [cell.id, cell.config]))
  ) {
    reasons.push('Matrix cells/configuration differ');
    pairReasons.push('Matrix cells/configuration differ');
  }
  const environments = (run: typeof base, dir: string): unknown[] =>
    run.cells.flatMap(cell =>
      cell.screens.map(screen => {
        const env = parseDump(readJson(artifactPath(dir, screen.dump), DUMP_LIMIT)).env;
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
  if (JSON.stringify(environments(base, baseRun)) !== JSON.stringify(environments(head, headRun))) {
    reasons.push('Captured device environments differ');
    pairReasons.push('Captured device environments differ');
  }
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
  // The advisory pixel diff runs only after the gate's own result is on disk and
  // outside its publication error path: every provenance, dump, environment and
  // readiness check above has already passed, and neither its success nor its
  // failure can alter the published comparison. It reads only the captures
  // those checks verified, hashing the bytes it actually compares.
  if (pixelDiff === undefined) return result;
  const summary = await runPixelDiffAdvisory({
    out,
    base: {
      dir: baseRun,
      artifacts: runs[0].artifacts,
      cells: base.cells,
      readiness: runs[0].readiness,
    },
    head: {
      dir: headRun,
      artifacts: runs[1].artifacts,
      cells: head.cells,
      readiness: runs[1].readiness,
    },
    explainShift: pixelDiff.explainShift,
    // The gate's own pair-wide reasons travel with the call: a per-cell pixel
    // comparison over two runs the gate refused to compare would read as clean.
    pairReasons: [...new Set(pairReasons)],
    ...(pixelDiff.compare === undefined ? {} : { compare: pixelDiff.compare }),
  });
  return { ...result, pixelDiff: summary };
}
