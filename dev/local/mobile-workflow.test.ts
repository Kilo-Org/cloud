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
  const optionalWaitIndex = flow.lastIndexOf('- extendedWaitUntil:', developerMenuWaitIndex);
  const continueIndex = flow.indexOf("tapOn: 'Continue'", developerMenuWaitIndex);

  assert.ok(launchIndex >= 0);
  assert.ok(developerMenuWaitIndex > launchIndex);
  assert.ok(continueIndex > developerMenuWaitIndex);
  assert.match(flow.slice(optionalWaitIndex, continueIndex), /timeout: 5000/);
  assert.doesNotMatch(flow.slice(optionalWaitIndex, continueIndex), /optional: true/);
});

test('shared launch flows close the Expo developer menu after its introduction', () => {
  const runbook = fs.readFileSync('apps/mobile/e2e/AGENTS.md', 'utf8');

  for (const flowPath of [
    'apps/mobile/e2e/flows/open-app.yaml',
    'apps/mobile/e2e/flows/settle-app.yaml',
  ]) {
    const flow = fs.readFileSync(flowPath, 'utf8');
    const continueIndex = flow.indexOf("tapOn: 'Continue'");
    const closeGuardIndex = flow.indexOf(
      "visible: 'Fast Refresh|Element Inspector'",
      continueIndex
    );
    const closeIndex = flow.indexOf("tapOn: 'Close'", closeGuardIndex);

    assert.ok(continueIndex >= 0, `${flowPath} should accept the developer-menu introduction`);
    assert.ok(closeGuardIndex > continueIndex, `${flowPath} should detect the opened menu`);
    assert.ok(closeIndex > closeGuardIndex, `${flowPath} should close the opened menu`);
    assert.doesNotMatch(flow, /when:\n\s+visible: 'Close'/);
  }

  assert.match(
    runbook,
    /developer menu containing Fast Refresh and Element Inspector with its `Close` accessibility action/
  );
});

test('login flows never use an unidentified generic Allow selector', () => {
  const request = fs.readFileSync('apps/mobile/e2e/flows/login-request-code.yaml', 'utf8');
  const openApp = fs.readFileSync('apps/mobile/e2e/flows/open-app.yaml', 'utf8');

  assert.doesNotMatch(request, /visible: 'Allow'/);
  assert.match(openApp, /“Kilo” Would Like to Send You Notifications/);
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
  for (const flowPath of [
    'apps/mobile/e2e/flows/open-app.yaml',
    'apps/mobile/e2e/flows/settle-app.yaml',
  ]) {
    const flow = fs.readFileSync(flowPath, 'utf8');
    const optionalWaits = [...flow.matchAll(/timeout: (\d+)\n\s+optional: true/g)].map(match =>
      Number(match[1])
    );

    assert.deepEqual(optionalWaits, [3000]);
    assert.ok(optionalWaits.reduce((total, timeout) => total + timeout, 0) <= 5000);
  }
});

test('shared launch flows handle the exact iOS external-app prompt within existing waits', () => {
  const flowContracts = [
    {
      path: 'apps/mobile/e2e/flows/open-app.yaml',
      timeouts: [30000, 3000, 5000, 5000, 5000, 5000, 30000],
    },
    {
      path: 'apps/mobile/e2e/flows/settle-app.yaml',
      timeouts: [15000, 3000, 5000, 5000, 5000, 5000, 15000],
    },
  ];

  for (const contract of flowContracts) {
    const flow = fs.readFileSync(contract.path, 'utf8');
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
      `${contract.path} should recognize the prompt as its initial visible state`
    );
    assert.match(
      waitBlocks[1],
      /Open this page in "Kilo"\\\?/,
      `${contract.path} should recognize the prompt inside its optional wait`
    );
    assert.match(waitBlocks[1], /timeout: 3000\n\s+optional: true/);
    assert.ok(
      promptGuardIndex > flow.indexOf(waitBlocks[1]),
      `${contract.path} should guard the Open action`
    );
    assert.ok(
      openActionIndex > promptGuardIndex,
      `${contract.path} should tap the exact Open action`
    );
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

      assert.ok(actionIndex >= searchFrom, `${contract.path} should include ${step.action}`);
      assert.ok(
        nextGuardIndex > actionIndex,
        `${contract.path} should guard ${step.nextGuard} after ${step.action}`
      );
      assert.match(
        betweenActionAndGuard,
        new RegExp(
          `- extendedWaitUntil:\\n    visible: '${step.visible.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\n    timeout: 5000`
        ),
        `${contract.path} should poll for the next state immediately after ${step.action}`
      );
      assert.doesNotMatch(
        betweenActionAndGuard,
        /timeout: (?:500|1000)\n|optional: true/,
        `${contract.path} should use a robust non-optional state gate after ${step.action}`
      );
      assert.doesNotMatch(
        betweenActionAndGuard.replace(/^- runFlow:[\s\S]*?commands:\n\s+- tapOn: '[^']+'/, ''),
        /- runFlow:/,
        `${contract.path} should not insert another one-shot guard before polling`
      );
      searchFrom = nextGuardIndex;
    }
    assert.ok(
      finalReadyWaitIndex > openActionIndex,
      `${contract.path} should still wait for its final ready state`
    );
    assert.deepEqual(timeouts, contract.timeouts, `${contract.path} should not add a fixed wait`);
    assert.doesNotMatch(flow, /visible: '(?:Allow|Open)'/);
    assert.doesNotMatch(flow, /tapOn: '(?:Allow\|Open|Open\|Allow)'/);
  }
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

