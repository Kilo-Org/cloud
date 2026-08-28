/* eslint-disable max-lines -- receipt cases and the syntax-aware inventory share this boundary */
/* eslint-disable import/no-nodejs-modules -- this CI inventory reads source files, never native runtime data */
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { type Operation } from '@trpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch, currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import {
  beginAuthenticatedOwner,
  confirmAuthenticatedOwner,
  getAuthenticatedOwner,
} from '@/lib/context-scope';
import {
  initializeLocalAccess,
  LocalAccessDeniedError,
  lockLocalAccess,
  requestLocalAccess,
  setLocalAccessContextReady,
  setLocalAccessOwner,
} from './local-access';
import {
  assertAcceptedWorkReceipt,
  captureMobileActionAdmission,
  captureTransportOperation,
  dispatchAcceptedWork,
} from './local-access-transport';

let stop: (() => void) | undefined = undefined;
beforeEach(async () => {
  setSignOutActive(false);
  confirmAuthenticatedOwner(beginAuthenticatedOwner(), 'A');
  stop = initializeLocalAccess({
    storage: {
      read: vi.fn().mockResolvedValue({ status: 'present', enabled: true }),
      write: vi.fn().mockResolvedValue('committed'),
    },
    authenticate: vi.fn().mockResolvedValue({ status: 'authenticated' }),
    lifecycle: { getCurrentState: () => 'active', subscribe: () => () => undefined },
  });
  await setLocalAccessOwner('A', currentAuthEpoch());
  setLocalAccessContextReady(true);
  await requestLocalAccess('unlock', true);
});
afterEach(() => {
  stop?.();
  setSignOutActive(false);
});
function mutation(path: string, input?: unknown, context: Operation['context'] = {}): Operation {
  return { id: 1, type: 'mutation', path, input, context, signal: undefined };
}
function turn(organizationId: string | null = 'org-A') {
  const effects: string[] = [];
  const admitted = captureMobileActionAdmission(getAuthenticatedOwner(), organizationId);
  const dispatched = dispatchAcceptedWork(
    admitted,
    { kind: 'quick-chat-turn', workId: 'turn-1' },
    () => {
      effects.push('gateway accepted');
      return 'accepted';
    }
  );
  expect(effects).toEqual(['gateway accepted']);
  return dispatched.receipt;
}
function append(receipt: unknown, organizationId: string | null = 'org-A', clientId = 'turn-1') {
  return mutation(
    'quickChat.appendMessages',
    { organizationId, messages: [{ role: 'user', content: 'hi', clientId }] },
    { localAccessReceipt: receipt }
  );
}

