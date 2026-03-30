/**
 * Bootstrap: performs all pre-gateway startup logic.
 *
 * Previously this lived in a shell script (start-openclaw.sh). Moving it here means
 * the controller's HTTP server can start first (so /_kilo/health is always
 * reachable), then run bootstrap steps internally with phase-by-phase progress
 * reporting. If any step fails, the controller stays up in degraded mode.
 *
 * Each step is exported as a standalone, deps-injected function for testability.
 * The bootstrap() orchestrator is thin glue that calls them in order.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync as nodeExecFileSync } from 'node:child_process';
import { generateBaseConfig, writeBaseConfig, writeMcporterConfig } from './config-writer';
import type { ConfigWriterDeps } from './config-writer';
import { atomicWrite } from './atomic-write';

const CONFIG_DIR = '/root/.openclaw';
const CONFIG_PATH = '/root/.openclaw/openclaw.json';
const WORKSPACE_DIR = '/root/clawd';
const COMPILE_CACHE_DIR = '/var/tmp/openclaw-compile-cache';
const TOOLS_MD_SOURCE = '/usr/local/share/kiloclaw/TOOLS.md';
const TOOLS_MD_DEST = '/root/.openclaw/workspace/TOOLS.md';

const ENC_PREFIX = 'KILOCLAW_ENC_';
const VALUE_PREFIX = 'enc:v1:';
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---- Types ----

type EnvLike = Record<string, string | undefined>;

type ExecOpts = {
  env?: NodeJS.ProcessEnv;
  stdio?: 'inherit' | 'pipe';
  input?: string;
};

export type BootstrapDeps = {
  mkdirSync: (dir: string, opts: { recursive: boolean; mode?: number }) => void;
  chmodSync: (path: string, mode: number) => void;
  chdir: (dir: string) => void;
  existsSync: (path: string) => boolean;
  copyFileSync: (src: string, dest: string) => void;
  writeFileSync: (path: string, data: string) => void;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  renameSync: (oldPath: string, newPath: string) => void;
  unlinkSync: (path: string) => void;
  readdirSync: (dir: string) => string[];
  execFileSync: (cmd: string, args: string[], opts?: ExecOpts) => string;
};

const defaultDeps: BootstrapDeps = {
  mkdirSync: (dir, opts) => fs.mkdirSync(dir, opts),
  chmodSync: (p, mode) => fs.chmodSync(p, mode),
  chdir: dir => process.chdir(dir),
  existsSync: p => fs.existsSync(p),
  copyFileSync: (src, dest) => fs.copyFileSync(src, dest),
  writeFileSync: (p, data) => fs.writeFileSync(p, data),
  readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
  renameSync: (oldPath, newPath) => fs.renameSync(oldPath, newPath),
  unlinkSync: p => fs.unlinkSync(p),
  readdirSync: dir => fs.readdirSync(dir),
  execFileSync: (cmd, args, opts) =>
    nodeExecFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: opts?.stdio ?? 'pipe',
      env: opts?.env,
      input: opts?.input,
    }),
};

// ---- Controller state type ----

export type ControllerState =
  | { state: 'bootstrapping'; phase: string }
  | { state: 'starting' }
  | { state: 'ready' }
  | { state: 'degraded'; error: string };

export type ControllerStateRef = { current: ControllerState };

// ---- Step 1: Env decryption ----

/**
 * Decrypt KILOCLAW_ENC_* environment variables using the KILOCLAW_ENV_KEY.
 *
 * Decrypt KILOCLAW_ENC_* environment variables in place. Mutates `env`
 * in place: strips the KILOCLAW_ENC_ prefix, sets the plaintext value,
 * then deletes the encrypted var and the key.
 *
 * Fail-closed: if KILOCLAW_ENC_* vars exist without KILOCLAW_ENV_KEY, throws.
 */
