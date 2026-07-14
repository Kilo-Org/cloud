import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('login waits for the delayed Expo developer menu after launching Kilo', () => {
  const flow = fs.readFileSync('apps/mobile/e2e/flows/open-app.yaml', 'utf8');
  const launchIndex = flow.indexOf("text: 'Kilo'");
  const developerMenuWaitIndex = flow.indexOf(
    "visible: 'This is the developer menu.*'",
    launchIndex
  );
  const continueIndex = flow.indexOf("tapOn: 'Continue'", developerMenuWaitIndex);

  assert.ok(launchIndex >= 0);
  assert.ok(developerMenuWaitIndex > launchIndex);
  assert.ok(continueIndex > developerMenuWaitIndex);
  assert.match(flow.slice(developerMenuWaitIndex - 80, continueIndex), /timeout: 15000/);
  assert.match(flow.slice(developerMenuWaitIndex - 80, continueIndex), /optional: true/);
});

test('login flows never use an unidentified generic Allow selector', () => {
  const request = fs.readFileSync('apps/mobile/e2e/flows/login-request-code.yaml', 'utf8');
  const openApp = fs.readFileSync('apps/mobile/e2e/flows/open-app.yaml', 'utf8');

  assert.doesNotMatch(request, /visible: 'Allow'/);
  assert.match(openApp, /“Kilo” Would Like to Send You Notifications/);
});

test('mobile workflow documents hierarchy-derived tab selectors', () => {
  const runbook = fs.readFileSync('apps/mobile/e2e/AGENTS.md', 'utf8');

  assert.match(runbook, /Agents, tab, 3 of 4/);
  assert.match(runbook, /Never guess a selector from the visible label/);
  assert.match(runbook, /pnpm dev:capture mobile/);
  assert.match(runbook, /dev:mobile:simulator claim/);
});

test('login preflight reconnects the claimed iOS device to this worktree Metro URL', () => {
  const preflight = fs.readFileSync('apps/mobile/e2e/preflight.sh', 'utf8');

  assert.match(preflight, /pnpm -s dev:mobile:simulator claim/);
  assert.match(preflight, /pnpm -s dev:capture mobile/);
  assert.match(preflight, /exp\+kilo-app:\/\/expo-development-client\/\?url=/);
  assert.match(preflight, /session-ingest secret readiness probe failed/);
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
  });

  assert.equal(env.adb, '/opt/homebrew/share/android-commandlinetools/platform-tools/adb');
  assert.equal(env.emulator, '/opt/homebrew/share/android-commandlinetools/emulator/emulator');
  assert.equal(env.javaHome, '/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home');
  assert.match(env.path, /android-commandlinetools\/platform-tools/);
});

test('env sync refreshes source-backed Wrangler secrets through completed stdin prompts', () => {
  const plan = fs.readFileSync('dev/local/env-sync/plan.ts', 'utf8');
  const envOutput = fs.readFileSync('dev/local/env-sync/output.ts', 'utf8');

  assert.match(plan, /Recreate source-backed secrets/);
  assert.match(envOutput, /input: `\$\{value\}\\n`/);
  assert.match(envOutput, /Failed to create Secrets Store secret/);
});
