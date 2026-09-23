// Source guard for the "one single-line box" class: a single-line text field
// must render the shared `Input` (`src/components/ui/input.tsx`), never a raw
// `<TextInput>`. The raw control draws its placeholder and its value from two
// different boxes — on Android the value starts at the top of a taller box
// while the placeholder is centred — so the class can only be closed at the one
// shared component. A raw single-line field anywhere else fails this guard.
//
// Multiline composers are a different control: they keep their own box (an
// explicit `leading-*`, their own `textAlignVertical`) and cannot use the
// single-line shared box, so they render the raw control with `multiline`. They
// are listed in `ALLOWLIST` with the reason they stay raw, and every raw
// `<TextInput>` in a listed file must carry the `multiline` token, so a new
// single-line field inside an allowlisted composer still fails.
//
// One more exemption exists, and it is not an allowlist: `OWNER_BOUNDARY_INPUTS`
// pins the pre-existing single-line fields inside the Kilo Claw owner boundary
// (`src/components/kiloclaw/**`, `src/app/(app)/kiloclaw/**`). The 2026-09-02
// owner-boundary hard gate forbids this section from changing that subtree, so
// those fields are the Kilo Claw owner's to migrate. Each entry names one
// `path:line`, so only the field that exists today passes: a new single-line
// field in one of those files is reported again, and so is one that moves.
//
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readdirSync, readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { dirname, join, relative } from 'node:path';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** apps/mobile, so a report reads `src/components/Foo.tsx:12`. */
const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC_ROOT = join(APP_ROOT, 'src');

/** The one shared single-line box. It holds the app's raw single-line TextInput. */
const SHARED_INPUT_PATH = 'src/components/ui/input.tsx';

/**
 * The multiline composers that legitimately stay raw, each with why. A raw
 * `<TextInput>` in one of these files must carry the `multiline` token; a new
 * single-line field in one of them is still a violation.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {
  'src/app/(app)/(tabs)/(3_profile)/code-reviewer/[scope]/[platform]/(edit)/instructions.tsx':
    'multiline instruction editor (`h-32`, `leading-5`)',
  'src/components/agents/chat-composer-input-row.tsx': 'multiline prompt composer',
  'src/components/code-reviewer/manual-review-screen.tsx':
    'multiline `h-24` summary editor (its single-line URL field uses the shared box)',
  'src/components/kilo-chat/message-input-view.tsx': 'multiline chat composer',
  'src/components/kiloclaw/version-pin-row.tsx': 'multiline pin editor (:87-99)',
  'src/components/pr-review/discussion/reply-input.tsx': 'multiline reply composer',
  'src/components/pr-review/merge/pr-merge-sheet-parts.tsx':
    'multiline message body (and its multiline title field)',
  'src/components/pr-review/pr-review-comment-composer-parts.tsx': 'multiline comment body',
  'src/components/pr-review/pr-review-pending-comment-row.tsx': 'multiline pending comment',
  'src/components/security-agent/dismiss-finding-screen.tsx':
    'multiline dismissal comment (:264-267)',
  'src/components/ui/selectable-text.tsx': 'read-only multiline selectable text (:37-42)',
  'src/components/voice-test-field.tsx': 'multiline voice test transcript',
};

/**
 * Pre-existing raw single-line fields inside the Kilo Claw owner boundary.
 *
 * This is deliberately not part of `ALLOWLIST`: it is not a multiline composer,
 * it is a file this section's owner boundary forbids it to change. The Kilo Claw
 * owner migrates those fields in their own slice; until then the guard records
 * the leak instead of hiding it. The key is one `path:line`, so the exemption
 * covers only the field that exists today — a new single-line field in one of
 * these files, or the existing one moving, is a violation again — and the test
 * below fails when an entry no longer names a raw field, so the record cannot
 * outlive the thing it records.
 */
const OWNER_BOUNDARY_INPUTS: Readonly<Record<string, string>> = {
  'src/app/(app)/kiloclaw/[instance-id]/settings/model-list.tsx:162':
    'Kilo Claw owner boundary: the models search field stays raw until the Kilo Claw owner migrates it',
  'src/components/kiloclaw/onboarding/identity-step.tsx:312':
    'Kilo Claw owner boundary: the onboarding bot-name field stays raw until the Kilo Claw owner migrates it',
  'src/components/kiloclaw/onboarding/identity-step.tsx:421':
    'Kilo Claw owner boundary: the onboarding location field stays raw until the Kilo Claw owner migrates it',
};

/**
 * A JSX `<TextInput` opening. The lookbehind drops a type reference such as
 * `useRef<TextInput>` or `RefObject<TextInput | null>`: the `<` or a word
 * character precedes it, which JSX never does.
 */
