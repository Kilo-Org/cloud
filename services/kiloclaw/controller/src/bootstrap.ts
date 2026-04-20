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
const IDENTITY_MD_DEST = '/root/.openclaw/workspace/IDENTITY.md';
const USER_MD_DEST = '/root/.openclaw/workspace/USER.md';
const LEGACY_BOT_IDENTITY_DESTS = ['/root/.openclaw/workspace/BOOTSTRAP.md'];

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

/** Generate a per-boot random hooks token for local gateway hook delivery. */
export function generateHooksToken(env: EnvLike): void {
  env.KILOCLAW_HOOKS_TOKEN = crypto.randomBytes(32).toString('hex');
}

export function formatBotIdentityMarkdown(env: EnvLike): string {
  const lines = [
    '# IDENTITY',
    '',
    `- Name: ${env.KILOCLAW_BOT_NAME ?? 'KiloClaw'}`,
    `- Nature: ${env.KILOCLAW_BOT_NATURE ?? 'AI executive assistant'}`,
    `- Vibe: ${env.KILOCLAW_BOT_VIBE ?? 'Helpful, calm, and proactive'}`,
    `- Emoji: ${env.KILOCLAW_BOT_EMOJI ?? '🦾'}`,
    '',
    'Use this file as the canonical identity and tone reference for the bot.',
    '',
  ];
  return lines.join('\n');
}

export function writeBotIdentityFile(
  env: EnvLike,
  deps: Pick<
    BootstrapDeps,
    'mkdirSync' | 'writeFileSync' | 'renameSync' | 'unlinkSync' | 'existsSync'
  > = defaultDeps
): void {
  deps.mkdirSync(path.dirname(IDENTITY_MD_DEST), { recursive: true });
  atomicWrite(IDENTITY_MD_DEST, formatBotIdentityMarkdown(env), {
    writeFileSync: deps.writeFileSync,
    renameSync: deps.renameSync,
    unlinkSync: deps.unlinkSync,
  });

  for (const legacyPath of LEGACY_BOT_IDENTITY_DESTS) {
    if (!deps.existsSync(legacyPath)) continue;
    try {
      deps.unlinkSync(legacyPath);
    } catch (error) {
      console.warn(`[controller] Failed to remove legacy bot identity file ${legacyPath}:`, error);
    }
  }
}

export function formatUserProfileMarkdown(timezone: string): string {
  return [
    '# USER.md - About Your Human',
    '',
    'Learn about the person you are helping. Update this as you go.',
    '',
    '- Name:',
    '- What to call them:',
    '- Pronouns: (optional)',
    `- Timezone: ${timezone}`,
    '- Notes:',
    '',
    '## Context',
    '',
    'What do they care about? What projects are they working on? What annoys them? What makes them laugh? Build this over time.',
    '',
    '---',
    '',
    'The more you know, the better you can help. But remember -- you are learning about a person, not building a dossier. Respect the difference.',
    '',
  ].join('\n');
}

export function setUserMdTimezone(content: string, timezone: string): string {
  const lines = content.split('\n');
  const plainTimezoneLine = /^(\s*-\s*Timezone:)\s*.*/i;
  const boldTimezoneLine = /^(\s*-\s*\*\*Timezone:\*\*)\s*.*/i;

  const updatedLines = lines.map(line => {
    if (plainTimezoneLine.test(line)) {
      return line.replace(plainTimezoneLine, `$1 ${timezone}`);
    }
    if (boldTimezoneLine.test(line)) {
      return line.replace(boldTimezoneLine, `$1 ${timezone}`);
    }
    return line;
  });

  if (updatedLines.some((line, index) => line !== lines[index])) {
    return updatedLines.join('\n');
  }

  const separator = content.endsWith('\n') ? '' : '\n';
  return `${content}${separator}\n- Timezone: ${timezone}\n`;
}