export function decryptEnvVars(env: EnvLike): void {
  const encVarNames = Object.keys(env).filter(k => k.startsWith(ENC_PREFIX));

  if (encVarNames.length === 0) {
    // No encrypted vars — just clean up the key if present
    delete env.KILOCLAW_ENV_KEY;
    // Still validate critical env vars exist even without encryption
    // Required even without encryption — these are critical for the controller.
    if (!env.KILOCODE_API_KEY) {
      throw new Error('KILOCODE_API_KEY is required');
    }
    if (!env.OPENCLAW_GATEWAY_TOKEN) {
      throw new Error('OPENCLAW_GATEWAY_TOKEN is required');
    }
    return;
  }

  const keyBase64 = env.KILOCLAW_ENV_KEY;
  if (!keyBase64) {
    throw new Error('Encrypted env vars (KILOCLAW_ENC_*) found but KILOCLAW_ENV_KEY is not set');
  }

  const key = Buffer.from(keyBase64, 'base64');

  for (const encName of encVarNames) {
    const name = encName.slice(ENC_PREFIX.length);

    if (!VALID_NAME.test(name)) {
      throw new Error(`Invalid env var name after stripping prefix: ${name}`);
    }

    const value = env[encName];
    if (!value) {
      throw new Error(`${encName} has no value`);
    }

    if (!value.startsWith(VALUE_PREFIX)) {
      throw new Error(`${encName} does not start with ${VALUE_PREFIX}`);
    }

    const data = Buffer.from(value.slice(VALUE_PREFIX.length), 'base64');
    const iv = data.subarray(0, 12);
    const tag = data.subarray(data.length - 16);
    const ciphertext = data.subarray(12, data.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let plain = decipher.update(ciphertext, undefined, 'utf8');
    plain += decipher.final('utf8');

    env[name] = plain;
    delete env[encName];
  }

  console.log(`Decrypted ${encVarNames.length} encrypted environment variables`);

  // Clean up key material
  delete env.KILOCLAW_ENV_KEY;

  // Post-decrypt presence check
  if (!env.KILOCODE_API_KEY) {
    throw new Error('KILOCODE_API_KEY missing after decryption');
  }
  if (!env.OPENCLAW_GATEWAY_TOKEN) {
    throw new Error('OPENCLAW_GATEWAY_TOKEN missing after decryption');
  }
}

// ---- Step 2: Directory setup ----

/**
 * Create required directories, set working directory, and configure
 * environment variables needed by the gateway process.
 */
export function setupDirectories(env: EnvLike, deps: BootstrapDeps = defaultDeps): void {
  deps.mkdirSync(CONFIG_DIR, { recursive: true });
  deps.chmodSync(CONFIG_DIR, 0o700);
  deps.mkdirSync(WORKSPACE_DIR, { recursive: true });
  deps.mkdirSync(COMPILE_CACHE_DIR, { recursive: true });
  deps.chdir(WORKSPACE_DIR);

  // Avoid extra process self-respawn overhead — the controller already
  // supervises the gateway, so the CLI/gateway don't need their own
  // detached-restart path.
  env.OPENCLAW_NO_RESPAWN = '1';

  // Enable Node's module compile cache.
  env.NODE_COMPILE_CACHE = COMPILE_CACHE_DIR;

  // Tell the gateway it's running under a supervisor. On SIGUSR1 restart,
  // the gateway will exit cleanly (code 0) instead of spawning a detached
  // child process.
  env.INVOCATION_ID = '1';

  // GOG_KEYRING_PASSWORD is NOT a secret — see gog-credentials.ts for context.
  env.GOG_KEYRING_PASSWORD = 'kiloclaw';

  // Derive the API origin for the Kilo CLI from the full base URL.
  if (env.KILOCODE_API_BASE_URL) {
    env.KILO_API_URL = new URL(env.KILOCODE_API_BASE_URL).origin;
  }
}

// ---- Step 3: Feature flags ----

/**
 * Apply instance feature flags from KILOCLAW_* env vars.
 * Creates directories and sets env vars for each enabled flag.
 */
export function applyFeatureFlags(env: EnvLike, deps: BootstrapDeps = defaultDeps): void {
  // npm-global-prefix: redirect `npm install -g` to the persistent volume
  if (env.KILOCLAW_NPM_GLOBAL_PREFIX === 'true') {
    try {
      deps.mkdirSync('/root/.npm-global/bin', { recursive: true });
      env.NPM_CONFIG_PREFIX = '/root/.npm-global';
      env.PATH = `${env.PATH ?? ''}:/root/.npm-global/bin`;
      console.log('npm global prefix set to /root/.npm-global');
    } catch {
      console.warn('WARNING: failed to create npm-global directory, using default prefix');
    }
  }

  // pip-global-prefix: redirect pip install --user to the persistent volume
  if (env.KILOCLAW_PIP_GLOBAL_PREFIX === 'true') {
    try {
      deps.mkdirSync('/root/.pip-global/bin', { recursive: true });
      env.PYTHONUSERBASE = '/root/.pip-global';
      env.PATH = `${env.PATH ?? ''}:/root/.pip-global/bin`;
      console.log('pip global prefix set to /root/.pip-global');
    } catch {
      console.warn('WARNING: failed to create pip-global directory, using default prefix');
    }
  }

  // uv-global-prefix: configure uv tool/cache directories on the persistent volume
  if (env.KILOCLAW_UV_GLOBAL_PREFIX === 'true') {
    try {
      deps.mkdirSync('/root/.uv/tools', { recursive: true });
      deps.mkdirSync('/root/.uv/bin', { recursive: true });
      deps.mkdirSync('/root/.uv/cache', { recursive: true });
      env.UV_TOOL_DIR = '/root/.uv/tools';
      env.UV_TOOL_BIN_DIR = '/root/.uv/bin';
      env.UV_CACHE_DIR = '/root/.uv/cache';
      env.PATH = `${env.PATH ?? ''}:/root/.uv/bin`;
      console.log('uv global prefix set to /root/.uv');
    } catch {
      console.warn('WARNING: failed to create uv directories, using defaults');
    }
  }

  // kilo-cli: alias KILOCODE_API_KEY to KILO_API_KEY for the CLI's KiloAuthPlugin
  if (env.KILOCLAW_KILO_CLI === 'true' && env.KILOCODE_API_KEY) {
    env.KILO_API_KEY = env.KILOCODE_API_KEY;
    console.log('Kilo CLI auto-configuration enabled');
  }
}

// ---- Step 4: Hooks token ----

/**
 * Generate a random hooks token for Gmail push via gog.
 * Only generated when KILOCLAW_GOG_CONFIG_TARBALL is present.
 */
export function generateHooksToken(env: EnvLike): void {
  if (env.KILOCLAW_GOG_CONFIG_TARBALL) {
    env.KILOCLAW_HOOKS_TOKEN = crypto.randomBytes(32).toString('hex');
  }
}

// ---- Step 5: GitHub config ----

/**
 * Configure or clean up GitHub access (gh CLI + git user config).
 * Best-effort: logs warnings on failure, does not throw.
 */
export function configureGitHub(env: EnvLike, deps: BootstrapDeps = defaultDeps): void {
  if (env.GITHUB_TOKEN) {
    console.log('Configuring GitHub access...');

    try {
      deps.execFileSync('gh', ['auth', 'login', '--with-token'], {
        input: env.GITHUB_TOKEN,
        stdio: 'pipe',
      });
      deps.execFileSync('gh', ['auth', 'setup-git'], { stdio: 'pipe' });
      console.log('gh CLI authenticated');
    } catch {
      console.warn('WARNING: gh auth login failed');
    }

    if (env.GITHUB_USERNAME) {
      try {
        deps.execFileSync('git', ['config', '--global', 'user.name', env.GITHUB_USERNAME], {
          stdio: 'pipe',
        });
        console.log(`git user.name set to ${env.GITHUB_USERNAME}`);
      } catch {
        console.warn('WARNING: failed to set git user.name');
      }
    }
    if (env.GITHUB_EMAIL) {
      try {
        deps.execFileSync('git', ['config', '--global', 'user.email', env.GITHUB_EMAIL], {
          stdio: 'pipe',
        });
        console.log(`git user.email set to ${env.GITHUB_EMAIL}`);
      } catch {
        console.warn('WARNING: failed to set git user.email');
      }
    }
  } else {
    // Clean up any previously stored credentials from the persistent volume
    try {
      deps.execFileSync('gh', ['auth', 'logout', '--hostname', 'github.com'], {
        stdio: 'pipe',
      });
    } catch {
      // ignore — may not be logged in
    }
    try {
      deps.execFileSync('git', ['config', '--global', '--unset', 'user.name'], {
        stdio: 'pipe',
      });
    } catch {
      // ignore
    }
    try {
      deps.execFileSync('git', ['config', '--global', '--unset', 'user.email'], {
        stdio: 'pipe',
      });
    } catch {
      // ignore
    }
    console.log('GitHub: not configured (credentials cleared)');
  }
}

// ---- Step 6: Linear config ----

/**
 * Configure or clean up Linear MCP access.
 * Linear access is provided via the Linear MCP server configured in mcporter.
 * When LINEAR_API_KEY is present, mcporter uses it to authenticate.
 * When absent, we just clean up the env var. No on-disk artifacts to clean.
 */
export function configureLinear(env: EnvLike): void {
  if (env.LINEAR_API_KEY) {
    console.log('Linear MCP configured via LINEAR_API_KEY');
  } else {
    delete env.LINEAR_API_KEY;
    console.log('Linear: not configured');
  }
}

// ---- Step 7: Onboard / doctor + config patching ----

/**
 * Run openclaw onboard (first boot) or openclaw doctor (subsequent boots),
 * then patch the config with env-var-derived fields.
 *
 * Sets KILOCLAW_FRESH_INSTALL on the env so downstream consumers
 * (writeKiloCliConfig) can key off it.
 */
/** Adapt BootstrapDeps to ConfigWriterDeps. */
function toConfigWriterDeps(deps: BootstrapDeps): ConfigWriterDeps {
  return {
    readFileSync: deps.readFileSync,
    writeFileSync: deps.writeFileSync,
    renameSync: deps.renameSync,
    copyFileSync: deps.copyFileSync,
    readdirSync: deps.readdirSync,
    unlinkSync: deps.unlinkSync,
    existsSync: deps.existsSync,
    execFileSync: (cmd, args, opts) => {
      deps.execFileSync(cmd, [...args], opts);
    },
  };
}

export function runOnboardOrDoctor(env: EnvLike, deps: BootstrapDeps = defaultDeps): void {
  const configExists = deps.existsSync(CONFIG_PATH);
  const cwDeps = toConfigWriterDeps(deps);

  if (!configExists) {
    console.log('No existing config found, running openclaw onboard...');
    // Set before writeBaseConfig so generateBaseConfig sees it and can
    // override tools.profile to 'full' (the onboard default is 'messaging').
    env.KILOCLAW_FRESH_INSTALL = 'true';
    writeBaseConfig(env, CONFIG_PATH, cwDeps);
    console.log('Onboard completed');

    // Seed TOOLS.md on first provision
    if (deps.existsSync(TOOLS_MD_SOURCE)) {
      deps.mkdirSync(path.dirname(TOOLS_MD_DEST), { recursive: true });
      deps.copyFileSync(TOOLS_MD_SOURCE, TOOLS_MD_DEST);
    }
  } else {
    console.log('Using existing config, running doctor...');
    deps.execFileSync('openclaw', ['doctor', '--fix', '--non-interactive'], {
      stdio: 'inherit',
    });

    // Patch the config with env-var-derived fields
    const config = generateBaseConfig(env, CONFIG_PATH, cwDeps);
    const serialized = JSON.stringify(config, null, 2);
    atomicWrite(CONFIG_PATH, serialized, {
      writeFileSync: deps.writeFileSync,
      renameSync: deps.renameSync,
      unlinkSync: deps.unlinkSync,
    });
    console.log('Configuration patched successfully');

    env.KILOCLAW_FRESH_INSTALL = 'false';
  }
}

// ---- Step 8: TOOLS.md Google Workspace section ----

const GOG_MARKER_BEGIN = '<!-- BEGIN:google-workspace -->';
const GOG_MARKER_END = '<!-- END:google-workspace -->';

const GOG_TOOLS_SECTION = `
${GOG_MARKER_BEGIN}
## Google Workspace

The \`gog\` CLI is configured and ready for Google Workspace operations (Gmail, Calendar, Drive, Docs, Sheets, Slides, Tasks, Forms, Chat, Classroom).

- List accounts: \`gog auth list\`
- Gmail — search: \`gog gmail search --account <email> --query "from:X"\`
- Gmail — read: \`gog gmail get --account <email> <message-id>\`
- Gmail — send: \`gog gmail send --account <email> --to <addr> --subject "..." --body "..."\`
- Calendar — list events: \`gog calendar events list --account <email>\`
- Drive — list files: \`gog drive files list --account <email>\`
- Docs — read: \`gog docs get --account <email> <doc-id>\`
- Run \`gog --help\` and \`gog <service> --help\` for all available commands.
${GOG_MARKER_END}`;

/**
 * Manage the Google Workspace section in TOOLS.md.
 *
 * When gog credentials are present, append a bounded section so the agent
 * knows gog is available. When credentials are absent, remove any stale
 * section. Idempotent: skips if the marker is already present.
 */
export function updateToolsMdGoogleSection(env: EnvLike, deps: BootstrapDeps): void {
  if (!deps.existsSync(TOOLS_MD_DEST)) return;

  const content = deps.readFileSync(TOOLS_MD_DEST, 'utf8');

  if (env.KILOCLAW_GOG_CONFIG_TARBALL) {
    // Google connected — add section if not already present
    if (!content.includes(GOG_MARKER_BEGIN)) {
      deps.writeFileSync(TOOLS_MD_DEST, content + GOG_TOOLS_SECTION);
      console.log('TOOLS.md: added Google Workspace section');
    } else {
      console.log('TOOLS.md: Google Workspace section already present');
    }
  } else {
    // Google not connected — remove stale section if present
    if (content.includes(GOG_MARKER_BEGIN)) {
      const beginIdx = content.indexOf(GOG_MARKER_BEGIN);
      const endIdx = content.indexOf(GOG_MARKER_END);
      if (beginIdx !== -1 && endIdx !== -1) {
        const before = content.slice(0, beginIdx).replace(/\n+$/, '\n');
        const after = content.slice(endIdx + GOG_MARKER_END.length).replace(/^\n+/, '');
        deps.writeFileSync(TOOLS_MD_DEST, before + after);
        console.log('TOOLS.md: removed stale Google Workspace section');
      }
    }
  }
}

// ---- Step 8: TOOLS.md Kilo CLI section ----

const KILO_CLI_MARKER_BEGIN = '<!-- BEGIN:kilo-cli -->';
const KILO_CLI_MARKER_END = '<!-- END:kilo-cli -->';

const KILO_CLI_TOOLS_SECTION = `
${KILO_CLI_MARKER_BEGIN}
## Kilo CLI

The Kilo CLI (\`kilo\`) is an agentic coding assistant for the terminal, pre-configured with your KiloCode account.

- Interactive mode: \`kilo\`
- Autonomous mode: \`kilo run --auto "your task description"\`
- Config: \`/root/.config/kilo/opencode.json\` (customizable, persists across restarts)
- Shares your KiloCode API key and model access with OpenClaw
${KILO_CLI_MARKER_END}`;

/**
 * Ensure the Kilo CLI section is present in TOOLS.md.
 *
 * The kilo binary is always in the image, so this runs unconditionally
 * (not gated on a feature flag). Idempotent: skips if the marker is
 * already present.
 */
export function updateToolsMdKiloCliSection(_env: EnvLike, deps: BootstrapDeps): void {
  if (!deps.existsSync(TOOLS_MD_DEST)) return;

  const content = deps.readFileSync(TOOLS_MD_DEST, 'utf8');

  if (!content.includes(KILO_CLI_MARKER_BEGIN)) {
    deps.writeFileSync(TOOLS_MD_DEST, content + KILO_CLI_TOOLS_SECTION);
    console.log('TOOLS.md: added Kilo CLI section');
  } else {
    console.log('TOOLS.md: Kilo CLI section already present');
  }
}

// ---- Step 9: TOOLS.md 1Password section ----

const OP_MARKER_BEGIN = '<!-- BEGIN:1password -->';
const OP_MARKER_END = '<!-- END:1password -->';

const OP_TOOLS_SECTION = `
${OP_MARKER_BEGIN}
## 1Password

The \`op\` CLI is configured with a 1Password service account. Use it to look up credentials, generate passwords, and manage vault items.

- List vaults: \`op vault list\`
- Search items: \`op item list --vault <vault-name>\`
- Get a credential: \`op item get "<item-name>" --vault <vault-name>\`
- Get specific field: \`op item get "<item-name>" --fields password --vault <vault-name>\`
- Generate password: \`op item create --category login --title "New Login" --generate-password\`
- Run \`op --help\` for all available commands.

**Security note:** Only access credentials the user has explicitly requested. Do not list or expose vault contents unnecessarily.
${OP_MARKER_END}`;

/**
 * Manage the 1Password section in TOOLS.md.
 *
 * When OP_SERVICE_ACCOUNT_TOKEN is present, append a bounded section so the
 * agent knows the op CLI is available. When absent, remove any stale section.
 * Idempotent: skips if the marker is already present.
 */
export function updateToolsMd1PasswordSection(env: EnvLike, deps: BootstrapDeps): void {
  if (!deps.existsSync(TOOLS_MD_DEST)) return;

  const content = deps.readFileSync(TOOLS_MD_DEST, 'utf8');

  if (env.OP_SERVICE_ACCOUNT_TOKEN) {
    // 1Password configured — add section if not already present
    if (!content.includes(OP_MARKER_BEGIN)) {
      deps.writeFileSync(TOOLS_MD_DEST, content + OP_TOOLS_SECTION);
      console.log('TOOLS.md: added 1Password section');
    } else {
      console.log('TOOLS.md: 1Password section already present');
    }
  } else {
    // 1Password not configured — remove stale section if present
    if (content.includes(OP_MARKER_BEGIN)) {
      const beginIdx = content.indexOf(OP_MARKER_BEGIN);
      const endIdx = content.indexOf(OP_MARKER_END);
      if (beginIdx !== -1 && endIdx !== -1) {
        const before = content.slice(0, beginIdx).replace(/\n+$/, '\n');
        const after = content.slice(endIdx + OP_MARKER_END.length).replace(/^\n+/, '');
        deps.writeFileSync(TOOLS_MD_DEST, before + after);
        console.log('TOOLS.md: removed stale 1Password section');
      } else {
        console.warn(
          'TOOLS.md: 1Password BEGIN marker found but END marker missing, skipping removal'
        );
      }
    }
  }
}

// ---- Step 10: TOOLS.md Linear section ----

const LINEAR_MARKER_BEGIN = '<!-- BEGIN:linear -->';
const LINEAR_MARKER_END = '<!-- END:linear -->';

const LINEAR_TOOLS_SECTION = `
${LINEAR_MARKER_BEGIN}
## Linear

Linear is configured as your project management tool. Use it  to track issues, plan projects, and manage product roadmaps.
You can interact with the \`Linear\` MCP server using your \`mcporter\` skill.

  ${LINEAR_MARKER_END}`;

/**
 * Manage the Linear section in TOOLS.md.
 *
 * When LINEAR_API_KEY is present, append a bounded section so the agent
 * knows Linear MCP is available. When absent, remove any stale section.
 * Idempotent: skips if the marker is already present.
 */
export function updateToolsMdLinearSection(env: EnvLike, deps: BootstrapDeps): void {
  if (!deps.existsSync(TOOLS_MD_DEST)) return;

  const content = deps.readFileSync(TOOLS_MD_DEST, 'utf8');

  if (env.LINEAR_API_KEY) {
    // Linear configured — add section if not already present
    if (!content.includes(LINEAR_MARKER_BEGIN)) {
      deps.writeFileSync(TOOLS_MD_DEST, content + LINEAR_TOOLS_SECTION);
      console.log('TOOLS.md: added Linear section');
    } else {
      console.log('TOOLS.md: Linear section already present');
    }
  } else {
    // Linear not configured — remove stale section if present
    if (content.includes(LINEAR_MARKER_BEGIN)) {
      const beginIdx = content.indexOf(LINEAR_MARKER_BEGIN);
      const endIdx = content.indexOf(LINEAR_MARKER_END);
      if (beginIdx !== -1 && endIdx !== -1) {
        const before = content.slice(0, beginIdx).replace(/\n+$/, '\n');
        const after = content.slice(endIdx + LINEAR_MARKER_END.length).replace(/^\n+/, '');
        deps.writeFileSync(TOOLS_MD_DEST, before + after);
        console.log('TOOLS.md: removed stale Linear section');
      } else {
        console.warn(
          'TOOLS.md: Linear BEGIN marker found but END marker missing, skipping removal'
        );
      }
    }
  }
}

// ---- Step 11: Gateway args ----

/**
 * Build the gateway CLI arguments array.
 * Pure function — no side effects.
 */
export function buildGatewayArgs(env: EnvLike): string[] {
  const args = ['--port', '3001', '--verbose', '--allow-unconfigured', '--bind', 'loopback'];
  if (env.OPENCLAW_GATEWAY_TOKEN) {
    args.push('--token', env.OPENCLAW_GATEWAY_TOKEN);
  }
  return args;
}

// ---- Orchestrator ----

/**
 * Run all bootstrap steps in order, reporting progress via setPhase.
 *
 * The controller calls this after its HTTP server is already listening,
 * so /_kilo/health can report the current phase. If any step throws,
 * the error propagates to the controller which enters degraded mode.
 */
/** Yield to the event loop so the HTTP server can process pending requests. */
const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

export async function bootstrap(
  env: EnvLike,
  setPhase: (phase: string) => void,
  deps: BootstrapDeps = defaultDeps
): Promise<void> {
  setPhase('decrypting');
  decryptEnvVars(env);
  await yieldToEventLoop();

  setPhase('directories');
  setupDirectories(env, deps);
  await yieldToEventLoop();

  setPhase('feature-flags');
  applyFeatureFlags(env, deps);

  generateHooksToken(env);
  await yieldToEventLoop();

  setPhase('github');
  configureGitHub(env, deps);
  await yieldToEventLoop();

  setPhase('linear');
  configureLinear(env);
  await yieldToEventLoop();

  const configExists = deps.existsSync(CONFIG_PATH);
  setPhase(configExists ? 'doctor' : 'onboard');
  runOnboardOrDoctor(env, deps);
  await yieldToEventLoop();

  updateToolsMdKiloCliSection(env, deps);
  updateToolsMdGoogleSection(env, deps);
  updateToolsMd1PasswordSection(env, deps);
  updateToolsMdLinearSection(env, deps);

  // Write mcporter config for MCP servers (AgentCard, etc.)
  writeMcporterConfig(env);

  env.KILOCLAW_GATEWAY_ARGS = JSON.stringify(buildGatewayArgs(env));
}