describe('final transport admission', () => {
  it.each([
    'activeSessions.createWebTicket',
    'user.registerPushToken',
    'user.unregisterPushToken',
    'user.revokeCurrentDeviceSession',
    'kiloPass.completeAppStorePurchase',
  ])('preserves owner-fenced %s while locked', path => {
    lockLocalAccess();
    const admitted = captureTransportOperation(mutation(path));
    expect(() => {
      admitted.assertDispatch();
    }).not.toThrow();
    bumpAuthEpoch();
    confirmAuthenticatedOwner(beginAuthenticatedOwner(), 'B');
    expect(() => {
      admitted.assertDispatch();
    }).toThrow(LocalAccessDeniedError);
  });
  it('permits logout cleanup, but not registration, during teardown', () => {
    setSignOutActive(true);
    expect(() => {
      captureTransportOperation(mutation('user.unregisterPushToken')).assertDispatch();
    }).not.toThrow();
    expect(() => {
      captureTransportOperation(mutation('user.revokeCurrentDeviceSession')).assertDispatch();
    }).not.toThrow();
    expect(() => captureTransportOperation(mutation('user.registerPushToken'))).toThrow(
      LocalAccessDeniedError
    );
  });
  it.each(['quickChat.getOrCreateThread', 'new.unclassifiedMutation'])(
    'denies new foreground %s and never renews an old action',
    async path => {
      const captured = captureTransportOperation(mutation(path, {}));
      lockLocalAccess();
      expect(() => captureTransportOperation(mutation(path, {}))).toThrow(LocalAccessDeniedError);
      expect(() => {
        captured.assertDispatch();
      }).toThrow(LocalAccessDeniedError);
      await requestLocalAccess('unlock');
      expect(() => {
        captured.assertDispatch();
      }).toThrow(LocalAccessDeniedError);
    }
  );
  it('fences the original credential generation even when the user and auth epoch stay unchanged', () => {
    const operation = captureTransportOperation(mutation('cloudAgentNext.sendMessage', {}));
    confirmAuthenticatedOwner(beginAuthenticatedOwner(), 'A');
    expect(() => {
      operation.assertDispatch();
    }).toThrow(LocalAccessDeniedError);
  });
  it('allows accepted completion after lock and context readiness changes', () => {
    const receipt = turn();
    lockLocalAccess();
    setLocalAccessContextReady(false);
    expect(() => {
      captureTransportOperation(append(receipt)).assertDispatch();
    }).not.toThrow();
  });
  it.each(['missing', 'forged', 'organization', 'turn', 'account'] as const)(
    'rejects %s completion proof',
    kind => {
      const receipt = turn();
      let operation = append(receipt);
      if (kind === 'missing') {
        operation = append(undefined);
      }
      if (kind === 'forged') {
        operation = append({ ...receipt });
      }
      if (kind === 'organization') {
        operation = append(receipt, 'org-B');
      }
      if (kind === 'turn') {
        operation = append(receipt, 'org-A', 'turn-2');
      }
      if (kind === 'account') {
        bumpAuthEpoch();
        confirmAuthenticatedOwner(beginAuthenticatedOwner(), 'B');
      }
      expect(() => captureTransportOperation(operation)).toThrow(LocalAccessDeniedError);
    }
  );
  it('never issues completion proof when final dispatch is denied', () => {
    const admission = captureMobileActionAdmission(getAuthenticatedOwner(), null);
    const effects: string[] = [];
    lockLocalAccess();
    expect(() =>
      dispatchAcceptedWork(admission, { kind: 'quick-chat-turn', workId: 'turn-1' }, () =>
        effects.push('sent')
      )
    ).toThrow(LocalAccessDeniedError);
    expect(effects).toEqual([]);
  });
  it('rejects a Quick Chat receipt for paid purchase completion', () => {
    const receipt = turn(null);
    expect(() =>
      captureTransportOperation(
        mutation('kiloPass.completeAppStorePurchase', {}, { localAccessReceipt: receipt })
      )
    ).toThrow(LocalAccessDeniedError);
    expect(() =>
      assertAcceptedWorkReceipt(receipt, { kind: 'app-store-purchase', organizationId: null })
    ).toThrow(LocalAccessDeniedError);
  });
  it('allows an original paid receipt while locked and rejects a copied receipt', () => {
    const admission = captureMobileActionAdmission(getAuthenticatedOwner(), null);
    const { receipt } = dispatchAcceptedWork(
      admission,
      { kind: 'app-store-purchase', workId: 'paid-1' },
      () => 'StoreKit dispatch'
    );
    lockLocalAccess();
    expect(() => {
      captureTransportOperation(
        mutation('kiloPass.completeAppStorePurchase', {}, { localAccessReceipt: receipt })
      ).assertDispatch();
    }).not.toThrow();
    expect(() =>
      captureTransportOperation(
        mutation('kiloPass.completeAppStorePurchase', {}, { localAccessReceipt: { ...receipt } })
      )
    ).toThrow(LocalAccessDeniedError);
  });
  it('requires a genuine original admission when a caller supplies one', () => {
    const admission = captureMobileActionAdmission(getAuthenticatedOwner(), 'org-A');
    expect(() =>
      captureTransportOperation(
        mutation(
          'cloudAgentNext.sendMessage',
          { organizationId: 'org-B' },
          { localAccessAdmission: admission }
        )
      )
    ).toThrow(LocalAccessDeniedError);
    expect(() =>
      captureTransportOperation(
        mutation(
          'cloudAgentNext.sendMessage',
          { organizationId: 'org-A' },
          { localAccessAdmission: { ...admission } }
        )
      )
    ).toThrow(LocalAccessDeniedError);
  });
});

