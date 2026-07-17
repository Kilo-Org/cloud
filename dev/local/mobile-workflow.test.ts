import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('cold launch clears leftover prompts, relaunches, then settles via the shared flow', () => {
  const flow = fs.readFileSync('apps/mobile/e2e/flows/open-app.yaml', 'utf8');
  const trackingGuardIndex = flow.indexOf("visible: 'Ask App Not to Track'");
  const stopIndex = flow.indexOf('- stopApp');
  const launchIndex = flow.indexOf("text: 'Kilo'");
  const readyWaitIndex = flow.indexOf('- extendedWaitUntil:', launchIndex);
  const settleIndex = flow.indexOf('- runFlow: settle-app.yaml');

  assert.ok(trackingGuardIndex >= 0 && trackingGuardIndex < stopIndex);
  assert.ok(stopIndex < launchIndex);
  assert.ok(launchIndex < readyWaitIndex);
  assert.ok(readyWaitIndex < settleIndex);
  assert.match(flow.slice(readyWaitIndex, settleIndex), /timeout: 30000/);
  assert.doesNotMatch(flow.slice(readyWaitIndex), /optional: true/);
});

test('settle flow closes the Expo developer menu after its introduction', () => {
  const flow = fs.readFileSync('apps/mobile/e2e/flows/settle-app.yaml', 'utf8');
  const continueIndex = flow.indexOf("tapOn: 'Continue'");
  const closeGuardIndex = flow.indexOf("visible: 'Fast Refresh|Element Inspector'", continueIndex);
  const closeIndex = flow.indexOf("tapOn: 'Close'", closeGuardIndex);

  assert.ok(continueIndex >= 0, 'settle-app should accept the developer-menu introduction');
  assert.ok(closeGuardIndex > continueIndex, 'settle-app should detect the opened menu');
  assert.ok(closeIndex > closeGuardIndex, 'settle-app should close the opened menu');
  assert.doesNotMatch(flow, /when:\n\s+visible: 'Close'/);
});

test('launch flows never use an unidentified generic Allow selector', () => {
  const request = fs.readFileSync('apps/mobile/e2e/flows/login-request-code.yaml', 'utf8');
  const settle = fs.readFileSync('apps/mobile/e2e/flows/settle-app.yaml', 'utf8');

  assert.doesNotMatch(request, /visible: 'Allow'/);
  assert.match(settle, /“Kilo” Would Like to Send You Notifications/);
});

test('login verification does not pay a fixed optional notification wait', () => {
  const verify = fs.readFileSync('apps/mobile/e2e/flows/login-verify-code.yaml', 'utf8');

  assert.doesNotMatch(verify, /optional: true/);
  assert.match(verify, /“Kilo” Would Like to Send You Notifications\|HOME/);
});

test('login request establishes a signed-out baseline before requesting a fresh OTP', () => {
  const request = fs.readFileSync('apps/mobile/e2e/flows/login-request-code.yaml', 'utf8');
  assert.ok(request.indexOf('logout.yaml') < request.indexOf("tapOn: 'Send sign-in code'"));
});

test('login retry resets an already-open verification screen to the email form', () => {
  const logout = fs.readFileSync('apps/mobile/e2e/flows/logout.yaml', 'utf8');
  const verificationIndex = logout.indexOf("visible: 'Verify code'");
  const backIndex = logout.indexOf("tapOn: 'Back'", verificationIndex);
  const signedOutGuardIndex = logout.indexOf(
    "notVisible: 'Welcome to Kilo Code'",
    verificationIndex
  );

  assert.ok(verificationIndex >= 0);
  assert.ok(backIndex > verificationIndex);
  assert.ok(signedOutGuardIndex > backIndex);
  assert.match(logout, /assertVisible: 'you@example\.com'/);
});

test('login reuses the app state established by logout instead of relaunching each step', () => {
  const request = fs.readFileSync('apps/mobile/e2e/flows/login-request-code.yaml', 'utf8');
  const verify = fs.readFileSync('apps/mobile/e2e/flows/login-verify-code.yaml', 'utf8');
  const login = fs.readFileSync('apps/mobile/e2e/login.sh', 'utf8');

  assert.doesNotMatch(request, /open-app\.yaml/);
  assert.doesNotMatch(verify, /open-app\.yaml/);
  assert.doesNotMatch(login, /maestro .*logout\.yaml/);
  assert.doesNotMatch(login, /login-assert-home\.yaml/);
});

