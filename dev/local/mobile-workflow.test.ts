import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('cold launch clears leftover prompts, relaunches, then settles via the shared flow', () => {
  const flow = fs.readFileSync('apps/mobile/e2e/flows/open-app.js', 'utf8');
  const trackingGuardIndex = flow.indexOf('S.TRACKING_BUTTON');
  const stopIndex = flow.indexOf('h.stopApp(BUNDLE_ID)');
  const launchIndex = flow.indexOf('h.launchApp(BUNDLE_ID)');
  const readyWaitIndex = flow.indexOf('h.waitVisible(S.ANY_STATE', launchIndex);
  const settleIndex = flow.indexOf('settleApp(ctx)');

  assert.ok(trackingGuardIndex >= 0 && trackingGuardIndex < stopIndex);
  assert.ok(stopIndex < launchIndex);
  assert.ok(launchIndex < readyWaitIndex);
  assert.ok(readyWaitIndex < settleIndex);
  // iOS keeps the 30s budget; Android under load gets a long one that healthy
  // runs never pay (the wait returns on first match).
  assert.match(flow, /launchTimeout = ctx\.platform === 'android' \? 420000 : 30000/);
  assert.match(flow, /isn\.t responding/, 'open-app should answer Android ANR dialogs');
  assert.doesNotMatch(flow.slice(readyWaitIndex), /optional: true/);
});

test('settle flow closes the Expo developer menu after its introduction', () => {
  const flow = fs.readFileSync('apps/mobile/e2e/flows/settle-app.js', 'utf8');
  const continueIndex = flow.indexOf("h.tapOn('Continue')");
  const closeGuardIndex = flow.indexOf('S.DEVMENU_OPEN, () =>', continueIndex);
  const closeIndex = flow.indexOf("h.tapOn('Close')", closeGuardIndex);

  assert.ok(continueIndex >= 0, 'settle-app should accept the developer-menu introduction');
  assert.ok(closeGuardIndex > continueIndex, 'settle-app should detect the opened menu');
  assert.ok(closeIndex > closeGuardIndex, 'settle-app should close the opened menu');
  assert.doesNotMatch(flow, /when\(ctx, 'Close'/);
});

test('launch flows never use an unidentified generic Allow selector', () => {
  const request = fs.readFileSync('apps/mobile/e2e/flows/login-request-code.js', 'utf8');
  const settle = fs.readFileSync('apps/mobile/e2e/flows/settle-app.js', 'utf8');
  const states = fs.readFileSync('apps/mobile/e2e/flows/states.js', 'utf8');

  assert.doesNotMatch(request, /Allow/);
  assert.match(states, /“Kilo” Would Like to Send You Notifications/);
  // The only Allow tap in the launch flows is guarded by the notification prompt.
  assert.match(settle, /S.NOTIF_PROMPT, \(\) => h\.tapOn\('Allow'\)/);
});

test('login verification does not pay a fixed optional notification wait', () => {
  const verify = fs.readFileSync('apps/mobile/e2e/flows/login-verify-code.js', 'utf8');

  assert.doesNotMatch(verify, /optional: true/);
  assert.match(verify, /S\.NOTIF_PROMPT\.source, S\.HOME\.source/);
});

test('login request establishes a signed-out baseline before requesting a fresh OTP', () => {
  const request = fs.readFileSync('apps/mobile/e2e/flows/login-request-code.js', 'utf8');
  assert.ok(request.indexOf('await logout(ctx)') < request.indexOf("h.tapOn('Send sign-in code')"));
});

test('login retry resets an already-open verification screen to the email form', () => {
  const logout = fs.readFileSync('apps/mobile/e2e/flows/logout.js', 'utf8');
  const verificationIndex = logout.indexOf("when(ctx, 'Verify code'");
  const backIndex = logout.indexOf("h.tapOn('Back')", verificationIndex);
  const signedOutGuardIndex = logout.indexOf('whenNot(ctx, S.LOGIN', verificationIndex);

  assert.ok(verificationIndex >= 0);
  assert.ok(backIndex > verificationIndex);
  assert.ok(signedOutGuardIndex > backIndex);
  assert.match(logout, /assertVisible\('you@example\.com'\)/);
});

test('login reuses the app state established by logout instead of relaunching each step', () => {
  const request = fs.readFileSync('apps/mobile/e2e/flows/login-request-code.js', 'utf8');
  const verify = fs.readFileSync('apps/mobile/e2e/flows/login-verify-code.js', 'utf8');
  const login = fs.readFileSync('apps/mobile/e2e/login.sh', 'utf8');

  assert.doesNotMatch(request, /open-app/);
  assert.doesNotMatch(verify, /open-app/);
  assert.doesNotMatch(login, /appium\.sh.*logout\.js/);
  assert.doesNotMatch(login, /login-assert-home\.js/);
});

test('login polls the local outbox without one-second latency', () => {
  const login = fs.readFileSync('apps/mobile/e2e/login.sh', 'utf8');
  assert.match(login, /sleep 0\.25/);
});

test('parallel platform logins default to separate accounts', () => {
  const login = fs.readFileSync('apps/mobile/e2e/login.sh', 'utf8');
  assert.match(login, /emulator-\*\) PLATFORM=android/);
  assert.match(login, /e2e-mobile-\$\{WORKTREE_SLUG\}-\$\{PLATFORM\}@example\.com/);
});

