export const RUNTIME_DISTRIBUTION = {
  nodeMajor: '24',
  bun: '1.3.14',
  pnpm: '12.14.0',
  glab: '1.124.0',
  gh: '2.102.0',
} as const;

export type WrapperBundle = {
  readonly entry: string;
  readonly distName: string;
  readonly installName: string;
  readonly executable: boolean;
};

export const WRAPPER_BUNDLES: readonly WrapperBundle[] = [
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
export const RUNTIME_RESERVED_ROOT = '/opt/kilo-cloud';

export function runtimeInstallPath(installName: string): string {
  return `${RUNTIME_INSTALL_DIR}/${installName}`;
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

/** The bootstrap owns this value. User or profile env must not select the runtime. */
export function selectedRuntimeCli(env: Record<string, string | undefined>): string {
  const selected = env.KILO_RUNTIME_CLI_PATH;
  if (selected === undefined) return 'kilo';
  if (
    !selected.startsWith(`${RUNTIME_RESERVED_ROOT}/cli/`) ||
    selected.includes('\0') ||
    selected.includes('\r') ||
    selected.includes('\n') ||
    selected
      .slice(1)
      .split('/')
      .some(part => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid selected runtime CLI');
  return selected;
}
