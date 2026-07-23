import assert from 'node:assert/strict';
import type os from 'node:os';
import test from 'node:test';
import { detectLanIp, isUsableIpv4, type LanIpDeps } from './lan-ip';

type ExecCall = { command: string; args: string[] };

type FakeExec = (command: string, args: readonly string[], options: unknown) => string;

function fakeExec(
  routeResponse: string | undefined,
  ipconfigResponses: Record<string, string | undefined>
): FakeExec {
  return (command: string, args: readonly string[], _options: unknown) => {
    const call: ExecCall = { command, args: [...args] };
    if (call.command === 'route' && call.args.join(' ') === '-n get default') {
      if (routeResponse === undefined) {
        throw new Error('route lookup failed');
      }
      return routeResponse;
    }
    if (call.command === 'ipconfig' && call.args[0] === 'getifaddr') {
      const iface = call.args[1];
      const response = iface !== undefined ? ipconfigResponses[iface] : undefined;
      if (response === undefined) {
        throw new Error(`No IP for interface ${iface ?? 'unknown'}`);
      }
      return response;
    }
    throw new Error(`Unexpected exec: ${call.command} ${call.args.join(' ')}`);
  };
}

test('prefers the default-route interface IP over the first scanned interface', () => {
  const exec = fakeExec('route to: default\ninterface: en0\n', {
    bridge0: '10.211.55.2',
    en0: '192.168.1.10',
  });
  const networkInterfaces: LanIpDeps['networkInterfaces'] = () => ({
    bridge0: [
      { family: 'IPv4', address: '10.211.55.2', internal: false } as os.NetworkInterfaceInfo,
    ],
    en0: [{ family: 'IPv4', address: '192.168.1.10', internal: false } as os.NetworkInterfaceInfo],
  });

  const ip = detectLanIp({ execFileSync: exec as LanIpDeps['execFileSync'], networkInterfaces });
  assert.equal(ip, '192.168.1.10');
});

test('falls back to the first usable non-internal IPv4 when route lookup fails', () => {
  const exec: LanIpDeps['execFileSync'] = () => {
    throw new Error('route lookup failed');
  };
  const networkInterfaces: LanIpDeps['networkInterfaces'] = () => ({
    en0: [{ family: 'IPv4', address: '192.168.1.10', internal: false } as os.NetworkInterfaceInfo],
  });

  const ip = detectLanIp({ execFileSync: exec, networkInterfaces });
  assert.equal(ip, '192.168.1.10');
});

test('rejects IPv4-looking strings with out-of-range octets', () => {
  assert.equal(isUsableIpv4('192.168.1.10'), true);
  assert.equal(isUsableIpv4('256.0.0.1'), false);
  assert.equal(isUsableIpv4('localhost'), false);
  assert.equal(isUsableIpv4(undefined), false);
});
