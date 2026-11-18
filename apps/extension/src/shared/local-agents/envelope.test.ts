/* eslint-disable import/no-nodejs-modules -- the contract header check reads the generated source file */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_TOOL_CONTRACT_SHA,
  LOCAL_AGENT_PROTOCOL_VERSION,
  buildExtensionHello,
  buildRpcEnvelope,
  parseExtensionHello,
  parseHubHello,
  parseIncomingEnvelope,
} from './envelope';

const CONTROLLER_ID = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

describe('contract identity', () => {
  it('announces the SHA-256 from the vendored contract header', () => {
    const source = readFileSync(new URL('../browser-tool-contract.ts', import.meta.url), 'utf8');
    const header = /Raw tools\/list JSON SHA-256: ([0-9a-f]{64})/u.exec(source);

    expect(header?.[1]).toBe(BROWSER_TOOL_CONTRACT_SHA);
  });

  it('advertises protocol 1 only', () => {
    const hello = buildExtensionHello({
      browser: { name: 'Chrome', version: '140.0.0.0' },
      capabilities: {
        console: true,
        dialogs: true,
        fileUpload: true,
        network: true,
        tabGroups: true,
        trustedInput: true,
      },
      extensionVersion: '1.0.4',
      profileLabel: 'Chrome on macOS',
    });

    expect(hello.protocol).toStrictEqual([LOCAL_AGENT_PROTOCOL_VERSION]);
    expect(parseExtensionHello(hello)).not.toBeNull();
  });
});

describe('incoming frame routing', () => {
  it('routes controller lifecycle frames', () => {
    expect(
      parseIncomingEnvelope({ controllerId: CONTROLLER_ID, type: 'controller.connected' })
    ).toStrictEqual({ controllerId: CONTROLLER_ID, type: 'controller.connected' });
    expect(
      parseIncomingEnvelope({ controllerId: CONTROLLER_ID, type: 'controller.disconnected' })
    ).toStrictEqual({ controllerId: CONTROLLER_ID, type: 'controller.disconnected' });
  });

  it('routes a JSON-RPC request inside an rpc envelope', () => {
    const frame = buildRpcEnvelope(CONTROLLER_ID, {
      id: 7,
      jsonrpc: '2.0',
      method: 'session.open',
      params: { cliVersion: '1.0.0', cwd: '/tmp', sessionId: 's-1', title: 'Fix tests' },
    });

    expect(parseIncomingEnvelope(frame)).toStrictEqual({
      controllerId: CONTROLLER_ID,
      message: {
        id: 7,
        kind: 'request',
        method: 'session.open',
        params: { cliVersion: '1.0.0', cwd: '/tmp', sessionId: 's-1', title: 'Fix tests' },
      },
      type: 'rpc',
    });
  });

  it('rejects inbound ext.hello, unknown types, and bad controller ids', () => {
    expect(
      parseIncomingEnvelope({
        browser: { name: 'Chrome', version: '1' },
        capabilities: {
          console: true,
          dialogs: true,
          fileUpload: true,
          network: true,
          tabGroups: true,
          trustedInput: true,
        },
        contractSha: BROWSER_TOOL_CONTRACT_SHA,
        extensionVersion: '1.0.4',
        profileLabel: 'Chrome on macOS',
        protocol: [1],
        type: 'ext.hello',
      })
    ).toBeNull();
    expect(parseIncomingEnvelope({ type: 'unknown' })).toBeNull();
    expect(
      parseIncomingEnvelope({ controllerId: 'controller-1', type: 'controller.connected' })
    ).toBeNull();
  });

  it('rejects an rpc envelope whose message is not JSON-RPC', () => {
    expect(
      parseIncomingEnvelope({
        controllerId: CONTROLLER_ID,
        message: { id: 1, jsonrpc: '2.0' },
        type: 'rpc',
      })
    ).toBeNull();
  });
});

describe('hub hello', () => {
  it('parses protocol, version, and transport mode', () => {
    expect(
      parseHubHello({ hubVersion: '1.2.3', mode: 'loopback', protocol: [1], type: 'hub.hello' })
    ).toStrictEqual({ hubVersion: '1.2.3', mode: 'loopback', protocol: [1], type: 'hub.hello' });
  });

  it('rejects unknown modes and missing protocol versions', () => {
    expect(
      parseHubHello({ hubVersion: '1', mode: 'socket', protocol: [1], type: 'hub.hello' })
    ).toBeNull();
    expect(parseHubHello({ mode: 'native', type: 'hub.hello' })).toBeNull();
  });
});
