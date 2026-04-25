/**
 * Pipelock sidecar integration for the KiloClaw controller.
 *
 * When `KILOCLAW_PIPELOCK_ENABLED` is set to a truthy value, the controller:
 *   1. Ensures a per-VM TLS interception CA exists under /root/.pipelock
 *      (generated idempotently by `pipelock tls init`; private key 0o600).
 *   2. Builds a combined CA bundle for non-Node TLS clients.
 *   3. Writes a managed Pipelock YAML config at /etc/pipelock/config.yaml
 *      (atomic write, mode 0o600).
 *   4. Starts Pipelock under the process supervisor before OpenClaw.
 *   5. Verifies Pipelock's /health response has the expected security features.
 *   6. Injects proxy env vars into the OpenClaw child so env-aware HTTP
 *      clients route through the local forward proxy on 127.0.0.1:8888.
 *
 * Hard invariants enforced here:
 *   - Pipelock itself MUST NOT inherit HTTPS_PROXY (recursion via itself).
 *   - CA private-key file mode is 0o600, enforced defensively on every boot.
 *   - Config file mode is 0o600, re-applied on every boot.
 *   - When the flag is unset or falsy, the env/options helpers return
 *     unchanged behavior (empty env, null supervisor options). The controller
 *     guards filesystem setup behind the same flag.
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { execFileSync as nodeExecFileSync } from 'node:child_process';
import { atomicWrite } from './atomic-write';
import type { Supervisor, SupervisorState } from './supervisor';

export type EnvLike = Record<string, string | undefined>;

// Filesystem layout for the per-VM Pipelock deployment.
export const PIPELOCK_CA_DIR = '/root/.pipelock';
export const PIPELOCK_CA_CERT = '/root/.pipelock/ca.pem';
export const PIPELOCK_CA_KEY = '/root/.pipelock/ca-key.pem';
export const PIPELOCK_CA_BUNDLE = '/root/.pipelock/ca-bundle.pem';
export const PIPELOCK_CONFIG_DIR = '/etc/pipelock';
export const PIPELOCK_CONFIG_PATH = '/etc/pipelock/config.yaml';
export const SYSTEM_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';

// Loopback-only listener; the forward proxy must not be reachable off-VM.
export const PIPELOCK_LISTEN_HOST = '127.0.0.1';
export const PIPELOCK_LISTEN_PORT = 8888;

// Binary name; resolved via PATH inside the KiloClaw image (installed by
// the Dockerfile into /usr/local/bin/pipelock).
export const PIPELOCK_BINARY = 'pipelock';

// Shell convention: 1, true, yes, on are enabled; everything else is disabled.
// Matched case-insensitively after trimming whitespace.
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

// Explicit allowlist for the Pipelock sidecar's spawn environment.
//
// Capability separation requires that Pipelock NOT inherit agent secrets,
// proxy env vars (recursion), or per-instance configuration. The decryption
// step in bootstrap.ts mutates process.env in place, so the controller's
// process.env carries decrypted KILOCODE_API_KEY, OPENCLAW_GATEWAY_TOKEN,
// channel tokens, OAuth material, and KILOCLAW_HOOKS_TOKEN. None of those
// belong in the sidecar.
//
// Every name added to this set is a deliberate concession. Add only when
// pipelock genuinely needs it, and document why in the comment block.
const PIPELOCK_ENV_ALLOWLIST: ReadonlyArray<string> = [
  // Binary lookup, dynamic linker search paths.
  'PATH',
  'LD_LIBRARY_PATH',
  // Pipelock writes audit logs and uses HOME for default state dirs. We pass
  // --config explicitly so home is not load-bearing, but a few Go libs (TLS
  // root discovery, tempfile creation) read $HOME defensively.
  'HOME',
  // Locale and time. Affect log/output formatting only.
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  // Tempfile placement.
  'TMPDIR',
  'TEMP',
  'TMP',
  // Some libraries inspect these to label log output.
  'USER',
  'LOGNAME',
];

export function isPipelockEnabled(env: EnvLike): boolean {
  const raw = env.KILOCLAW_PIPELOCK_ENABLED;
  if (typeof raw !== 'string') return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

type ExecOpts = {
  env?: NodeJS.ProcessEnv;
  stdio?: 'inherit' | 'pipe';
  input?: string;
};

export type PipelockDeps = {
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, opts: { recursive: boolean; mode?: number }) => void;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  chmodSync: (path: string, mode: number) => void;
  writeFileSync: (path: string, data: string) => void;
  renameSync: (oldPath: string, newPath: string) => void;
  unlinkSync: (path: string) => void;
  execFileSync: (cmd: string, args: string[], opts?: ExecOpts) => string;
};

const defaultDeps: PipelockDeps = {
  existsSync: p => fs.existsSync(p),
  mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
  chmodSync: (p, mode) => fs.chmodSync(p, mode),
  writeFileSync: (p, data) => fs.writeFileSync(p, data),
  renameSync: (o, n) => fs.renameSync(o, n),
  unlinkSync: p => fs.unlinkSync(p),
  execFileSync: (cmd, args, opts) =>
    nodeExecFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: opts?.stdio ?? 'pipe',
      env: opts?.env,
      input: opts?.input,
    }),
};

/**
 * Idempotent first-boot CA setup.
 *
 * If both ca.pem and ca-key.pem already exist, returns immediately. The CA
 * is persisted on the Fly Volume and survives machine restarts.
 *
 * If exactly one of the two files exists, throws. Overwriting a half-present
 * CA would invalidate any client that trusted the previous key; manual
 * intervention is required to decide whether to keep or rotate.
 *
 * Otherwise runs `pipelock tls init --out /root/.pipelock` to generate both
 * files, then defensively re-applies mode 0o600 to the private key.
 */
