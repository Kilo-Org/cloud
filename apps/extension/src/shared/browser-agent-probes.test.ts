import { describe, expect, it } from 'vitest';
import {
  readSensitiveProbeForFocusedElement,
  readSensitiveProbeForTarget,
} from './browser-agent-probes';
import type { BrowserToolPageSession } from './browser-tool-snapshot';

interface RecordedSend {
  readonly method: string;
  readonly params: Record<string, unknown> | undefined;
}

const PROBE_PASSWORD = JSON.stringify({ fields: [{ kind: 'password' }], paymentFormSubmit: false });

const createSession = (
  handlers: Record<string, (params: Record<string, unknown> | undefined) => Record<string, unknown>>
): {
  readonly sends: RecordedSend[];
  readonly session: Pick<BrowserToolPageSession, 'resolveTarget' | 'send'>;
} => {
  const sends: RecordedSend[] = [];

  return {
    sends,
    session: {
      resolveTarget: (target: string) =>
        Promise.resolve(
          target === 'e12' ? { backendNodeId: 12, kind: 'ref', ref: 'e12' } : undefined
        ),
      send: (method, params) => {
        sends.push({ method, params });

        const handler = handlers[method];

        return handler === undefined
          ? Promise.reject(new Error(`unexpected CDP method ${method}`))
          : Promise.resolve(handler(params));
      },
    },
  };
};

describe('sensitive probes', () => {
  it('resolves a target inside its frame isolated world', async () => {
    const { sends, session } = createSession({
      'DOM.describeNode': () => ({ node: { frameId: 'f1' } }),
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-9' } }),
      'Page.createIsolatedWorld': () => ({ executionContextId: 9 }),
      'Runtime.callFunctionOn': () => ({ result: { value: PROBE_PASSWORD } }),
    });

    await expect(readSensitiveProbeForTarget(session, 'e12')).resolves.toStrictEqual({
      fields: [{ kind: 'password' }],
      paymentFormSubmit: false,
    });

    expect(sends).toContainEqual({
      method: 'Page.createIsolatedWorld',
      params: { frameId: 'f1', grantUniveralAccess: false, worldName: 'kilo-agent-probe' },
    });
    // The node is resolved in the isolated world, not the page's main world where script can shadow `type`/`getAttribute`.
    const resolve = sends.find(entry => entry.method === 'DOM.resolveNode');

    expect(resolve?.params).toMatchObject({ backendNodeId: 12, executionContextId: 9 });
  });

  it('runs the focused probe in the isolated world and follows same-origin frames', async () => {
    const { sends, session } = createSession({
      'Page.createIsolatedWorld': () => ({ executionContextId: 9 }),
      'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'main' } } }),
      'Runtime.evaluate': () => ({ result: { value: PROBE_PASSWORD } }),
    });

    await expect(readSensitiveProbeForFocusedElement(session)).resolves.toStrictEqual({
      fields: [{ kind: 'password' }],
      paymentFormSubmit: false,
    });

    const evaluate = sends.find(entry => entry.method === 'Runtime.evaluate');

    expect(evaluate?.params).toMatchObject({ contextId: 9 });
    expect(String(evaluate?.params?.['expression'])).toContain('IFRAME');
  });
});
