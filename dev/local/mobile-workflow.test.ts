import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('tab layout derives accessibility labels from the visible tab count', () => {
  const layout = fs.readFileSync('apps/mobile/src/app/(app)/(tabs)/_layout.tsx', 'utf8');

  assert.match(layout, /const tabCount = showKiloClawTab \? 4 : 3;/);
  assert.match(
    layout,
    /tabBarAccessibilityLabel: tabAccessibilityLabel\(t\('tabs\.home'\), 1, tabCount\)/
  );
  assert.match(
    layout,
    /tabBarAccessibilityLabel: tabAccessibilityLabel\(t\('tabs\.kiloclaw'\), 2, tabCount\)/
  );
  assert.match(
    layout,
    /tabBarAccessibilityLabel: tabAccessibilityLabel\(\s*t\('tabs\.agents'\),\s*showKiloClawTab \? 3 : 2,\s*tabCount\s*\)/
  );
  assert.match(
    layout,
    /tabBarAccessibilityLabel: tabAccessibilityLabel\(\s*t\('tabs\.profile'\),\s*showKiloClawTab \? 4 : 3,\s*tabCount\s*\)/
  );
});

test('Android tooling is resolved independently of the agent PATH', async () => {
  const { resolveAndroidEnvironment } = await import('./mobile-android');
  const env = resolveAndroidEnvironment({
    home: '/Users/test',
    path: '/usr/bin:/bin',
    existingPaths: new Set([
      '/opt/homebrew/share/android-commandlinetools/platform-tools/adb',
      '/opt/homebrew/share/android-commandlinetools/emulator/emulator',
      '/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest/bin/sdkmanager',
      '/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home/bin/java',
    ]),
    javaMajor: () => 17,
  });

  assert.equal(env.adb, '/opt/homebrew/share/android-commandlinetools/platform-tools/adb');
  assert.equal(env.emulator, '/opt/homebrew/share/android-commandlinetools/emulator/emulator');
  assert.equal(env.javaHome, '/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home');
  assert.match(env.path, /android-commandlinetools\/platform-tools/);
});

test('Android cached native builds apply resolved tooling', () => {
  const android = fs.readFileSync('dev/local/mobile-android.ts', 'utf8');

  assert.match(android, /'build'/);
  assert.match(android, /runAndroidBuild/);
  assert.match(android, /withNativeBuildSemaphore/);
  assert.match(android, /app:assembleDebug/);
  assert.match(android, /path\.join\(worktreeRoot, 'apps\/mobile'\)/);
});

test('Android tooling rejects a non-Java-17 JAVA_HOME', async () => {
  const { resolveAndroidEnvironment } = await import('./mobile-android');
  assert.throws(
    () =>
      resolveAndroidEnvironment({
        home: '/Users/test',
        path: '/usr/bin:/bin',
        existingPaths: new Set([
          '/opt/homebrew/share/android-commandlinetools/platform-tools/adb',
          '/opt/homebrew/share/android-commandlinetools/emulator/emulator',
          '/java/bin/java',
        ]),
        javaMajor: () => 21,
      }),
    /missing JDK 17/
  );
});

test('Android device ownership uses exclusive worktree claims', () => {
  const android = fs.readFileSync('dev/local/mobile-android.ts', 'utf8');
  assert.match(android, /flag: 'wx'/);
  assert.match(android, /claimAndroidDevice/);
  assert.match(android, /releaseAndroidDevice/);
});

test('env sync refreshes source-backed Wrangler secrets through completed stdin prompts', () => {
  const plan = fs.readFileSync('dev/local/env-sync/plan.ts', 'utf8');
  const envOutput = fs.readFileSync('dev/local/env-sync/output.ts', 'utf8');

  assert.match(plan, /Recreate source-backed secrets/);
  assert.match(envOutput, /`\$\{value\}\\n`/);
  assert.match(envOutput, /child\.stdin\.end\(input\)/);
  assert.match(envOutput, /Failed to create Secrets Store secret/);
});

test('dev CLI shares only the Docker proxy port between worktrees', () => {
  const cli = fs.readFileSync('dev/local/cli.ts', 'utf8');

  assert.match(cli, /name === 'kiloclaw-docker-tcp'/);
  assert.match(cli, /Refusing to share occupied worktree service ports/);
});
