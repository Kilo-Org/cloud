export const RUNTIME_DISTRIBUTION = {
  nodeMajor: '24',
  bun: '1.3.14',
  pnpm: '11.1.2',
  glab: '1.93.0',
  gh: '2.82.1',
} as const;

export type WrapperBundle = {
  readonly entry: string;
  readonly distName: string;
  readonly installName: string;
  readonly executable: boolean;
};

export const WRAPPER_BUNDLES: readonly WrapperBundle[] = [
  {
    entry: 'src/main.ts',
    distName: 'wrapper.js',
    installName: 'kilocode-wrapper.js',
    executable: false,
  },
  {
    entry: 'src/restore-session.ts',
    distName: 'restore-session.js',
    installName: 'kilo-restore-session.js',
    executable: false,
  },
  {
    entry: 'src/bitbucket-review-cli.ts',
    distName: 'bb',
    installName: 'bb',
    executable: true,
  },
  {
    entry: 'src/github-review-publish-mcp.ts',
    distName: 'github-review-publish-mcp',
    installName: 'github-review-publish-mcp',
    executable: true,
  },
  {
    entry: 'src/control-plane/main.ts',
    distName: 'control-plane-wrapper.js',
    installName: 'kilocode-control-plane-wrapper.js',
    executable: false,
  },
];

export const CONTROL_PLANE_SUPERVISOR = {
  wrapperPath: 'control-plane-supervisor.sh',
  installName: 'kilocode-control-plane-supervisor.sh',
} as const;

export const GIT_CREDENTIAL_HELPER = {
  packagePath: 'scripts/kilo-git-credential',
  installName: 'kilo-git-credential',
  realPath: '/opt/kilo-cloud/kilo-git-credential',
  linkPath: '/usr/local/bin/kilo-git-credential',
} as const;

export const RUNTIME_INSTALL_DIR = '/usr/local/bin';
/** Directory holding the supervisor/wrapper/helper aliases. */
export const RUNTIME_ALIAS_DIR = RUNTIME_INSTALL_DIR;

/**
 * Reserved platform root for runtime-owned files (plan §6 "Runtime And User
 * Data"). Project dependencies and Kilo's mutable session/configuration data
 * stay outside it. The Git credential helper already lives here.
 */
export const RUNTIME_RESERVED_ROOT = '/opt/kilo-cloud';
/** Content-addressed CLI distributions, reusable across control-bundle updates. */
export const RUNTIME_CLI_ROOT = `${RUNTIME_RESERVED_ROOT}/cli`;
/** Content-addressed control bundles (wrapper, supervisor, helpers). */
export const RUNTIME_CONTROL_ROOT = `${RUNTIME_RESERVED_ROOT}/control`;
/**
 * Platform-owned active-release pointer. It is updated only after a release
 * verifies, and must name a directory inside the reserved root; an escaping
 * pointer is rejected rather than written through.
 */
export const RUNTIME_ACTIVE_POINTER = `${RUNTIME_RESERVED_ROOT}/active`;
/** Combined releases that pair one CLI distribution with one control bundle. */
export const RUNTIME_RELEASES_ROOT = `${RUNTIME_RESERVED_ROOT}/releases`;

export function runtimeInstallPath(installName: string): string {
  return `${RUNTIME_INSTALL_DIR}/${installName}`;
}

/**
 * The explicit baked platform path. A baked image has no installer selection
 * and runs this path; the legacy `agent_*` plane and the Vercel provider also
 * keep it.
 */
export const DEFAULT_KILO_EXECUTABLE_PATH = '/usr/local/bin/kilo';

/**
 * The one owner of Kilo executable selection (amendment "cold session without a
 * snapshot"). The installer that provisions a runtime-free image exports
 * `KILO_RUNTIME_CLI_PATH` as an absolute selected path before it execs the
 * supervisor. A baked image has no such value.
 *
 * Only the trusted inherited environment is read. Selection is lexical: the
 * value must be an absolute path and there is no `PATH` search and no
 * filesystem probe. A profile value never reaches a caller because
 * `buildWorktreeKiloEnvironment` strips `KILO*` and re-adds only the inherited
 * copy.
 *
 * A value that is present but not an absolute path is a defect, not a reason to
 * run the baked path: a loaded runtime that cannot name its CLI must fail
 * rather than execute the old or a non-existent CLI.
 */
export function resolveKiloExecutable(env: Record<string, string | undefined>): string {
  const selected = env.KILO_RUNTIME_CLI_PATH;
  if (selected === undefined) return DEFAULT_KILO_EXECUTABLE_PATH;
  if (selected === '' || !selected.startsWith('/')) {
    throw new Error('KILO_RUNTIME_CLI_PATH must be an absolute path when it is set');
  }
  return selected;
}

export function wrapperBundle(entry: string): WrapperBundle {
  const bundle = WRAPPER_BUNDLES.find(item => item.entry === entry);
  if (!bundle) throw new Error(`unknown wrapper bundle: ${entry}`);
  return bundle;
}

export const RUNTIME_REQUIRED_BINARIES = [
  'bun',
  'node',
  'pnpm',
  'git',
  'git-lfs',
  'gh',
  'glab',
  'rg',
  'kilo',
] as const;
