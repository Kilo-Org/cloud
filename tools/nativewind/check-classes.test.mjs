import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

// The checker reads the app's global.css for its token list and resolves
// react-native-css through apps/mobile's node_modules for the compiler
// assertions, so the fixture tree mirrors the repository layout and links the
// real node_modules in.
const MOBILE_ROOT = join(realpathSync(new URL('../..', import.meta.url).pathname), 'apps/mobile');

function runChecker(context, files) {
  const root = mkdtempSync(join(tmpdir(), 'check-classes-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  // Both SOURCE_DIRS entries must exist, or readdirSync throws ENOENT.
  mkdirSync(join(root, 'packages/app-shared/src'), { recursive: true });
  mkdirSync(join(root, 'tools/nativewind'), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  copyFileSync(
    new URL('./check-classes.mjs', import.meta.url),
    join(root, 'tools/nativewind/check-classes.mjs')
  );
  copyFileSync(join(MOBILE_ROOT, 'src/global.css'), join(root, 'apps/mobile/src/global.css'));
  symlinkSync(join(MOBILE_ROOT, 'node_modules'), join(root, 'apps/mobile/node_modules'), 'dir');

  const result = spawnSync(process.execPath, [join(root, 'tools/nativewind/check-classes.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ifError(result.error);
  return result;
}

function themeTokens() {
  const css = readFileSync(join(MOBILE_ROOT, 'src/global.css'), 'utf8');
  const block = css.match(/@theme inline \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(block, 'global.css keeps an @theme inline block');
  return [...block.matchAll(/--color-([a-z0-9-]+):\s*var\(--/g)].map(m => m[1]);
}

test('flags all-side padding on a scroll container own className but not on contentContainerClassName', context => {
  const result = runChecker(context, {
    'apps/mobile/src/screen.tsx': 'export const a = <ScrollView className="p-4" />;\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /<ScrollView> carries "p-4" on its own className/);
});

test('accepts all-side padding moved to contentContainerClassName', context => {
  const result = runChecker(context, {
    'apps/mobile/src/screen.tsx':
      'export const a = <ScrollView contentContainerClassName="p-4" />;\n',
  });
  assert.equal(result.status, 0);
});

test('reads padding from a cn() className expression on a scroll container', context => {
  const result = runChecker(context, {
    'apps/mobile/src/screen.tsx':
      'export const a = (\n' +
      '  <FlashList\n' +
      '    data={data}\n' +
      '    renderItem={({ item }) => <View className="px-4" />}\n' +
      "    className={cn('flex-1', selected && 'p-2')}\n" +
      '  />\n' +
      ');\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /<FlashList> carries "p-2" on its own className/);
  assert.doesNotMatch(result.stderr, /px-4/);
});

test('reads padding from a template-literal className on a scroll container', context => {
  const result = runChecker(context, {
    'apps/mobile/src/screen.tsx':
      "export const a = <ScrollView className={`flex-1 px-4 ${wide ? 'p-6' : ''}`} />;\n",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /<ScrollView> carries "p-6 px-4" on its own className/);
});

test('accepts padding on a contentContainerClassName expression', context => {
  const result = runChecker(context, {
    'apps/mobile/src/screen.tsx':
      "export const a = <ScrollView className=\"flex-1\" contentContainerClassName={cn('px-6', 'pt-4')} />;\n",
  });
  assert.equal(result.status, 0);
});

test('flags Intl formatters built with or without new', context => {
  const result = runChecker(context, {
    'apps/mobile/src/format.ts':
      "export const a = Intl.DateTimeFormat('en-US');\n" +
      "export const b = Intl.NumberFormat('en-US');\n" +
      "export const c = new Intl.DateTimeFormat('en-US');\n",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"Intl\.DateTimeFormat\(" builds its own formatter/);
  assert.match(result.stderr, /"Intl\.NumberFormat\(" builds its own formatter/);
  assert.match(result.stderr, /"new Intl\.DateTimeFormat" builds its own formatter/);
});

test('accepts Intl type references', context => {
  const result = runChecker(context, {
    'apps/mobile/src/format.ts':
      'export const options: Intl.DateTimeFormatOptions = {};\n' +
      'export let format: Intl.NumberFormat;\n',
  });
  assert.equal(result.status, 0);
});

test('reads padding from a typed scroll container tag', context => {
  const result = runChecker(context, {
    'apps/mobile/src/screen.tsx':
      'export const a = (\n' +
      '  <FlashList<Record<string, Row>>\n' +
      '    data={data}\n' +
      "    className={cn('flex-1', 'px-5')}\n" +
      '  />\n' +
      ');\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /<FlashList> carries "px-5" on its own className/);
});

test('reads a typed tag past comments and object type arguments', context => {
  const result = runChecker(context, {
    'apps/mobile/src/screen.tsx':
      'export const a = (\n' +
      '  <FlashList<{ id: string }>\n' +
      "    // the render's tail > and a stray } stay inside the comment\n" +
      '    renderItem={({ item }) => <View className="px-4" />}\n' +
      "    className={cn('flex-1', 'p-2')}\n" +
      '  />\n' +
      ');\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /<FlashList> carries "p-2" on its own className/);
  assert.doesNotMatch(result.stderr, /px-4/);
});

test('flags an Intl constructor without call parentheses after new', context => {
  const result = runChecker(context, {
    'apps/mobile/src/format.ts':
      'export const a = new Intl.DateTimeFormat;\n' +
      "export const b = new Intl.NumberFormat\n  ('en-US');\n",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"new Intl\.DateTimeFormat" builds its own formatter/);
  assert.match(result.stderr, /"new Intl\.NumberFormat" builds its own formatter/);
});

test('flags an opacity modifier on primary-disabled and hair-soft', context => {
  const result = runChecker(context, {
    'apps/mobile/src/panel.ts': 'export const a = "bg-primary-disabled/50 border-hair-soft/50";\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"bg-primary-disabled\/50"/);
  assert.match(result.stderr, /"border-hair-soft\/50"/);
});

test('flags an opacity modifier on every theme token', context => {
  const tokens = themeTokens();
  assert.ok(tokens.includes('primary-disabled'));
  assert.ok(tokens.includes('hair-soft'));
  const body = tokens
    .map(token => `export const k_${token.replace(/-/g, '_')} = "bg-${token}/50";\n`)
    .join('');
  const result = runChecker(context, { 'apps/mobile/src/all-tokens.ts': body });
  assert.equal(result.status, 1);
  for (const token of tokens) {
    assert.match(result.stderr, new RegExp(`"bg-${token}/50"`));
  }
});

test('accepts theme tokens without an opacity modifier', context => {
  const result = runChecker(context, {
    'apps/mobile/src/panel.ts':
      'export const a = "bg-primary-disabled border-hair-soft bg-good-tile-bg";\n',
  });
  assert.equal(result.status, 0);
});