export function writeUserProfileTimezoneFile(
  env: EnvLike,
  deps: Pick<
    BootstrapDeps,
    'mkdirSync' | 'writeFileSync' | 'renameSync' | 'unlinkSync' | 'existsSync' | 'readFileSync'
  > = defaultDeps
): void {
  const timezone = env.KILOCLAW_USER_TIMEZONE;
  if (!timezone) return;

  deps.mkdirSync(path.dirname(USER_MD_DEST), { recursive: true });
  const userMdExists = deps.existsSync(USER_MD_DEST);
  const content = userMdExists
    ? deps.readFileSync(USER_MD_DEST, 'utf8')
    : formatUserProfileMarkdown(timezone);
  const nextContent = userMdExists ? setUserMdTimezone(content, timezone) : content;

  if (userMdExists && nextContent === content) return;

  atomicWrite(USER_MD_DEST, nextContent, {
    writeFileSync: deps.writeFileSync,
    renameSync: deps.renameSync,
    unlinkSync: deps.unlinkSync,
  });
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
    chmodSync: deps.chmodSync,
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
    atomicWrite(
      CONFIG_PATH,
      serialized,
      {
        writeFileSync: deps.writeFileSync,
        renameSync: deps.renameSync,
        unlinkSync: deps.unlinkSync,
        chmodSync: deps.chmodSync,
      },
      { mode: 0o600 }
    );
    console.log('Configuration patched successfully');

    env.KILOCLAW_FRESH_INSTALL = 'false';
  }

  writeBotIdentityFile(env, deps);
  writeUserProfileTimezoneFile(env, deps);
}

// ---- TOOLS.md bounded-section helper ----

export type ToolsMdSectionConfig = {
  name: string;
  beginMarker: string;
  endMarker: string;
  section: string;
};

/**
 * Manage a bounded section in TOOLS.md.
 *
 * When `enabled` is true, append the section if not already present.
 * When `enabled` is false, remove any stale section.
 * Idempotent: skips if the marker is already present.
 */
export function updateToolsMdSection(
  enabled: boolean,
  config: ToolsMdSectionConfig,
  deps: BootstrapDeps
): void {
  if (!deps.existsSync(TOOLS_MD_DEST)) return;

  const content = deps.readFileSync(TOOLS_MD_DEST, 'utf8');

  if (enabled) {
    if (!content.includes(config.beginMarker)) {
      deps.writeFileSync(TOOLS_MD_DEST, content + config.section);
      console.log(`TOOLS.md: added ${config.name} section`);
    } else {
      console.log(`TOOLS.md: ${config.name} section already present`);
    }
  } else {
    if (content.includes(config.beginMarker)) {
      const beginIdx = content.indexOf(config.beginMarker);
      const endIdx = content.indexOf(config.endMarker);
      if (beginIdx !== -1 && endIdx !== -1) {
        const before = content.slice(0, beginIdx).replace(/\n+$/, '\n');
        const after = content.slice(endIdx + config.endMarker.length).replace(/^\n+/, '');
        deps.writeFileSync(TOOLS_MD_DEST, before + after);
        console.log(`TOOLS.md: removed stale ${config.name} section`);
      } else {
        console.warn(
          `TOOLS.md: ${config.name} BEGIN marker found but END marker missing, skipping removal`
        );
      }
    }
  }
}

// ---- TOOLS.md section configs ----

export const GOG_SECTION_CONFIG: ToolsMdSectionConfig = {
  name: 'Google Workspace',
  beginMarker: '<!-- BEGIN:google-workspace -->',
  endMarker: '<!-- END:google-workspace -->',
  section: `
<!-- BEGIN:google-workspace -->
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
<!-- END:google-workspace -->`,
};

export const KILO_CLI_SECTION_CONFIG: ToolsMdSectionConfig = {
  name: 'Kilo CLI',
  beginMarker: '<!-- BEGIN:kilo-cli -->',
  endMarker: '<!-- END:kilo-cli -->',
  section: `
<!-- BEGIN:kilo-cli -->
## Kilo CLI

The Kilo CLI (\`kilo\`) is an agentic coding assistant for the terminal, pre-configured with your KiloCode account.

- Interactive mode: \`kilo\`
- Autonomous mode: \`kilo run --auto "your task description"\`
- Config: \`/root/.config/kilo/kilo.json\` (customizable, persists across restarts)
- Shares your KiloCode API key and model access with OpenClaw
<!-- END:kilo-cli -->`,
};

export const OP_SECTION_CONFIG: ToolsMdSectionConfig = {
  name: '1Password',
  beginMarker: '<!-- BEGIN:1password -->',
  endMarker: '<!-- END:1password -->',
  section: `
<!-- BEGIN:1password -->
## 1Password

The \`op\` CLI is configured with a 1Password service account. Use it to look up credentials, generate passwords, and manage vault items.

- List vaults: \`op vault list\`
- Search items: \`op item list --vault <vault-name>\`
- Get a credential: \`op item get "<item-name>" --vault <vault-name>\`
- Get specific field: \`op item get "<item-name>" --fields password --vault <vault-name>\`
- Generate password: \`op item create --category login --title "New Login" --generate-password\`
- Run \`op --help\` for all available commands.

**Security note:** Only access credentials the user has explicitly requested. Do not list or expose vault contents unnecessarily.
<!-- END:1password -->`,
};

