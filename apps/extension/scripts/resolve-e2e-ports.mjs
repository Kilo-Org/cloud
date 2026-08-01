/* eslint-disable import/no-nodejs-modules, typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-member-access, typescript-eslint/strict-boolean-expressions */
// Resolves live service ports from `pnpm dev:status --json` for E2E tests.
// Reads JSON from stdin, outputs `export VAR=val` lines for any VITE_*/LOCAL_*
// Variables not already set in the environment.
import { createInterface } from 'node:readline';

let input = '';
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  input += line;
}

/** @type {{ services?: Array<{ name: string, port: number }>, portOffset?: number }} */
const data = JSON.parse(input);
/** @type {(name: string) => { port: number } | undefined} */
const svc = name => data.services?.find(service => service.name === name);

const portOffset = Number.isInteger(data.portOffset) ? data.portOffset : 0;
const nextjs = svc('nextjs') ?? { port: 3000 + portOffset };
const cloudAgent = svc('cloud-agent-next') ?? { port: 8794 + portOffset };
const ingest = svc('cloudflare-session-ingest') ?? { port: 8800 + portOffset };

const vars = [];

if (!process.env.VITE_KILO_API_BASE_URL) {
  const origin = `http://localhost:${nextjs.port}`;
  vars.push(`VITE_KILO_API_BASE_URL=${origin}`);
  vars.push(`LOCAL_BACKEND_ORIGIN=${origin}`);
}
if (!process.env.VITE_CLOUD_AGENT_WS_URL) {
  const url = `ws://localhost:${cloudAgent.port}`;
  vars.push(`VITE_CLOUD_AGENT_WS_URL=${url}`);
}
if (!process.env.VITE_SESSION_INGEST_WS_URL) {
  const url = `ws://localhost:${ingest.port}`;
  vars.push(`VITE_SESSION_INGEST_WS_URL=${url}`);
}

if (vars.length > 0) {
  process.stdout.write(`export ${vars.join(' ')}\n`);
} else {
  process.stdout.write(':\n');
}