test('shared launch prompt grace periods total at most five seconds', () => {
  const settle = fs.readFileSync('apps/mobile/e2e/flows/settle-app.js', 'utf8');
  const openApp = fs.readFileSync('apps/mobile/e2e/flows/open-app.js', 'utf8');
  const optionalWaits = [...settle.matchAll(/timeout: (\d+), optional: true/g)].map(match =>
    Number(match[1])
  );

  assert.deepEqual(optionalWaits, [3000]);
  assert.doesNotMatch(openApp, /optional: true/);
});

test('settle flow handles the exact iOS external-app prompt within existing waits', () => {
  const states = fs.readFileSync('apps/mobile/e2e/flows/states.js', 'utf8');
  const flow = fs.readFileSync('apps/mobile/e2e/flows/settle-app.js', 'utf8');
  const timeouts = [...flow.matchAll(/timeout: (\d+)/g)].map(match => Number(match[1]));

  assert.match(states, /Open this page in "Kilo"\\\?/, 'states should name the Safari wording');
  assert.match(states, /Open in \["“”\]Kilo/, 'states should name the SpringBoard wording');
  assert.match(flow, /when\(ctx, S\.OPEN_IN_KILO, \(\) => h\.tapOn\('Open'\)\)/);
  assert.deepEqual(
    timeouts,
    [15000, 3000, 5000, 5000, 5000, 5000, 15000],
    'settle-app should keep its wait budget and add no fixed wait'
  );
  assert.doesNotMatch(flow, /when\(ctx, '(?:Allow|Open)'/);
  assert.doesNotMatch(flow, /tapOn\('(?:Allow\|Open|Open\|Allow)'\)/);
});

test('settle flow polls for the next state immediately after every prompt answer', () => {
  const flow = fs.readFileSync('apps/mobile/e2e/flows/settle-app.js', 'utf8');
  const steps = [
    ["h.tapOn('Open')", 'S.TRACKING_PROMPT.source'],
    ['h.tapOn(S.TRACKING_BUTTON)', 'S.DEVMENU_INTRO.source'],
    ["h.tapOn('Continue')", 'S.DEVMENU_OPEN.source'],
    ["h.tapOn('Close')", 'S.NOTIF_PROMPT.source'],
  ];

  let searchFrom = 0;
  for (const [action, nextState] of steps) {
    const actionIndex = flow.indexOf(action, searchFrom);
    assert.ok(actionIndex >= searchFrom, `settle-app should include ${action}`);
    // The next waitVisible gate sits between this action and the next step.
    const gateIndex = flow.indexOf('h.waitVisible(', actionIndex);
    const gate = flow.slice(gateIndex, flow.indexOf('}', gateIndex));
    assert.ok(gateIndex > actionIndex, `settle-app should gate after ${action}`);
    assert.match(gate, new RegExp(nextState.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `settle-app should poll for ${nextState} after ${action}`);
    assert.match(gate, /timeout: 5000/);
    assert.doesNotMatch(gate, /optional: true/);
    searchFrom = gateIndex;
  }
});

test('helper-driven logout settles the app already launched by preflight', () => {
  const logout = fs.readFileSync('apps/mobile/e2e/flows/logout.js', 'utf8');
  const settle = fs.readFileSync('apps/mobile/e2e/flows/settle-app.js', 'utf8');

  assert.match(logout, /require\('\.\/settle-app'\)/);
  assert.doesNotMatch(logout, /open-app/);
  assert.doesNotMatch(settle, /stopApp|launchApp/);
});

test('logout skips prompt settling for stable signed-in and signed-out states', () => {
  const logout = fs.readFileSync('apps/mobile/e2e/flows/logout.js', 'utf8');
  const settleIndex = logout.indexOf('settleApp(ctx)');

  assert.ok(logout.indexOf('whenNot(ctx, S.LOGIN') < settleIndex);
  assert.ok(logout.indexOf('whenNot(ctx, S.HOME') < settleIndex);
});

test('tab layout exposes the exact documented accessibility labels', () => {
  const layout = fs.readFileSync('apps/mobile/src/app/(app)/(tabs)/_layout.tsx', 'utf8');

  for (const label of [
    'Home, tab, 1 of 4',
    'KiloClaw, tab, 2 of 4',
    'Agents, tab, 3 of 4',
    'Profile, tab, 4 of 4',
  ]) {
    assert.match(layout, new RegExp(`tabBarAccessibilityLabel: '${label}'`));
  }
});

test('login preflight reconnects the claimed iOS device to this worktree Metro URL', () => {
  const preflight = fs.readFileSync('apps/mobile/e2e/preflight.sh', 'utf8');

  assert.match(preflight, /pnpm -s dev:mobile:simulator claim/);
  assert.match(preflight, /pnpm -s dev:capture mobile/);
  assert.match(preflight, /exp\+kilo-app:\/\/expo-development-client\/\?url=/);
  assert.match(preflight, /session-ingest secret readiness probe failed/);
  assert.match(preflight, /Metro manifest API URL is/);
  assert.match(preflight, /dev:mobile:android claim/);
  assert.match(preflight, /adb -s "\$DEVICE" reverse/);
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
  assert.match(envOutput, /input: `\$\{value\}\\n`/);
  assert.match(envOutput, /Failed to create Secrets Store secret/);
});

test('dev CLI shares only the Docker proxy port between worktrees', () => {
  const cli = fs.readFileSync('dev/local/cli.ts', 'utf8');

  assert.match(cli, /name === 'kiloclaw-docker-tcp'/);
  assert.match(cli, /Refusing to share occupied worktree service ports/);
});
