/**
 * Public-surface-only helpers for the native runtime driver.
 *
 * Nothing here reads Docker, the filesystem, worker logs or `@kilocode/db`, so
 * the driver and its unit test can share one source of truth for the fixture
 * command and the result classification. The driver exposes no `/__e2e` route
 * and is not part of the default SDK matrix.
 */

/** The fixture dependency directory stays under the isolated workspace. */
export const NATIVE_FIXTURE_WORKSPACE_PATH = '/workspace/app';
export const NATIVE_FIXTURE_DEP_DIR = 'node_modules/fx-dep';
export const NATIVE_FIXTURE_SENTINEL_PATH = '.fx/sentinel';

/** Only these two nonsecret env values vary between the seed and restore runs. */
export const NATIVE_FIXTURE_MODE_ENV = 'NATIVE_FIXTURE_MODE';
export const NATIVE_FIXTURE_EXPECTED_ENV = 'NATIVE_FIXTURE_EXPECTED';
export const NATIVE_FIXTURE_MODES = ['seed', 'restore'] as const;
export type NativeFixtureMode = (typeof NATIVE_FIXTURE_MODES)[number];

/**
 * One deterministic setup command. `restore` reads and imports the installed
 * dependency BEFORE any write, and refuses a missing sentinel instead of
 * recreating it. The `bun -e` import result is checked (`|| exit 8`): a failed
 * import must not fall through to the trailing `exit 0`. `seed` writes the
 * dependency and the sentinel only. The same string is used for both runs, so
 * `computeRepoKey` (which hashes the setup command strings, not env values) is
 * unchanged while the nonsecret mode env varies.
 */
export const NATIVE_FIXTURE_SCRIPT =
  'if [ "$NATIVE_FIXTURE_MODE" = restore ]; then ' +
  'test -f .fx/sentinel || exit 9; ' +
  'test -f node_modules/fx-dep/index.js || exit 9; ' +
  'else ' +
  'mkdir -p .fx node_modules/fx-dep; ' +
  "printf 'exports.v=1;exports.x=n=>n*6' > node_modules/fx-dep/index.js; " +
  'printf %s "$NATIVE_FIXTURE_EXPECTED" > .fx/sentinel; fi; ' +
  'bun -e "const d=require(process.cwd()+\'/node_modules/fx-dep\');if(d.v!==1||d.x(7)!==42)process.exit(8)" || exit 8; ' +
  'test "$(cat .fx/sentinel)" = "$NATIVE_FIXTURE_EXPECTED" || exit 7';

/** The setup command array. It is identical across modes by construction. */
export function nativeFixtureSetupCommands(): string[] {
  return [NATIVE_FIXTURE_SCRIPT, NATIVE_RUNTIME_MEASURE_SCRIPT];
}

/**
 * A second, fixed setup command (identical across seed/restore/releases) that
 * records the ACTUAL selected runtime bytes into `.fx/runtime.json` after the
 * fixture validation has passed. It hashes the active CLI executable and the
 * canonical control supervisor, so the driver can compare them against the
 * immutable release descriptor's inventory instead of trusting archive names.
 * It never writes before the fixture sentinel/import checks in the first
 * command have already succeeded.
 */
export const NATIVE_RUNTIME_MEASURE_SCRIPT =
  'bun -e \'const f=require("fs"),h=p=>f.existsSync(p)?require("crypto").createHash("sha256").update(f.readFileSync(p)).digest("hex"):null;f.writeFileSync(".fx/runtime.json",JSON.stringify({sentinel:f.readFileSync(".fx/sentinel","utf8"),cliSha256:h(process.env.KILO_RUNTIME_CLI_PATH||"/opt/kilo-cloud/active/cli/package/bin/kilo"),supervisorSha256:h("/usr/local/bin/kilocode-control-plane-supervisor.sh")}))\'';

export function nativeRuntimeMeasureCommands(): string[] {
  return [NATIVE_RUNTIME_MEASURE_SCRIPT];
}

/** The only thing that changes between seed and restore is this nonsecret env. */
export function nativeFixtureEnv(
  mode: NativeFixtureMode,
  expected: string
): Record<string, string> {
  return {
    [NATIVE_FIXTURE_MODE_ENV]: mode,
    [NATIVE_FIXTURE_EXPECTED_ENV]: expected,
  };
}

export type NativeEvidenceFlag = 'verified' | 'unverified';
export type NativeEvidenceName = 'snapshot' | 'index' | 'managedBase' | 'containment';

export type NativeRunOutcome = {
  functional: 'pass' | 'fail';
  status: 'pass' | 'fail' | 'unsupported';
  evidence: Record<NativeEvidenceName, NativeEvidenceFlag>;
  notes: string[];
};