export function ensurePipelockCa(env: EnvLike, deps: PipelockDeps = defaultDeps): void {
  const certExists = deps.existsSync(PIPELOCK_CA_CERT);
  const keyExists = deps.existsSync(PIPELOCK_CA_KEY);

  if (certExists && keyExists) {
    // Enforce private-key mode on every boot in case the underlying volume
    // was restored from a snapshot where the mode drifted.
    deps.chmodSync(PIPELOCK_CA_KEY, 0o600);
    return;
  }

  if (certExists !== keyExists) {
    throw new Error(
      `Pipelock CA state is inconsistent: ca.pem exists=${certExists}, ca-key.pem exists=${keyExists}. ` +
        `Expected both present or both absent. Manual intervention required at ${PIPELOCK_CA_DIR}.`
    );
  }

  // Fresh init. Mode 0o700 on the directory so the private key inherits a
  // tight enclosing dir even before we chmod it explicitly.
  deps.mkdirSync(PIPELOCK_CA_DIR, { recursive: true, mode: 0o700 });
  // Pass the same scrubbed allowlist env to `pipelock tls init` that the
  // sidecar's spawn uses, so the binary cannot read decrypted agent secrets
  // during synchronous CA generation. Closes the capability-separation gap
  // that an inherited `process.env` would open here.
  deps.execFileSync(PIPELOCK_BINARY, ['tls', 'init', '--out', PIPELOCK_CA_DIR], {
    stdio: 'pipe',
    env: getPipelockChildEnv(env),
  });

  // Post-conditions: both files must be present. Guard against a broken or
  // partial binary that returns exit 0 without writing one of the files.
  if (!deps.existsSync(PIPELOCK_CA_CERT) || !deps.existsSync(PIPELOCK_CA_KEY)) {
    throw new Error(
      `pipelock tls init did not produce both ${PIPELOCK_CA_CERT} and ${PIPELOCK_CA_KEY}`
    );
  }

  // Real pipelock already writes the key at 0o600, but re-apply the mode to
  // defend against a future change where the default loosens without our
  // knowledge. Cheaper than trusting the binary's default in perpetuity.
  deps.chmodSync(PIPELOCK_CA_KEY, 0o600);
}

/**
 * Build a combined trust bundle for clients that replace, rather than extend,
 * their CA roots when SSL_CERT_FILE/REQUESTS_CA_BUNDLE/CURL_CA_BUNDLE is set.
 *
 * NODE_EXTRA_CA_CERTS can point at the Pipelock CA alone because Node appends
 * that file to its built-in roots. Python requests, curl, git, npm, and Go
 * commonly treat their env var as the full bundle, so they get system roots
 * plus the per-VM interception CA here.
 */
