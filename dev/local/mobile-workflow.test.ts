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
  assert.match(flow.slice(optionalWaitIndex, continueIndex), /timeout: 2000/);
  assert.match(flow.slice(optionalWaitIndex, continueIndex), /optional: true/);
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
  const flow = fs.readFileSync('apps/mobile/e2e/flows/open-app.yaml', 'utf8');
  const optionalWaits = [...flow.matchAll(/timeout: (\d+)\n\s+optional: true/g)].map(match =>
    Number(match[1])
  );

  assert.equal(
    optionalWaits.reduce((total, timeout) => total + timeout, 0),
    5000
  );
});

test('helper-driven logout settles the app already launched by preflight', () => {
  const logout = fs.readFileSync('apps/mobile/e2e/flows/logout.yaml', 'utf8');
  const settle = fs.readFileSync('apps/mobile/e2e/flows/settle-app.yaml', 'utf8');

  assert.match(logout, /settle-app\.yaml/);
  assert.doesNotMatch(logout, /open-app\.yaml/);
  assert.doesNotMatch(settle, /stopApp|text: 'Kilo'/);
  assert.match(settle, /timeout: 3000/);
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

test('Android workflow uses Maestro first and applies resolved tooling to Expo builds', () => {
  const android = fs.readFileSync('dev/local/mobile-android.ts', 'utf8');
  const runbook = fs.readFileSync('apps/mobile/e2e/AGENTS.md', 'utf8');

  assert.match(android, /'build'/);
  assert.match(android, /'run:android'/);
  assert.match(android, /path\.join\(worktreeRoot, 'apps\/mobile'\)/);
  assert.match(runbook, /Use Maestro as the primary Android automation driver/);
  assert.match(runbook, /Fall back to repository-wrapped ADB/);
});

test('iOS workflow uses Maestro first with simctl as the low-level fallback', () => {
  const runbook = fs.readFileSync('apps/mobile/e2e/AGENTS.md', 'utf8');
  const verifier = fs.readFileSync('apps/mobile/.kilo/agent/mobile-e2e-verifier.md', 'utf8');

  assert.match(runbook, /Use Maestro as the primary iOS automation driver/);
  assert.match(runbook, /Fall back to `xcrun simctl`/);
  assert.match(verifier, /Fall back to `xcrun simctl` on iOS/);
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

test('mobile workflow owns PR assignment and the post-PR Kilobot repair loop', () => {
  const workflow = fs.readFileSync('apps/mobile/.kilo/MOBILE_WORKFLOW.md', 'utf8');

  assert.match(workflow, /assign(?:s|ed)? the PR to the requesting human/i);
  assert.match(workflow, /Kilobot has reviewed the latest head/i);
  assert.match(workflow, /no unresolved actionable Kilobot comments/i);
  assert.match(workflow, /plan the smallest coherent repair/i);
  assert.match(workflow, /mobile-implementer/);
  assert.match(workflow, /fresh `mobile-reviewer`/);
  assert.match(workflow, /smallest coherent commit/i);
  assert.match(workflow, /reply in the original review thread/i);
  assert.match(workflow, /resolve the thread/i);
  assert.match(workflow, /local mobile E2E/i);
});

test('mobile workflow keeps secret-bearing environment files out of subagent context', () => {
  const workflow = fs.readFileSync('apps/mobile/.kilo/MOBILE_WORKFLOW.md', 'utf8');
  const runbook = fs.readFileSync('apps/mobile/e2e/AGENTS.md', 'utf8');

  assert.match(workflow, /must not read .*\.env/i);
  assert.match(workflow, /\.dev\.vars/);
  assert.match(workflow, /sanitized explicit values/i);
  assert.doesNotMatch(runbook, /grep .*\.env/);
});

test('mobile workflow keeps generated E2E fixtures out of Git', () => {
  const workflow = fs.readFileSync('apps/mobile/.kilo/MOBILE_WORKFLOW.md', 'utf8');
  const runbook = fs.readFileSync('apps/mobile/e2e/AGENTS.md', 'utf8');

  for (const document of [workflow, runbook]) {
    assert.match(document, /E2E fixtures must never be committed/i);
    assert.match(document, /temporary directory/i);
    assert.match(document, /clean(?:ed)? up/i);
  }
  assert.match(workflow, /git status/i);
});

test('mobile workflow requires dedicated worktrees in every repository', () => {
  const workflow = fs.readFileSync('apps/mobile/.kilo/MOBILE_WORKFLOW.md', 'utf8');

  assert.match(workflow, /Work must always be done in a dedicated worktree/i);
  assert.match(workflow, /regardless of (?:the )?repository/i);
  assert.match(workflow, /sibling repositories/i);
  assert.match(workflow, /must not edit the primary checkout/i);
  assert.match(workflow, /(?:or|and) the main checkout/i);
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