const EVIDENCE_NAMES: NativeEvidenceName[] = ['snapshot', 'index', 'managedBase', 'containment'];

/**
 * Classify a native runtime run. Functional success is necessary but never
 * sufficient: snapshot reuse, index, managed-base, and containment evidence are
 * unavailable from the public surface locally, so they default to `unverified`
 * and the run is `unsupported` unless explicit evidence is supplied. No
 * idle/chat flag can mark snapshot evidence verified.
 */
export function classifyNativeRun(input: {
  coldTurnCompleted: boolean;
  coldToolTurnObserved: boolean;
  followupCompleted: boolean;
  evidence?: Partial<Record<NativeEvidenceName, NativeEvidenceFlag>>;
}): NativeRunOutcome {
  const evidence = Object.fromEntries(
    EVIDENCE_NAMES.map(name => [name, input.evidence?.[name] ?? 'unverified'])
  ) as Record<NativeEvidenceName, NativeEvidenceFlag>;
  const functionalPass =
    input.coldTurnCompleted && input.coldToolTurnObserved && input.followupCompleted;
  const notes: string[] = [];
  if (!input.coldTurnCompleted) notes.push('cold turn did not complete');
  if (!input.coldToolTurnObserved) notes.push('no cold tool turn observed');
  if (!input.followupCompleted) notes.push('same-chat followup did not complete');
  for (const name of EVIDENCE_NAMES) {
    if (evidence[name] !== 'verified') notes.push(`${name} evidence unavailable locally`);
  }
  if (!functionalPass) return { functional: 'fail', status: 'fail', evidence, notes };
  const allVerified = EVIDENCE_NAMES.every(name => evidence[name] === 'verified');
  return { functional: 'pass', status: allVerified ? 'pass' : 'unsupported', evidence, notes };
}

/**
 * Classify a CLI A->B->A or wrapper-only transition using explicit per-run
 * expected hashes. A wrapper-only run additionally requires the CLI object not
 * to be refetched and its hash to be unchanged. The result is `unsupported`
 * until real native snapshot evidence is present; a persisted local fixture
 * volume can supplement but never substitutes for it.
 */
export function classifyRuntimeTransition(input: {
  mode: 'cli-upgrade' | 'wrapper-only';
  expectedCliSha256?: string;
  expectedControlSha256?: string;
  observedCliSha256?: string;
  observedControlSha256?: string;
  cliRefetched?: boolean;
  snapshotVerified?: boolean;
}): NativeRunOutcome {
  const evidence: Record<NativeEvidenceName, NativeEvidenceFlag> = {
    snapshot: input.snapshotVerified ? 'verified' : 'unverified',
    index: 'unverified',
    managedBase: 'unverified',
    containment: 'unverified',
  };
  const notes: string[] = [];
  if (input.expectedCliSha256 === undefined || input.observedCliSha256 === undefined) {
    notes.push('cli hash inputs are incomplete');
    return { functional: 'fail', status: 'fail', evidence, notes };
  }
  let functionalPass = input.observedCliSha256 === input.expectedCliSha256;
  if (input.mode === 'wrapper-only') {
    if (input.expectedControlSha256 === undefined || input.observedControlSha256 === undefined) {
      notes.push('control hash inputs are incomplete');
      functionalPass = false;
    } else if (input.observedControlSha256 !== input.expectedControlSha256) {
      notes.push('control hash did not advance');
      functionalPass = false;
    } else if (input.cliRefetched === true) {
      notes.push('CLI object was refetched during a wrapper-only run');
      functionalPass = false;
    }
  }
  if (!functionalPass) notes.push('expected and observed hashes did not match');
  for (const name of EVIDENCE_NAMES) {
    if (evidence[name] !== 'verified') notes.push(`${name} evidence unavailable locally`);
  }
  if (!functionalPass) return { functional: 'fail', status: 'fail', evidence, notes };
  const allVerified = EVIDENCE_NAMES.every(name => evidence[name] === 'verified');
  return { functional: 'pass', status: allVerified ? 'pass' : 'unsupported', evidence, notes };
}

/**
 * Join the assistant text the driver observed on the stream. Text may arrive as
 * a `text` field or as an incremental `delta`, so both are collected.
 */
export function extractStreamText(
  events: readonly { streamEventType: string; data: Record<string, unknown> }[]
): string {
  let text = '';
  for (const event of events) {
    if (event.streamEventType.includes('text') || event.streamEventType.includes('delta')) {
      if (typeof event.data.text === 'string') text += event.data.text;
      else if (typeof event.data.delta === 'string') text += event.data.delta;
    }
  }
  return text;
}