export function ensurePipelockCaBundle(env: EnvLike, deps: PipelockDeps = defaultDeps): void {
  const systemBundle = deps.readFileSync(SYSTEM_CA_BUNDLE, 'utf8').trimEnd();
  const pipelockCa = deps.readFileSync(PIPELOCK_CA_CERT, 'utf8').trimEnd();

  // Pull in any pre-existing customer-provided CA bundle so the customer's
  // trust roots survive when our combined bundle replaces SSL_CERT_FILE /
  // REQUESTS_CA_BUNDLE / etc. in the OpenClaw child env. Each unique path is
  // read at most once; our own files are skipped to avoid duplication and
  // self-reference loops.
  const customerBundlePaths = new Set<string>();
  const candidateKeys = [
    'SSL_CERT_FILE',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
    'NODE_EXTRA_CA_CERTS',
    'GIT_SSL_CAINFO',
    'NPM_CONFIG_CAFILE',
    'PIP_CERT',
  ];
  for (const key of candidateKeys) {
    const path = env[key];
    if (
      typeof path === 'string' &&
      path !== '' &&
      path !== PIPELOCK_CA_BUNDLE &&
      path !== PIPELOCK_CA_CERT &&
      deps.existsSync(path)
    ) {
      customerBundlePaths.add(path);
    }
  }
  const customerBundles: string[] = [];
  for (const path of customerBundlePaths) {
    try {
      customerBundles.push(deps.readFileSync(path, 'utf8').trimEnd());
    } catch {
      // Best-effort: skip unreadable customer bundles rather than failing
      // the whole bundle generation. The system bundle and Pipelock CA
      // remain present, so TLS validation still works for public roots.
    }
  }

  const desired =
    [systemBundle, ...customerBundles, pipelockCa].filter(s => s.length > 0).join('\n\n') + '\n';

  if (deps.existsSync(PIPELOCK_CA_BUNDLE)) {
    try {
      const current = deps.readFileSync(PIPELOCK_CA_BUNDLE, 'utf8');
      if (current === desired) {
        deps.chmodSync(PIPELOCK_CA_BUNDLE, 0o644);
        return;
      }
    } catch {
      // Fall through to rewrite below.
    }
  }

  atomicWrite(
    PIPELOCK_CA_BUNDLE,
    desired,
    {
      writeFileSync: deps.writeFileSync,
      renameSync: deps.renameSync,
      unlinkSync: deps.unlinkSync,
      chmodSync: deps.chmodSync,
    },
    { mode: 0o644 }
  );
}

/**
 * Write the managed Pipelock config.
 *
 * Content is fully deterministic and regenerated on every boot to match the
 * controller's expectations. If the current on-disk content matches the
 * desired bytes exactly, the write is skipped (only the mode is re-enforced)
 * so normal reboots don't churn the file's mtime.
 */
export function ensurePipelockConfig(_env: EnvLike, deps: PipelockDeps = defaultDeps): void {
  const desired = buildPipelockConfigYaml();

  if (deps.existsSync(PIPELOCK_CONFIG_PATH)) {
    try {
      const current = deps.readFileSync(PIPELOCK_CONFIG_PATH, 'utf8');
      if (current === desired) {
        // Re-apply mode in case something loosened it between reboots.
        deps.chmodSync(PIPELOCK_CONFIG_PATH, 0o600);
        return;
      }
    } catch {
      // Fall through to rewrite on any read error; the atomic write below
      // replaces whatever is there.
    }
  }

  deps.mkdirSync(PIPELOCK_CONFIG_DIR, { recursive: true, mode: 0o755 });
  atomicWrite(
    PIPELOCK_CONFIG_PATH,
    desired,
    {
      writeFileSync: deps.writeFileSync,
      renameSync: deps.renameSync,
      unlinkSync: deps.unlinkSync,
      chmodSync: deps.chmodSync,
    },
    { mode: 0o600 }
  );
}

/**
 * Returns the supervisor invocation for the Pipelock sidecar, or `null` when
 * the integration flag is unset (caller must not start any sidecar).
 */
export function getPipelockSupervisorOptions(env: EnvLike): {
  command: string;
  args: string[];
} | null {
  if (!isPipelockEnabled(env)) return null;
  return {
    command: PIPELOCK_BINARY,
    args: ['run', '--config', PIPELOCK_CONFIG_PATH],
  };
}

/**
 * Build an explicit, secret-free environment for the Pipelock child process.
 *
 * Capability separation requires the sidecar to be in a different trust zone
 * than the agent: agent has secrets and limited network, pipelock has full
 * network and no secrets. The controller's own `process.env` is mutated by
 * bootstrap.ts to contain decrypted agent credentials, so spawning pipelock
 * with an inherited env would silently break the model.
 *
 * Implemented as an allowlist: only names in PIPELOCK_ENV_ALLOWLIST are
 * forwarded. Proxy and CA-trust env vars are deliberately excluded so the
 * sidecar cannot recurse through itself even if a future caller passes a
 * pre-mutated env.
 */
export function getPipelockChildEnv(env: EnvLike): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const key of PIPELOCK_ENV_ALLOWLIST) {
    const value = env[key];
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  // Type bridge: Kilo's worker-configuration.d.ts augments NodeJS.ProcessEnv
  // with worker-required keys (FLY_IMAGE_TAG etc.). The whole point of this
  // function is to NOT include those, so we cross the type boundary
  // deliberately. Node's spawn() accepts any string-valued object at runtime.
  return out as unknown as NodeJS.ProcessEnv;
}