test('login polls the local outbox without one-second latency', () => {
  const login = fs.readFileSync('apps/mobile/e2e/login.sh', 'utf8');
  assert.match(login, /sleep 0\.25/);
});

test('shared launch prompt grace periods total at most five seconds', () => {
  const settle = fs.readFileSync('apps/mobile/e2e/flows/settle-app.yaml', 'utf8');
  const openApp = fs.readFileSync('apps/mobile/e2e/flows/open-app.yaml', 'utf8');
  const optionalWaits = [...settle.matchAll(/timeout: (\d+)\n\s+optional: true/g)].map(match =>
    Number(match[1])
  );

  assert.deepEqual(optionalWaits, [3000]);
  assert.doesNotMatch(openApp, /optional: true/);
});

test('settle flow handles the exact iOS external-app prompt within existing waits', () => {
  const flow = fs.readFileSync('apps/mobile/e2e/flows/settle-app.yaml', 'utf8');
  const promptGuardIndex = flow.indexOf(`visible: 'Open this page in "Kilo"\\?'`);
  const openActionIndex = flow.indexOf("tapOn: 'Open'", promptGuardIndex);
  const finalReadyWaitIndex = flow.lastIndexOf('- extendedWaitUntil:');
  const waitBlocks = [...flow.matchAll(/- extendedWaitUntil:\n[\s\S]*?(?=\n- |$)/g)].map(
    match => match[0]
  );
  const timeouts = [...flow.matchAll(/timeout: (\d+)/g)].map(match => Number(match[1]));

  assert.match(
    waitBlocks[0],
    /Open this page in "Kilo"\\\?/,
    'settle-app should recognize the prompt as its initial visible state'
  );
  assert.match(
    waitBlocks[1],
    /Open this page in "Kilo"\\\?/,
    'settle-app should recognize the prompt inside its optional wait'
  );
  assert.match(waitBlocks[1], /timeout: 3000\n\s+optional: true/);
  assert.ok(promptGuardIndex > flow.indexOf(waitBlocks[1]), 'settle-app should guard Open');
  assert.ok(openActionIndex > promptGuardIndex, 'settle-app should tap the exact Open action');

  const promptChain = [
    {
      action: "tapOn: 'Open'",
      nextGuard: 'Ask App Not to Track',
      visible:
        'Ask App Not to Track|This is the developer menu.*|Fast Refresh|Element Inspector|“Kilo” Would Like to Send You Notifications|HOME|Home, tab, 1 of 4|Welcome to Kilo Code|Accept and continue',
    },
    {
      action: "tapOn: 'Ask App Not to Track'",
      nextGuard: 'This is the developer menu.*',
      visible:
        'This is the developer menu.*|Fast Refresh|Element Inspector|“Kilo” Would Like to Send You Notifications|HOME|Home, tab, 1 of 4|Welcome to Kilo Code|Accept and continue',
    },
    {
      action: "tapOn: 'Continue'",
      nextGuard: 'Fast Refresh|Element Inspector',
      visible:
        'Fast Refresh|Element Inspector|“Kilo” Would Like to Send You Notifications|HOME|Home, tab, 1 of 4|Welcome to Kilo Code|Accept and continue',
    },
    {
      action: "tapOn: 'Close'",
      nextGuard: '“Kilo” Would Like to Send You Notifications',
      visible:
        '“Kilo” Would Like to Send You Notifications|HOME|Home, tab, 1 of 4|Welcome to Kilo Code|Accept and continue',
    },
  ];

  let searchFrom = openActionIndex;
  for (const step of promptChain) {
    const actionIndex = flow.indexOf(step.action, searchFrom);
    const nextGuardIndex = flow.indexOf(
      `- runFlow:\n    when:\n      visible: '${step.nextGuard}'`,
      actionIndex
    );
    const betweenActionAndGuard = flow.slice(actionIndex, nextGuardIndex);

    assert.ok(actionIndex >= searchFrom, `settle-app should include ${step.action}`);
    assert.ok(
      nextGuardIndex > actionIndex,
      `settle-app should guard ${step.nextGuard} after ${step.action}`
    );
    assert.match(
      betweenActionAndGuard,
      new RegExp(
        `- extendedWaitUntil:\\n    visible: '${step.visible.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\n    timeout: 5000`
      ),
      `settle-app should poll for the next state immediately after ${step.action}`
    );
    assert.doesNotMatch(
      betweenActionAndGuard,
      /timeout: (?:500|1000)\n|optional: true/,
      `settle-app should use a robust non-optional state gate after ${step.action}`
    );
    assert.doesNotMatch(
      betweenActionAndGuard.replace(/^- runFlow:[\s\S]*?commands:\n\s+- tapOn: '[^']+'/, ''),
      /- runFlow:/,
      `settle-app should not insert another one-shot guard before polling`
    );
    searchFrom = nextGuardIndex;
  }
  assert.ok(
    finalReadyWaitIndex > openActionIndex,
    'settle-app should still wait for its final ready state'
  );
  assert.deepEqual(
    timeouts,
    [15000, 3000, 5000, 5000, 5000, 5000, 15000],
    'settle-app should not add a fixed wait'
  );
  assert.doesNotMatch(flow, /visible: '(?:Allow|Open)'/);
  assert.doesNotMatch(flow, /tapOn: '(?:Allow\|Open|Open\|Allow)'/);
});