const JSX_TEXT_INPUT = /(?<![<\w])<TextInput\b/g;

/** The `multiline` prop, as a whole token. */
const MULTILINE = /\bmultiline\b/;

type RawInput = { line: number; block: string };

/**
 * Finds every raw JSX `<TextInput` in `files` that may not stay raw.
 *
 * A path is fine when it is the shared single-line box, or when it is an
 * allowlisted multiline composer and the occurrence carries `multiline`. A
 * `path:line` recorded in `OWNER_BOUNDARY_INPUTS` is deferred, not allowed.
 * Everything else is reported as `path:line`, in path order.
 */
export function unsharedSingleLineInputs(files: Record<string, string>): string[] {
  return Object.keys(files)
    .toSorted()
    .flatMap(path => {
      const source = files[path];
      if (!isScanned(path) || source === undefined) {
        return [];
      }
      return rawTextInputs(source)
        .filter(raw => !isAllowedRawInput(path, raw))
        .map(raw => `${path}:${raw.line}`);
    });
}

/** The product sources the guard owns: no test file, no test support. */
function isScanned(path: string): boolean {
  return (
    path.startsWith('src/') &&
    (path.endsWith('.ts') || path.endsWith('.tsx')) &&
    !path.includes('.test.') &&
    !path.startsWith('src/test/')
  );
}

function isAllowedRawInput(path: string, raw: RawInput): boolean {
  if (path === SHARED_INPUT_PATH) {
    return true;
  }
  if (Object.hasOwn(OWNER_BOUNDARY_INPUTS, `${path}:${raw.line}`)) {
    return true;
  }
  return Object.hasOwn(ALLOWLIST, path) && MULTILINE.test(raw.block);
}

/** Every raw `<TextInput` opening in one source, with the line it opens on. */
function rawTextInputs(source: string): RawInput[] {
  const code = stripComments(source);
  const found: RawInput[] = [];
  for (const match of code.matchAll(JSX_TEXT_INPUT)) {
    const start = match.index;
    // A `<` (with only whitespace between) before the tag is a type argument —
    // `RefObject<\n  TextInput | null>` — never JSX, which puts `>`, `(`, `,`,
    // `=` or whitespace there.
    if (!/<\s*$/.test(code.slice(0, start))) {
      found.push({
        line: code.slice(0, start).split('\n').length,
        block: openingTag(code, start),
      });
    }
  }
  return found;
}

/** The JSX opening tag at `start`, through the `>` that closes it. */
function openingTag(code: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < code.length; index += 1) {
    const ch = code.charAt(index);
    if (quote !== null) {
      if (ch === '\\') {
        index += 1;
      } else if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
    } else if (ch === '>' && depth === 0) {
      return code.slice(start, index + 1);
    }
  }
  return code.slice(start);
}

/**
 * Removes block and line comments while keeping line numbers, and leaves
 * string and template literals alone so a `//` inside a URL stays code.
 */
function stripComments(source: string): string {
  let code = '';
  let index = 0;
  let quote: string | null = null;
  while (index < source.length) {
    const ch = source.charAt(index);
    const next = source.charAt(index + 1);
    if (quote !== null) {
      code += ch;
      if (ch === '\\') {
        code += next;
        index += 2;
      } else {
        if (ch === quote) {
          quote = null;
        }
        index += 1;
      }
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      code += ch;
      index += 1;
    } else if (ch === '/' && next === '/') {
      while (index < source.length && source.charAt(index) !== '\n') {
        index += 1;
      }
    } else if (ch === '/' && next === '*') {
      index += 2;
      while (
        index < source.length &&
        !(source.charAt(index) === '*' && source.charAt(index + 1) === '/')
      ) {
        if (source.charAt(index) === '\n') {
          code += '\n';
        }
        index += 1;
      }
      index += 2;
    } else {
      code += ch;
      index += 1;
    }
  }
  return code;
}

/** The real product tree, keyed as the guard reports it (`src/...`). */
function readSourceTree(dir: string = SRC_ROOT): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, readSourceTree(full));
    } else {
      const path = relative(APP_ROOT, full);
      if (isScanned(path)) {
        files[path] = readFileSync(full, 'utf8');
      }
    }
  }
  return files;
}

/** A single-line raw field in a component that is not the shared box. */
const RAW_SINGLE_LINE = [
  "import { TextInput } from 'react-native';",
  '',
  'export function Whatever() {',
  '  return <TextInput placeholder="x" />;',
  '}',
  '',
].join('\n');

/** The same field routed through the shared component. */
const ROUTED_SINGLE_LINE = [
  "import { Input } from '@/components/ui/input';",
  '',
  'export function Whatever() {',
  '  return <Input placeholder="x" />;',
  '}',
  '',
].join('\n');