/**
 * Proxy env vars for the OpenClaw child process. Empty object when the
 * integration flag is unset, so callers can spread this into the child env
 * unconditionally.
 *
 * Both upper- and lower-case variants are set because HTTP stacks and CLI tools
 * respect different conventions. NO_PROXY excludes loopback traffic (health
 * checks, internal control plane) from the proxy.
 *
 * NODE_EXTRA_CA_CERTS makes Node's TLS stack trust the per-VM CA so
 * intercepted HTTPS traffic validates inside the OpenClaw agent.
 */
export function getOpenClawProxyEnv(env: EnvLike): Record<string, string> {
  if (!isPipelockEnabled(env)) return {};
  const proxyUrl = `http://${PIPELOCK_LISTEN_HOST}:${PIPELOCK_LISTEN_PORT}`;

  // Merge NO_PROXY with any customer-set bypass list so that pre-existing
  // entries (internal services, private hostnames) keep working when
  // Pipelock is enabled. The customer's entries stay first; our loopback
  // entries are appended.
  const ourNoProxy = '127.0.0.1,localhost,::1';
  const existingNoProxy = env.NO_PROXY ?? env.no_proxy ?? '';
  const mergedNoProxy = existingNoProxy ? `${existingNoProxy},${ourNoProxy}` : ourNoProxy;

  // Customer-provided CA bundles (their values for SSL_CERT_FILE /
  // REQUESTS_CA_BUNDLE / NODE_EXTRA_CA_CERTS / etc.) are concatenated into
  // the combined CA bundle by ensurePipelockCaBundle, so pointing every
  // env var at PIPELOCK_CA_BUNDLE preserves the customer's trust roots.

  return {
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    HTTP_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: mergedNoProxy,
    no_proxy: mergedNoProxy,
    SSL_CERT_FILE: PIPELOCK_CA_BUNDLE,
    REQUESTS_CA_BUNDLE: PIPELOCK_CA_BUNDLE,
    CURL_CA_BUNDLE: PIPELOCK_CA_BUNDLE,
    GIT_SSL_CAINFO: PIPELOCK_CA_BUNDLE,
    NPM_CONFIG_CAFILE: PIPELOCK_CA_BUNDLE,
    PIP_CERT: PIPELOCK_CA_BUNDLE,
    NODE_EXTRA_CA_CERTS: PIPELOCK_CA_CERT,
  };
}

// ─── waitForListening ────────────────────────────────────────────────────────

export type WaitForListeningOptions = {
  intervalMs?: number;
  connect?: (host: string, port: number) => net.Socket;
  now?: () => number;
};

/**
 * Poll a TCP connection to (host, port) until it accepts a connection or the
 * deadline elapses. Used by the controller to block OpenClaw start on
 * Pipelock becoming ready.
 *
 * Returns true on a successful connect, false on timeout. Caller decides
 * degraded behavior on false (we never throw from here; ready/not-ready is
 * the entire contract).
 */
export async function waitForListening(
  host: string,
  port: number,
  timeoutMs: number,
  opts: WaitForListeningOptions = {}
): Promise<boolean> {
  const interval = opts.intervalMs ?? 100;
  const connect = opts.connect ?? ((h, p) => net.createConnection({ host: h, port: p }));
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + timeoutMs;

  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) return false;

    const attemptTimeout = Math.max(Math.min(remaining, interval + 500), 50);
    const ok = await tryConnect(host, port, attemptTimeout, connect);
    if (ok) return true;

    const afterAttempt = deadline - now();
    if (afterAttempt <= 0) return false;
    await delay(Math.min(afterAttempt, interval));
  }
}

export type PipelockHealth = {
  status?: unknown;
  forward_proxy_enabled?: unknown;
  tls_interception_enabled?: unknown;
  response_scan_enabled?: unknown;
  // Pipelock reports kill_switch_active alongside the feature flags. Treat a
  // pre-activated kill switch as "not ready": forward_proxy_enabled may be
  // true but every request will be denied, which is operationally false
  // ready and would mask an intentional operator hold.
  kill_switch_active?: unknown;
};

export type WaitForPipelockReadyOptions = {
  intervalMs?: number;
  getHealth?: (url: string, timeoutMs: number) => Promise<PipelockHealth | null>;
  now?: () => number;
};

/**
 * Poll Pipelock's own health endpoint until the expected security features are
 * active. This is stricter than a bare TCP check: a stray process on 8888 or a
 * Pipelock instance started with the wrong config must not unblock OpenClaw.
 */