const transportNames = new Set([
  'fetch',
  'WebSocket',
  'createConnection',
  'createTRPCClient',
  'httpLink',
  'httpBatchLink',
  'createUserWebConnection',
  'createSessionManager',
]);
function transportCalls(text: string): string[] {
  const source = ts.createSourceFile(
    'transport.tsx',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const aliases = new Map<string, string>();
  const found: string[] = [];
  function nameOf(expression: ts.Expression): string {
    if (ts.isIdentifier(expression)) {
      return aliases.get(expression.text) ?? expression.text;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return expression.name.text;
    }
    if (
      ts.isElementAccessExpression(expression) &&
      ts.isStringLiteral(expression.argumentExpression)
    ) {
      return expression.argumentExpression.text;
    }
    return '';
  }
  function visit(node: ts.Node) {
    if (ts.isImportSpecifier(node)) {
      aliases.set(node.name.text, node.propertyName?.text ?? node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const alias = nameOf(node.initializer);
      if (transportNames.has(alias)) {
        aliases.set(node.name.text, alias);
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = nameOf(node.expression);
      if (transportNames.has(name)) {
        found.push(name);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found.toSorted();
}

// Categories describe purpose, not a claim that every passive consumer uses the local action gate.
const inventory: Record<string, { purpose: string; calls: string[] }> = {
  'lib/trpc.ts': {
    purpose: 'owner-fenced reads and guarded mutation adapters',
    calls: ['createTRPCClient', 'fetch', 'httpBatchLink', 'httpLink'],
  },
  'lib/local-access-transport.ts': {
    purpose: 'guarded mobile SDK construction',
    calls: ['createUserWebConnection'],
  },
  'components/quick-chat/quick-chat-gateway.ts': {
    purpose: 'guarded gateway turn dispatch',
    calls: ['fetch'],
  },
  'components/agents/mobile-session-manager.ts': {
    purpose: 'guarded mutation adapters and owner-fenced stream tickets',
    calls: ['createSessionManager', 'fetch'],
  },
  'components/code-reviewer/review-spectator-stream.ts': {
    purpose: 'read-only review stream and ticket',
    calls: ['createConnection', 'fetch'],
  },
  'components/kilo-chat/message-attachment-picker.ts': {
    purpose: 'local file read before upload admission',
    calls: ['fetch'],
  },
  'lib/auth/admission.ts': {
    purpose: 'credential bootstrap attestation challenge',
    calls: ['fetch'],
  },
  'lib/auth/auth-fetch.ts': { purpose: 'native sign-in credential endpoints', calls: ['fetch'] },
  'lib/auth/credentials.ts': { purpose: 'epoch-fenced credential rotation', calls: ['fetch'] },
  'lib/auth/device-auth-poll.ts': { purpose: 'credential bootstrap polling', calls: ['fetch'] },
  'lib/auth/exchange-legacy-token.ts': {
    purpose: 'epoch-fenced legacy credential exchange',
    calls: ['fetch'],
  },
  'lib/auth/use-device-auth.ts': { purpose: 'credential bootstrap device code', calls: ['fetch'] },
  'lib/hooks/use-available-models.ts': {
    purpose: 'read-only model discovery and defaults',
    calls: ['fetch', 'fetch'],
  },
  'lib/hooks/use-force-update.ts': { purpose: 'public minimum version read', calls: ['fetch'] },
  'lib/hooks/use-unread-counts.ts': { purpose: 'read-only badge reconciliation', calls: ['fetch'] },
};
function assertClassified(file: string, text: string) {
  const calls = transportCalls(text);
  const entry = inventory[file];
  if (calls.length === 0 && !entry) {
    return;
  }
  expect(entry, `Unclassified transport: ${file}: ${calls.join(', ')}`).toBeDefined();
  expect(calls, file).toEqual(entry.calls.toSorted());
}
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'test' ? [] : sources(path);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.|test-helpers|test-utils/.test(entry.name)
      ? [path]
      : [];
  });
}

describe('syntax-aware transport inventory', () => {
  it('classifies every direct mobile transport site', () => {
    const root = resolve('src');
    for (const file of sources(root)) {
      assertClassified(relative(root, file), readFileSync(file, 'utf8'));
    }
  });
  it.each([
    'globalThis.fetch("https://example.test");',
    'const send = globalThis["fetch"]; send("https://example.test");',
    'new WebSocket("wss://example.test");',
    'import { createTRPCClient as construct } from "@trpc/client"; construct({ links: [] });',
  ])('rejects an unclassified transport fixture: %s', source => {
    expect(() => {
      assertClassified('unclassified-fixture.ts', source);
    }).toThrow();
  });
  it('rejects an additional transport in an otherwise classified file', () => {
    expect(() => {
      assertClassified(
        'lib/local-access-transport.ts',
        'createUserWebConnection({}); fetch("https://example.test");'
      );
    }).toThrow();
  });
});