export const LINEAR_SECTION_CONFIG: ToolsMdSectionConfig = {
  name: 'Linear',
  beginMarker: '<!-- BEGIN:linear -->',
  endMarker: '<!-- END:linear -->',
  section: `
<!-- BEGIN:linear -->
## Linear

Linear is configured as your project management tool. Use it  to track issues, plan projects, and manage product roadmaps.
You can interact with the \`Linear\` MCP server using your \`mcporter\` skill.

  <!-- END:linear -->`,
};

// Additional KiloClaw-mitigated OpenClaw audit findings beyond the
// gateway.control_ui.insecure_auth one already documented in the base
// TOOLS.md. Mirrors the list in apps/web/src/lib/security-advisor/
// kiloclaw-mitigations.ts — the server-side /security-checkup path
// suppresses these before grading, but when a user runs `openclaw doctor`
// directly the findings still show and the agent needs the same context
// to explain them. Added unconditionally on every bootstrap, idempotent.
export const KILOCLAW_MITIGATIONS_SECTION_CONFIG: ToolsMdSectionConfig = {
  name: 'KiloClaw Mitigations',
  beginMarker: '<!-- BEGIN:kiloclaw-mitigations -->',
  endMarker: '<!-- END:kiloclaw-mitigations -->',
  section: `
<!-- BEGIN:kiloclaw-mitigations -->
## Additional KiloClaw Mitigations

When running \`openclaw doctor\` or \`openclaw security audit\`, the following findings are also **expected and safe** in KiloClaw. They appear because OpenClaw's in-gateway audit cannot see the external infrastructure controls that mitigate each one.

- **\`gateway.trusted_proxies_missing\`** — The gateway runs on loopback only. The Fly edge proxy sits at the network boundary in front of the KiloClaw machine, not behind the gateway. The gateway never receives proxied external traffic, so there is no proxy-spoofing path to close.
- **\`config.insecure_or_dangerous_flags\`** — Fires because of \`gateway.control_ui.insecure_auth\` above. It is the same architectural choice surfaced twice in the audit output.
- **\`plugins.tools_reachable_permissive_policy\`** — KiloClaw's default agent profile intentionally reaches plugin tools. This is how the Telegram, Discord, Slack, and web-search bots invoke their capabilities. Restricting it would break the core bot workflow.
- **\`hooks.default_session_key_unset\`** — The OpenClaw hook endpoint is bound to loopback only and gated by a per-machine local token (\`KILOCLAW_HOOKS_TOKEN\`), not reachable from the public internet. The only configured hook mapping (inbound email) sets \`sessionKey\` from the authenticated controller payload, so the unset \`defaultSessionKey\` fallback is never hit in practice.
- **\`hooks.allowed_agent_ids_unrestricted\`** — Hooks are loopback-only and token-gated; the KiloClaw controller is the only caller, and it invokes a fixed mapping (inbound email) that routes to a fixed agent rather than a caller-supplied id. There is no external path to name an arbitrary agent id.
- **\`fs.config.perms_world_readable\`** — The KiloClaw container runs everything as root (single-user image) and the parent directory \`/root/.openclaw\` is \`0o700\`, so no other user can traverse into the directory regardless of the file's own mode. The controller also writes \`openclaw.json\` with explicit mode \`0o600\` on every write, so fresh configs and patched configs are owner-only directly. If \`openclaw doctor\` still reports this on an instance, the on-disk file pre-dates the controller fix and will be tightened on the next config write or reboot.

**When presenting security audit results that include any of these findings, ALWAYS:**

1. Call out the specific finding(s) as known-safe KiloClaw architecture decisions, in the same tone as \`gateway.control_ui.insecure_auth\` above.
2. Explain WHY each is safe using the per-finding rationale above.
3. Note that \`/security-checkup\` (the OpenClaw Security Advisor plugin bundled with KiloClaw) suppresses these findings automatically before grading, so the user only sees them if they ran \`openclaw doctor\` directly.
<!-- END:kiloclaw-mitigations -->`,
};