describe('single-line input guard', () => {
  it('routes every raw single-line TextInput through the shared input box', () => {
    const files = readSourceTree();
    expect(Object.keys(files).length).toBeGreaterThan(100);
    expect(
      unsharedSingleLineInputs(files),
      'render single-line fields with @/components/ui/input, add a reasoned multiline allowlist entry, or record the field in OWNER_BOUNDARY_INPUTS'
    ).toEqual([]);
  });

  it('still sees the shared box, so the scan cannot pass by finding nothing', () => {
    const files = readSourceTree();
    const shared = files[SHARED_INPUT_PATH];
    expect(shared).toBeDefined();
    expect(rawTextInputs(shared ?? '').length).toBeGreaterThan(0);
  });

  it('reports a raw single-line TextInput', () => {
    expect(unsharedSingleLineInputs({ 'src/components/Whatever.tsx': RAW_SINGLE_LINE })).toEqual([
      'src/components/Whatever.tsx:4',
    ]);
  });

  it('accepts the same field routed through the shared input', () => {
    expect(unsharedSingleLineInputs({ 'src/components/Whatever.tsx': ROUTED_SINGLE_LINE })).toEqual(
      []
    );
  });

  it('keeps an allowlisted composer multiline-only', () => {
    const allowlisted = 'src/components/agents/chat-composer-input-row.tsx';
    const multiline = [
      "import { TextInput } from 'react-native';",
      '',
      'export function Composer() {',
      '  return <TextInput multiline placeholder="x" />;',
      '}',
      '',
    ].join('\n');
    expect(unsharedSingleLineInputs({ [allowlisted]: multiline })).toEqual([]);
    expect(unsharedSingleLineInputs({ [allowlisted]: RAW_SINGLE_LINE })).toEqual([
      `${allowlisted}:4`,
    ]);
  });

  it('leaves a type reference or a comparison alone', () => {
    const typed = [
      "import { useRef } from 'react';",
      "import { type TextInput } from 'react-native';",
      '',
      'export function Whatever() {',
      '  const ref = useRef<TextInput>(null);',
      '  return ref;',
      '}',
      '',
    ].join('\n');
    expect(unsharedSingleLineInputs({ 'src/components/Whatever.tsx': typed })).toEqual([]);
  });

  it('ignores a commented-out field', () => {
    const commented = [
      'export function Whatever() {',
      '  // return <TextInput placeholder="x" />;',
      '  return null;',
      '}',
      '',
    ].join('\n');
    expect(unsharedSingleLineInputs({ 'src/components/Whatever.tsx': commented })).toEqual([]);
  });

  it('ignores test files and test support', () => {
    expect(
      unsharedSingleLineInputs({
        'src/components/Whatever.test.tsx': RAW_SINGLE_LINE,
        'src/test/whatever.tsx': RAW_SINGLE_LINE,
      })
    ).toEqual([]);
  });

  it('names an existing file and a written reason for every allowlist entry', () => {
    const files = readSourceTree();
    for (const [path, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.trim(), `${path} needs a reason`).not.toBe('');
      expect(files[path], `${path} does not exist`).toBeDefined();
    }
  });

  it('keeps every raw TextInput in an allowlisted file multiline', () => {
    const files = readSourceTree();
    for (const path of Object.keys(ALLOWLIST)) {
      const blocks = rawTextInputs(files[path] ?? '');
      expect(blocks.length, `${path} is allowlisted but holds no raw TextInput`).toBeGreaterThan(0);
      for (const raw of blocks) {
        expect(raw.block, `${path}:${raw.line} must carry the multiline token`).toMatch(MULTILINE);
      }
    }
  });

  it('records only the owner-boundary field that exists today', () => {
    const files = readSourceTree();
    for (const [location, reason] of Object.entries(OWNER_BOUNDARY_INPUTS)) {
      expect(reason.trim(), `${location} needs a reason`).not.toBe('');
      const path = location.slice(0, location.lastIndexOf(':'));
      expect(files[path], `${location} does not exist`).toBeDefined();
      const recorded = rawTextInputs(files[path] ?? '').some(
        raw => `${path}:${raw.line}` === location
      );
      expect(recorded, `${location} no longer names a raw TextInput`).toBe(true);
    }
  });

  it('still reports a new single-line field in an owner-boundary file', () => {
    const path = 'src/components/kiloclaw/onboarding/identity-step.tsx';
    expect(
      OWNER_BOUNDARY_INPUTS[`${path}:4`],
      'the synthetic violation must sit on a line no entry records'
    ).toBeUndefined();
    expect(unsharedSingleLineInputs({ [path]: RAW_SINGLE_LINE })).toEqual([`${path}:4`]);
  });
});