export async function waitForPipelockReady(
  host: string,
  port: number,
  timeoutMs: number,
  opts: WaitForPipelockReadyOptions = {}
): Promise<boolean> {
  const interval = opts.intervalMs ?? 100;
  const getHealth = opts.getHealth ?? getPipelockHealth;
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + timeoutMs;
  const url = `http://${host}:${port}/health`;

  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) return false;

    const attemptTimeout = Math.max(Math.min(remaining, interval + 500), 50);
    const health = await getHealth(url, attemptTimeout);
    if (isPipelockHealthReady(health)) return true;

    const afterAttempt = deadline - now();
    if (afterAttempt <= 0) return false;
    await delay(Math.min(afterAttempt, interval));
  }
}

export type WaitForSupervisorAliveOptions = {
  intervalMs?: number;
  now?: () => number;
};

/**
 * Resolve once the supervisor's child has spawned successfully (`running`)
 * or failed to spawn (`crashed`). Used to surface ENOENT / EPERM at
 * supervisor.start() time as a fast `pipelock-start` degradation rather
 * than waiting out the full readiness ceiling.
 *
 * `supervisor.start()` itself returns synchronously after spawn() is called
 * by the OS, before the kernel reports back via the `spawn` or `error`
 * event. This polls the supervisor's state machine instead of relying on
 * that resolution.
 */
export async function waitForSupervisorAlive(
  supervisor: Pick<Supervisor, 'getState'>,
  timeoutMs: number,
  opts: WaitForSupervisorAliveOptions = {}
): Promise<boolean> {
  const interval = opts.intervalMs ?? 25;
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + timeoutMs;

  while (true) {
    const state: SupervisorState = supervisor.getState();
    if (state === 'running') return true;
    if (state === 'crashed' || state === 'stopped') return false;

    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await delay(Math.min(remaining, interval));
  }
}

function tryConnect(
  host: string,
  port: number,
  perAttemptTimeoutMs: number,
  connect: (h: string, p: number) => net.Socket
): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    let sock: net.Socket | null = null;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        sock?.destroy();
      } catch {
        // best-effort cleanup
      }
      resolve(ok);
    };
    try {
      sock = connect(host, port);
    } catch {
      resolve(false);
      return;
    }
    sock.setTimeout(perAttemptTimeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

function getPipelockHealth(url: string, timeoutMs: number): Promise<PipelockHealth | null> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (health: PipelockHealth | null) => {
      if (settled) return;
      settled = true;
      resolve(health);
    };

    const req = http.get(url, res => {
      if (res.statusCode !== 200) {
        res.resume();
        finish(null);
        return;
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 16_384) {
          req.destroy();
          finish(null);
        }
      });
      res.on('end', () => {
        try {
          const parsed: unknown = JSON.parse(body);
          finish(isRecord(parsed) ? parsed : null);
        } catch {
          finish(null);
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(null);
    });
    req.once('error', () => finish(null));
  });
}

function isPipelockHealthReady(health: PipelockHealth | null): boolean {
  if (!health) return false;
  if (health.status !== 'healthy') return false;
  if (health.forward_proxy_enabled !== true) return false;
  if (health.tls_interception_enabled !== true) return false;
  if (health.response_scan_enabled !== true) return false;
  // Refuse readiness when the kill switch is pre-activated. Field is
  // optional in older pipelock builds; absence is treated as "off" so we
  // do not block on missing telemetry.
  if (health.kill_switch_active === true) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── YAML generation ────────────────────────────────────────────────────────
//
// Hand-written rather than pulling in a YAML serializer: the output is a
// small, fully static template and the KiloClaw controller package avoids
// adding dependencies unless there is no existing primitive. See
// services/kiloclaw/AGENTS.md ("Use existing deps; check package.json").

function buildPipelockConfigYaml(): string {
  return [
    '# Managed by the KiloClaw controller. Do not edit by hand.',
    '# Regenerated on every boot from services/kiloclaw/controller/src/pipelock.ts.',
    'version: 1',
    'mode: balanced',
    '',
    'fetch_proxy:',
    `  listen: ${PIPELOCK_LISTEN_HOST}:${PIPELOCK_LISTEN_PORT}`,
    '',
    'forward_proxy:',
    '  enabled: true',
    '',
    'tls_interception:',
    '  enabled: true',
    `  ca_cert: ${PIPELOCK_CA_CERT}`,
    `  ca_key: ${PIPELOCK_CA_KEY}`,
    '',
    'response_scanning:',
    '  enabled: true',
    '  sse_streaming:',
    '    enabled: true',
    '',
  ].join('\n');
}
