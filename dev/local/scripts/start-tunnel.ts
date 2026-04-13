import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureCloudflared, startCloudflaredTunnel, updateEnvValue } from './cloudflared-tunnel';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const devVarsPath = path.join(repoRoot, 'services/kiloclaw/.dev.vars');

type TunnelConfig = {
  tunnelName: string;
  tunnelHostname: string;
};

function parseConfFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const result: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eqIndex = trimmed.indexOf('=');
    const key = trimmed.slice(0, eqIndex).trim();
    const raw = trimmed.slice(eqIndex + 1).trim();
    result[key] = raw.replace(/^["']|["']$/g, '');
  }
  return result;
}

function loadTunnelConfig(): TunnelConfig {
  const globalPath = path.join(os.homedir(), '.config/kiloclaw/dev-start.conf');
  const localPath = path.join(repoRoot, 'services/kiloclaw/scripts/.dev-start.conf');

  const merged = {
    ...parseConfFile(globalPath),
    ...parseConfFile(localPath),
  };

  return {
    tunnelName: merged['TUNNEL_NAME'] ?? '',
    tunnelHostname: merged['TUNNEL_HOSTNAME'] ?? '',
  };
}

ensureCloudflared();

const port = process.argv[2] ?? '3000';
const config = loadTunnelConfig();

startCloudflaredTunnel({
  port,
  namedTunnel: config.tunnelName
    ? {
        name: config.tunnelName,
        hostname: config.tunnelHostname,
      }
    : undefined,
  onCapture: url => {
    const apiUrl = `${url}/api/gateway/`;
    updateEnvValue(devVarsPath, 'KILOCODE_API_BASE_URL', apiUrl);

    console.log(`\nTunnel URL: ${url}`);
    console.log(`Set KILOCODE_API_BASE_URL=${apiUrl}`);
  },
});
