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

// `localhost` is a hostname, not an IPv4 literal, so isUsableIpv4 rejects it.
// The device paths reach the stack on loopback (an emulator through `adb
// reverse`, a simulator on the shared host), and the dev stack starts with
// MOBILE_DEV_HOST=localhost, so a loopback hostname must be accepted wherever a
// dev host is validated. Without it `pnpm dev:start mobile` dies in
// prepareMobileEnvironment before a single service starts.
const LOOPBACK_HOSTNAMES = new Set(['localhost']);

function isUsableDevHost(value: string | undefined): value is string {
  return typeof value === 'string' && (isUsableIpv4(value) || LOOPBACK_HOSTNAMES.has(value));
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

export { detectLanIp, isUsableDevHost, isUsableIpv4 };
export type { LanIpDeps };