test('helper-driven logout settles the app already launched by preflight', () => {
  const logout = fs.readFileSync('apps/mobile/e2e/flows/logout.yaml', 'utf8');
  const settle = fs.readFileSync('apps/mobile/e2e/flows/settle-app.yaml', 'utf8');

  assert.match(logout, /settle-app\.yaml/);
  assert.doesNotMatch(logout, /open-app\.yaml/);
  assert.doesNotMatch(settle, /stopApp|text: 'Kilo'/);
});

test('logout skips prompt settling for stable signed-in and signed-out states', () => {
  const logout = fs.readFileSync('apps/mobile/e2e/flows/logout.yaml', 'utf8');
  const settleIndex = logout.indexOf('settle-app.yaml');

  assert.ok(logout.indexOf("notVisible: 'Welcome to Kilo Code'") < settleIndex);
  assert.ok(logout.indexOf("notVisible: 'HOME|Home, tab, 1 of 4'") < settleIndex);
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

test('remote CLI runbook is secret-free and defers credential-bearing setup to the orchestrator', () => {
  const runbook = fs.readFileSync('apps/mobile/e2e/AGENTS.md', 'utf8');
  const remoteCliSection = runbook.slice(
    runbook.indexOf('## Remote CLI Session Flows'),
    runbook.indexOf('## Android Emulator')
  );

  // The role-agent runbook must not contain bearer tokens, signing secrets,
  // or credential-bearing environment variables.
  assert.doesNotMatch(remoteCliSection, /KILO_E2E_AUTH_TOKEN/);
  assert.doesNotMatch(remoteCliSection, /KILO_AUTH_CONTENT/);
  assert.doesNotMatch(remoteCliSection, /NEXTAUTH_SECRET/);
  assert.doesNotMatch(remoteCliSection, /\$\{KILO_[A-Z_]+/);

  // The role-agent runbook must not install the CLI or set up the CLI session.
  assert.doesNotMatch(remoteCliSection, /npm install.*@kilocode\/cli/);
  assert.doesNotMatch(remoteCliSection, /CLI_SCRATCH=/);
  assert.doesNotMatch(remoteCliSection, /tmux set-environment/);
  assert.doesNotMatch(remoteCliSection, /wrangler secrets/);

  // The role-agent runbook must clearly delegate credential-bearing setup
  // to the orchestrator and describe how the role agent reuses the prepared
  // session to verify mobile session discovery and mirroring.
  assert.match(remoteCliSection, /orchestrator/i);
  assert.match(remoteCliSection, /kilo-e2e-cli-/);
  assert.match(remoteCliSection, /session discovery|mirroring/);
});
