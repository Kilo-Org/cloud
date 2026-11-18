/* eslint-disable import/no-nodejs-modules, typescript-eslint/no-unsafe-argument, typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-member-access, typescript-eslint/no-unsafe-return, typescript-eslint/strict-boolean-expressions -- Untyped Node script that parses the dev:status JSON of another process. */
// Resolves live service ports from `pnpm dev:status --json` for E2E tests.
// Every port is validated before it reaches a URL.
// An unusable value falls back to the service default plus the stack's port offset.
// Manual run: pnpm -s -w dev:status --json | node apps/extension/scripts/resolve-e2e-ports.mjs
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_PORT = 65_535;
const ESCAPED_SINGLE_QUOTE = String.raw`'\''`;

/** @type {Record<string, number>} */
const DEFAULT_PORTS = {
  'cloud-agent-next': 8794,
  'cloudflare-session-ingest': 8800,
  nextjs: 3000,
};

const isRecord = value => typeof value === 'object' && value !== null;
const isPort = value => Number.isInteger(value) && value >= 1 && value <= MAX_PORT;
const shellQuote = value => `'${String(value).replaceAll("'", ESCAPED_SINGLE_QUOTE)}'`;
const isEntryPoint = path => path !== undefined && import.meta.url === pathToFileURL(path).href;

export const parseDevStatus = input => {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
};

/**
 * Builds the E2E environment variables for the services that `dev:status`
 * reports. Variables already present in `env` are left untouched.
 *
 * @param {unknown} payload Parsed `pnpm dev:status --json` output.
 * @param {Record<string, string | undefined>} [env]
 * @returns {Record<string, string>}
 */
export const resolveE2ePorts = (payload, env = process.env) => {
  const data = isRecord(payload) ? payload : {};
  const offset = Number.isInteger(data.portOffset) && data.portOffset >= 0 ? data.portOffset : 0;
  const services = Array.isArray(data.services) ? data.services : [];

  /** @param {string} name */
  const portFor = name => {
    const fallback = DEFAULT_PORTS[name] + offset;
    const entry = services.find(service => isRecord(service) && service.name === name);
    if (entry === undefined) {
      return fallback;
    }
    if (isPort(entry.port)) {
      return entry.port;
    }
    process.stderr.write(`⚠ ${name} reported no usable port; using ${fallback}\n`);
    return fallback;
  };

  const vars = {};

  if (!env.VITE_KILO_API_BASE_URL) {
    const origin = `http://localhost:${portFor('nextjs')}`;
    vars.VITE_KILO_API_BASE_URL = origin;
    vars.LOCAL_BACKEND_ORIGIN = origin;
  }
  if (!env.VITE_CLOUD_AGENT_WS_URL) {
    vars.VITE_CLOUD_AGENT_WS_URL = `ws://localhost:${portFor('cloud-agent-next')}`;
  }
  if (!env.VITE_SESSION_INGEST_WS_URL) {
    vars.VITE_SESSION_INGEST_WS_URL = `ws://localhost:${portFor('cloudflare-session-ingest')}`;
  }

  return vars;
};

/**
 * Formats resolved variables as a shell `export` statement for manual runs.
 *
 * @param {Record<string, string>} vars
 * @returns {string}
 */
export const formatE2ePortExports = vars => {
  const assignments = Object.entries(vars).map(([key, value]) => `${key}=${shellQuote(value)}`);
  return assignments.length > 0 ? `export ${assignments.join(' ')}\n` : ':\n';
};

if (isEntryPoint(process.argv[1])) {
  const payload = parseDevStatus(readFileSync(0, 'utf8'));
  if (payload === null) {
    process.stderr.write('resolve-e2e-ports: `pnpm dev:status --json` did not print JSON\n');
    process.exit(1);
  }
  process.stdout.write(formatE2ePortExports(resolveE2ePorts(payload, process.env)));
}
