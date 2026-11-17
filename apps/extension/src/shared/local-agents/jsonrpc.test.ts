import { describe, expect, it } from 'vitest';
import {
  LOCAL_AGENT_ERROR_CODES,
  LocalAgentRpcError,
  buildErrorMessage,
  buildNotification,
  buildResultMessage,
  parseJsonRpcMessage,
} from './jsonrpc';

describe('json-rpc parsing', () => {
  it('reads a request with object params', () => {
    expect(
      parseJsonRpcMessage({
        id: 'a',
        jsonrpc: '2.0',
        method: 'session.open',
        params: { title: 't' },
      })
    ).toStrictEqual({ id: 'a', kind: 'request', method: 'session.open', params: { title: 't' } });
  });

  it('does not misread a request as a response without a result', () => {
    const parsed = parseJsonRpcMessage({ id: 1, jsonrpc: '2.0', method: 'session.close' });

    expect(parsed?.kind).toBe('request');
  });

  it('reads a notification', () => {
    expect(
      parseJsonRpcMessage({ jsonrpc: '2.0', method: 'tab.closed', params: { tabId: 3 } })
    ).toStrictEqual({ kind: 'notification', method: 'tab.closed', params: { tabId: 3 } });
  });

  it('reads result and error responses', () => {
    expect(
      parseJsonRpcMessage({ id: 2, jsonrpc: '2.0', result: { sessionHandle: 'h' } })
    ).toStrictEqual({
      id: 2,
      kind: 'response',
      outcome: { ok: true, result: { sessionHandle: 'h' } },
    });
    expect(
      parseJsonRpcMessage({
        error: { code: LOCAL_AGENT_ERROR_CODES.tabBusy, message: 'busy' },
        id: 3,
        jsonrpc: '2.0',
      })
    ).toStrictEqual({
      id: 3,
      kind: 'response',
      outcome: { code: LOCAL_AGENT_ERROR_CODES.tabBusy, message: 'busy', ok: false },
    });
  });

  it('rejects non-objects, wrong versions, and result-less responses', () => {
    expect(parseJsonRpcMessage('hello')).toBeNull();
    expect(parseJsonRpcMessage(null)).toBeNull();
    expect(parseJsonRpcMessage({ id: 1, jsonrpc: '1.0', method: 'x' })).toBeNull();
    expect(parseJsonRpcMessage({ id: 1, jsonrpc: '2.0' })).toBeNull();
    expect(parseJsonRpcMessage({ id: 1, jsonrpc: '2.0', result: 'text' })).toBeNull();
  });
});

describe('json-rpc builders', () => {
  it('builds the exact wire shapes', () => {
    expect(buildResultMessage(1, { ok: true })).toStrictEqual({
      id: 1,
      jsonrpc: '2.0',
      result: { ok: true },
    });
    expect(
      buildErrorMessage({
        code: LOCAL_AGENT_ERROR_CODES.browserUnavailable,
        id: 1,
        message: 'nope',
      })
    ).toStrictEqual({
      error: { code: -32_001, message: 'nope' },
      id: 1,
      jsonrpc: '2.0',
    });
    expect(
      buildNotification('session.revoked', { reason: 'switch_off', sessionHandle: 'h' })
    ).toStrictEqual({
      jsonrpc: '2.0',
      method: 'session.revoked',
      params: { reason: 'switch_off', sessionHandle: 'h' },
    });
  });

  it('uses the SPEC error codes', () => {
    expect(LOCAL_AGENT_ERROR_CODES).toStrictEqual({
      blocked: -32_011,
      browserUnavailable: -32_001,
      internalError: -32_603,
      invalidParams: -32_602,
      methodNotFound: -32_601,
      needsPermission: -32_010,
      originChanged: -32_012,
      protocolMismatch: -32_020,
      tabBusy: -32_002,
      tabTaken: -32_003,
      unsupportedInBrowser: -32_005,
      userStopped: -32_004,
    });
  });

  it('carries the code on the RPC error class', () => {
    const error = new LocalAgentRpcError(LOCAL_AGENT_ERROR_CODES.tabTaken, 'taken');

    expect(error.code).toBe(LOCAL_AGENT_ERROR_CODES.tabTaken);
    expect(error.message).toBe('taken');
  });
});
