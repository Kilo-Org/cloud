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
  // Long budgets that healthy runs never pay (the wait returns on first
  // match), consumed in short slices so an ANR dialog is answered promptly
  // instead of after the whole budget.
  assert.match(flow, /launchBudget = ctx\.platform === 'android' \? 420000 : 120000/);
  assert.match(flow, /Date\.now\(\) >= deadline\) throw/, 'the sliced wait must stay bounded');
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
  // Signing out is an API call plus navigation; the terminal check waits.
  assert.match(logout, /waitVisible\('you@example\.com', \{ timeout: 15000 \}\)/);
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
    [3000, 5000, 5000, 5000, 5000, 15000],
    'settle-app should keep its wait budget and add no fixed wait'
  );
  // The first wait is platform-aware and long-but-early-return on both
  // platforms: reconnect bundling under parallel-workflow host load needs it.
  assert.match(flow, /timeout: ctx\.platform === 'android' \? 300000 : 120000/);
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
    assert.match(
      gate,
      new RegExp(nextState.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `settle-app should poll for ${nextState} after ${action}`
    );
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

test('github-stub remove_env_line validates grep exit code before mv', () => {
  const stub = fs.readFileSync('apps/mobile/e2e/github-stub.sh', 'utf8');
  const fn = stub.slice(
    stub.indexOf('remove_env_line()'),
    stub.indexOf('\n}', stub.indexOf('remove_env_line()')) + 2
  );

  // Must capture the exit code (not || true which masks all errors).
  assert.match(fn, /\|\| code=\$\?/, 'should capture grep exit code');
  // Exit > 1 must trigger cleanup and error, not mv.
  assert.match(fn, /code" -gt 1/, 'should guard against exit > 1');
  assert.match(fn, /rm -f.*tmp\.\$\$/, 'should remove temp file on error');
  assert.match(fn, /return 1/, 'should propagate the error');
  // Exit 0 or 1 is valid; the mv must be outside the guard.
  const guardIdx = fn.indexOf('"$code" -gt 1');
  const mvIdx = fn.lastIndexOf('mv');
  assert.ok(mvIdx > guardIdx, 'mv must follow the error guard, not sit inside it');
});

test('github-stub claim_port validates mtime as numeric before arithmetic', () => {
  const stub = fs.readFileSync('apps/mobile/e2e/github-stub.sh', 'utf8');
  const fn = stub.slice(
    stub.indexOf('claim_port()'),
    stub.indexOf('\n}', stub.indexOf('claim_port()')) + 2
  );

  // Each stat variant must be captured in its own m=$(...) assignment,
  // separated by shell-level || — not combined inside one $(...).
  // If GNU stat -f writes non-numeric stdout before failing, the combined
  // form concatenates both outputs into one variable, defeating the guard.
  assert.match(fn, /stat -f %m/);
  assert.match(fn, /stat -c %Y/);
  assert.doesNotMatch(fn, /\$\(stat -f %m.*\|\| stat -c %Y/);
  // The "echo date +%s" fallback (treating unknown age as universally stale
  // when stat fails) is removed. date +%s in the arithmetic line (age
  // calculation from a validated mtime) is legitimate and must remain.
  assert.doesNotMatch(fn, /echo "\$\(date \+%s\)"/);
  // Must validate mtime is numeric before arithmetic.
  assert.match(fn, /case "\$m" in/);
  assert.match(fn, /\*\[\!0-9\]\*/);
  // Non-numeric mtime must return 1 (not stale enough to reclaim).
  assert.match(fn, /-z "\$m".*return 1/);
});

test('github-stub session name slugifies unsafe worktree basenames', () => {
  const stub = fs.readFileSync('apps/mobile/e2e/github-stub.sh', 'utf8');

  // SESSION uses a safe slug, not the raw basename.
  assert.match(stub, /RAW_BASENAME="\$\(basename "\$REPO_ROOT"\)"/);
  // Newline must be stripped from basename before slugification.
  assert.match(stub, /\$\{RAW_BASENAME%[^}]*\\n/);
  assert.match(stub, /STUB_SLUG="\$\(printf '%s' "\$RAW_BASENAME" \| tr -c 'A-Za-z0-9_' '-'\)"/);
  assert.match(stub, /SESSION="kilo-e2e-github-stub-\$STUB_SLUG"/);
  // State and lock directories use a stable hash of the raw basename.
  assert.match(stub, /DIR_HASH="\$\(printf '%s' "\$RAW_BASENAME" \| shasum/);
  assert.match(stub, /STATE_DIR=.*DIR_HASH/);
  assert.match(stub, /kilo-e2e-github-stub-locks.*DIR_HASH/);
});

test('github-stub slug adds hash when slugified name differs from raw basename', () => {
  const stub = fs.readFileSync('apps/mobile/e2e/github-stub.sh', 'utf8');

  // When the slug differs from the raw basename, a short hash is appended.
  assert.match(stub, /\[ "\$STUB_SLUG" != "\$RAW_BASENAME" \]/);
  assert.match(stub, /STUB_SLUG="\$\{STUB_SLUG\}-.*shasum/);
});

test('github-stub session name has no artificial trailing dash from basename newline', () => {
  const stub = fs.readFileSync('apps/mobile/e2e/github-stub.sh', 'utf8');

  // Basename newline stripped before tr: a simple basename produces no dash.
  assert.match(stub, /\$\{RAW_BASENAME%[^}]*\\n/);
});

test('github-stub cleanup_start does not abort on remove_env_line failure', () => {
  const stub = fs.readFileSync('apps/mobile/e2e/github-stub.sh', 'utf8');
  const fnStart = stub.indexOf('cleanup_start() {');
  const fnEnd = stub.indexOf('trap cleanup_start EXIT');
  const body = stub.slice(fnStart, fnEnd);

  // remove_env_line in cleanup_start must use || true to defer failure past
  // state cleanup and port release under set -e.
  assert.match(body, /remove_env_line \|\| true/);
  // rm -rf STATE_DIR must appear after remove_env_line.
  const removeLine = body.indexOf('remove_env_line');
  const rmState = body.indexOf('rm -rf "$STATE_DIR"');
  assert.ok(rmState > removeLine, 'state cleanup must follow env line removal');
  // release_port must come after the inner fi (outside the failure guard).
  const releaseIdx = body.indexOf('release_port');
  const fiIdx = body.lastIndexOf('fi');
  assert.ok(releaseIdx > fiIdx, 'port release must be outside the failure guard');
});

test('github-stub stop does not abort on remove_env_line failure', () => {
  const stub = fs.readFileSync('apps/mobile/e2e/github-stub.sh', 'utf8');

  // remove_env_line in stop must use || true so rm -rf still executes.
  assert.match(stub, /remove_env_line \|\| true/);
  // In the stop block, rm -rf must appear after remove_env_line.
  const stopIdx = stub.indexOf('\n  stop)');
  const nextStar = stub.indexOf('\n  *)', stopIdx);
  const stopBlock = stub.slice(stopIdx, nextStar);
  const removeLine = stopBlock.indexOf('remove_env_line');
  const rmState = stopBlock.indexOf('rm -rf "$STATE_DIR"');
  assert.ok(rmState > removeLine, 'state cleanup must follow env line removal');
});

test('dev CLI shares only the Docker proxy port between worktrees', () => {
  const cli = fs.readFileSync('dev/local/cli.ts', 'utf8');

  assert.match(cli, /name === 'kiloclaw-docker-tcp'/);
  assert.match(cli, /Refusing to share occupied worktree service ports/);
});

test('stop_server signals on --port match + lsof PID ownership, not binary path', () => {
  const script = fs.readFileSync('apps/mobile/e2e/appium.sh', 'utf8');
  const start = script.indexOf('stop_server()');
  const end = script.indexOf('\n}\n\ncmd=', start);
  const fn = script.slice(start, end) + '\n}';

  // Command captured once before the ownership gates.
  assert.match(fn, /PROCESS_CMD=\$\(ps -o command=/);
  // Port read from the authoritative state file, not global APPIUM_PORT.
  assert.match(fn, /STOP_PORT=\$\(cat "\$STATE_DIR\/server\.port"\)/);
  // Ownership is based on "--port" in the logged command, not the literal
  // binary path (a pnpm shim would not contain $APPIUM_BIN verbatim).
  assert.match(fn, /grep -qF -- "--port \$STOP_PORT"/);
  assert.doesNotMatch(fn, /grep -qF "\$APPIUM_BIN"/);
  // No port file means no signal: STOP_PORT is guarded with -n.
  assert.match(fn, /-n "\$STOP_PORT"/);
  // Two-tier ownership decision: SHOULD_KILL guards the kill block; lsof
  // can override it for a foreign listener.
  assert.match(fn, /SHOULD_KILL=1/);
  assert.match(fn, /SHOULD_KILL=0/);
  assert.match(fn, /LISTENER=\$\(lsof .*tcp:\$STOP_PORT/);
  assert.match(fn, /\$LISTENER" != "\$PID/);
  // SIGTERM follows the SHOULD_KILL guard.
  const shouldIdx = fn.indexOf('SHOULD_KILL" -eq 1');
  const killIdx = fn.indexOf('kill "$PID" 2>/dev/null || true', shouldIdx);
  assert.ok(killIdx > shouldIdx, 'SIGTERM must follow the SHOULD_KILL guard');
  // SIGKILL is inside the same SHOULD_KILL block.
  const sigkillIdx = fn.indexOf('kill -9 "$PID"', shouldIdx);
  assert.ok(
    sigkillIdx > shouldIdx && sigkillIdx < fn.lastIndexOf('fi'),
    'SIGKILL must be inside the ownership guard'
  );
});