test('shared launch clears an already-visible tracking prompt before tapping the app icon', () => {
  const flow = fs.readFileSync('apps/mobile/e2e/flows/open-app.yaml', 'utf8');
  assert.ok(flow.indexOf("visible: 'Ask App Not to Track'") < flow.indexOf("visible: 'Kilo'"));
});

test('mobile workflow documents hierarchy-derived tab selectors', () => {
  const runbook = fs.readFileSync('apps/mobile/e2e/AGENTS.md', 'utf8');

  assert.match(runbook, /Agents, tab, 3 of 4/);
  assert.match(runbook, /Never guess a selector from the visible label/);
  assert.match(runbook, /pnpm dev:capture mobile/);
  assert.match(runbook, /dev:mobile:simulator claim/);
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

test('Android workflow uses Maestro first and applies resolved tooling to cached native builds', () => {
  const android = fs.readFileSync('dev/local/mobile-android.ts', 'utf8');
  const runbook = fs.readFileSync('apps/mobile/e2e/AGENTS.md', 'utf8');

  assert.match(android, /'build'/);
  assert.match(android, /runAndroidBuild/);
  assert.match(android, /withNativeBuildSemaphore/);
  assert.match(android, /app:assembleDebug/);
  assert.match(android, /path\.join\(worktreeRoot, 'apps\/mobile'\)/);
  assert.match(runbook, /Use Maestro as the primary Android automation driver/);
  assert.match(runbook, /Fall back to repository-wrapped ADB/);
});

test('iOS workflow uses Maestro first with simctl as the low-level fallback', () => {
  const runbook = fs.readFileSync('apps/mobile/e2e/AGENTS.md', 'utf8');

  assert.match(runbook, /Use Maestro as the primary iOS automation driver/);
  assert.match(runbook, /Fall back to `xcrun simctl`/);
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

test('workflow documents the shared Docker proxy exception without weakening backend isolation', () => {
  const runbook = fs.readFileSync('apps/mobile/e2e/AGENTS.md', 'utf8');
  const cli = fs.readFileSync('dev/local/cli.ts', 'utf8');

  assert.match(runbook, /sole intentional host-wide exception/);
  assert.match(runbook, /Never kill a `socat` process owned by another worktree/);
  assert.match(cli, /name === 'kiloclaw-docker-tcp'/);
  assert.match(cli, /Refusing to share occupied worktree service ports/);
});

test('mobile runbook prohibits host-global Metro proxies', () => {
  const runbook = fs.readFileSync('apps/mobile/e2e/AGENTS.md', 'utf8');

  assert.match(runbook, /must never map.*8081.*worktree.*Metro/is);
  assert.match(runbook, /sole intentional host-wide proxy exception.*23750/is);
  assert.match(runbook, /test-environment failure/i);
  assert.match(runbook, /PID.*parent PID.*bind address.*port/is);
});

test('mobile runbook uses ownership-aware simulator phase labels', () => {
  const runbook = fs.readFileSync('apps/mobile/e2e/AGENTS.md', 'utf8');

  assert.match(runbook, /Kilo E2E - <sanitized-worktree-basename> - <phase>/);
  assert.match(runbook, /must not call.*simctl rename/i);
  assert.match(runbook, /restores the original simulator name/i);
});

test('mobile runbook installs validated cached native builds', () => {
  const runbook = fs.readFileSync('apps/mobile/e2e/AGENTS.md', 'utf8');

  assert.match(runbook, /dev:mobile:ios build <udid>/);
  assert.match(runbook, /dev:mobile:android build <serial>/);
  assert.match(runbook, /validated cached/i);
  assert.doesNotMatch(runbook, /npx expo run:ios --device/);
});

test('mobile runbook handles the exact Safari external-app prompt within the shared budget', () => {
  const runbook = fs.readFileSync('apps/mobile/e2e/AGENTS.md', 'utf8');

  assert.match(runbook, /Open this page in [“"]Kilo[”"]\?/);
  assert.match(runbook, /exact.*Open.*accessibility/is);
  assert.match(runbook, /five-second optional-prompt/i);
  assert.match(runbook, /prefer.*simctl openurl.*avoid.*confirmation/is);
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