// Tells the agent to keep plugins.allow in sync whenever a plugin is
// installed on the user's behalf. OpenClaw's \`openclaw plugins install\`
// CLI does auto-append to plugins.allow (verified in openclaw/src/plugins/
// enable.ts), but we have seen real-world cases where plugins land in
// extensions/ without allow being updated (manual file drops, older
// OpenClaw versions, users editing openclaw.json). This section is a
// belt-and-suspenders reminder for the agent flow, not the load-bearing
// fix.
export const PLUGIN_INSTALL_SECTION_CONFIG: ToolsMdSectionConfig = {
  name: 'Plugin Install',
  beginMarker: '<!-- BEGIN:plugin-install -->',
  endMarker: '<!-- END:plugin-install -->',
  section: `
<!-- BEGIN:plugin-install -->
## Plugin Install Context

When installing an OpenClaw plugin on the user's behalf:

1. ALWAYS use the \`openclaw plugins install <id>\` CLI command. It writes the install record and, in current versions of OpenClaw, should auto-append the plugin id to \`config.plugins.allow\` in \`/root/.openclaw/openclaw.json\`.
2. After a plugin install, read \`plugins.allow\` from the config and reconcile carefully. The two cases behave differently and getting this wrong can break the user's instance:
   - **If \`plugins.allow\` is an existing array**, verify the new id is in it. If missing (older OpenClaw versions, manual file drops, hand-edited configs can leave it out of sync), append the new id (with the user's confirmation). Do NOT remove or reorder existing ids.
   - **If \`plugins.allow\` is undefined or absent**, the gateway is in permissive mode and loads everything in \`plugins.load.paths\`. DO NOT create \`plugins.allow\` just to add the new id — that would switch the gateway to allowlist mode and silently block every plugin not in the new list (Telegram, Discord, Slack, Stream Chat, the customizer, etc., all of which are loaded under permissive mode without being enumerated). Leave \`plugins.allow\` undefined and rely on \`plugins.load.paths\` instead.
3. Do NOT drop plugin files manually into \`/root/.openclaw/extensions/\`. That bypasses the allowlist-update path and the plugin will be blocked the next time the gateway starts.
<!-- END:plugin-install -->`,
};

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

export async function bootstrapCritical(
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
  env.KILOCLAW_GATEWAY_ARGS = JSON.stringify(buildGatewayArgs(env));
  await yieldToEventLoop();
}

export type BootstrapNonCriticalResult = { ok: true } | { ok: false; phase: string; error: string };

type BootstrapStep = { phase: string; run: () => void | Promise<void> };

export async function bootstrapNonCritical(
  env: EnvLike,
  setPhase: (phase: string) => void,
  deps: BootstrapDeps = defaultDeps
): Promise<BootstrapNonCriticalResult> {
  await yieldToEventLoop();
  const configPhase = deps.existsSync(CONFIG_PATH) ? 'doctor' : 'onboard';

  const steps: BootstrapStep[] = [
    { phase: 'github', run: () => configureGitHub(env, deps) },
    { phase: 'linear', run: () => configureLinear(env) },
    { phase: configPhase, run: () => runOnboardOrDoctor(env, deps) },
    {
      phase: 'tools-md',
      run: () => {
        updateToolsMdSection(true, KILO_CLI_SECTION_CONFIG, deps);
        updateToolsMdSection(!!env.KILOCLAW_GOG_CONFIG_TARBALL, GOG_SECTION_CONFIG, deps);
        updateToolsMdSection(!!env.OP_SERVICE_ACCOUNT_TOKEN, OP_SECTION_CONFIG, deps);
        updateToolsMdSection(!!env.LINEAR_API_KEY, LINEAR_SECTION_CONFIG, deps);
        // Always-on: agent context about KiloClaw-mitigated audit findings
        // and how to keep plugins.allow in sync on plugin installs.
        updateToolsMdSection(true, KILOCLAW_MITIGATIONS_SECTION_CONFIG, deps);
        updateToolsMdSection(true, PLUGIN_INSTALL_SECTION_CONFIG, deps);
      },
    },
    {
      phase: 'mcporter',
      run: () => {
        writeMcporterConfig(env);
      },
    },
  ];

  for (const step of steps) {
    try {
      setPhase(step.phase);
      await step.run();
      await yieldToEventLoop();
    } catch (error) {
      return {
        ok: false,
        phase: step.phase,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { ok: true };
}

export async function bootstrap(
  env: EnvLike,
  setPhase: (phase: string) => void,
  deps: BootstrapDeps = defaultDeps
): Promise<void> {
  await bootstrapCritical(env, setPhase, deps);
  const result = await bootstrapNonCritical(env, setPhase, deps);
  if (!result.ok) {
    throw new Error(result.error);
  }
}
