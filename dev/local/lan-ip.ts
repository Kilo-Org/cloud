import { execFileSync as defaultExecFileSync } from 'node:child_process';
import * as os from 'node:os';

type LanIpDeps = {
  execFileSync: typeof defaultExecFileSync;
  networkInterfaces: typeof os.networkInterfaces;
};

function isUsableIpv4(value: string | undefined): value is string {
  if (typeof value !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return false;
  }

  return value.split('.').every(part => Number(part) <= 255);
}

function detectLanIp(
  deps: LanIpDeps = { execFileSync: defaultExecFileSync, networkInterfaces: os.networkInterfaces }
): string | undefined {
  try {
    const routeOutput = deps.execFileSync('route', ['-n', 'get', 'default'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const iface = routeOutput.match(/interface:\s*(\S+)/)?.[1];
    if (iface) {
      const ip = deps
        .execFileSync('ipconfig', ['getifaddr', iface], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        .trim();
      if (isUsableIpv4(ip)) {
        return ip;
      }
    }
  } catch {
    // Fall through to Node's cross-platform interface scan.
  }

  for (const addresses of Object.values(deps.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal && isUsableIpv4(address.address)) {
        return address.address;
      }
    }
  }
  return undefined;
}

export { detectLanIp, isUsableIpv4 };
export type { LanIpDeps };
