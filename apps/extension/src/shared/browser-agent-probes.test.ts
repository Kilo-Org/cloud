import { describe, expect, it } from 'vitest';
import {
  classifyFocusedElement,
  classifyProbeValue,
  classifyTargetElement,
} from './browser-agent-probes';
import type { BrowserToolPageSession } from './browser-tool-snapshot';

interface RecordedSend {
  readonly method: string;
  readonly params: Record<string, unknown> | undefined;
}

const PASSWORD = JSON.stringify({ fields: [{ kind: 'password' }], paymentFormSubmit: false });
const CLEAN = JSON.stringify({ fields: [], paymentFormSubmit: false });

const createSession = (
  handlers: Record<
    string,
    (params: Record<string, unknown> | undefined) => Record<string, unknown>
  >,
  resolveTarget: (
    target: string
  ) => Promise<{ backendNodeId: number; kind: 'ref'; ref: string } | undefined> = target =>
    Promise.resolve(target === 'e12' ? { backendNodeId: 12, kind: 'ref', ref: 'e12' } : undefined)
): {
  readonly sends: RecordedSend[];
  readonly session: Pick<BrowserToolPageSession, 'resolveTarget' | 'send'>;
} => {
  const sends: RecordedSend[] = [];

  return {
    sends,
    session: {
      resolveTarget,
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

const targetHandlers = (overrides: Record<string, () => Record<string, unknown>> = {}) => ({
  'DOM.describeNode': () => ({ node: { frameId: 'f1' } }),
  'DOM.resolveNode': () => ({ object: { objectId: 'obj-9' } }),
  'Page.createIsolatedWorld': () => ({ executionContextId: 9 }),
  'Runtime.callFunctionOn': () => ({ result: { value: PASSWORD } }),
  ...overrides,
});

const focusedHandlers = (overrides: Record<string, () => Record<string, unknown>> = {}) => ({
  'DOM.describeNode': () => ({ node: { nodeName: 'INPUT' } }),
  'Page.createIsolatedWorld': () => ({ executionContextId: 9 }),
  'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'main' } } }),
  'Runtime.callFunctionOn': () => ({ result: { value: PASSWORD } }),
  'Runtime.evaluate': () => ({ result: { objectId: 'obj-focused' } }),
  ...overrides,
});

describe('sensitive classification', () => {
  it('classifies a well-formed payload or says the element is plain', () => {
    expect(classifyProbeValue(PASSWORD)).toStrictEqual({
      kind: 'sensitive',
      reason: 'typing a password',
    });
    expect(
      classifyProbeValue(
        JSON.stringify({ fields: [{ kind: 'payment' }], paymentFormSubmit: false })
      )
    ).toMatchObject({
      kind: 'sensitive',
    });
    expect(
      classifyProbeValue(JSON.stringify({ fields: [], paymentFormSubmit: true }))
    ).toMatchObject({ kind: 'sensitive' });
    expect(classifyProbeValue(CLEAN)).toStrictEqual({ kind: 'plain' });
  });

  // Every failure shape must count as sensitive: only a fully parsed probe that positively describes an ordinary field may be plain.
  it.each([
    ['no text', null],
    ['a non-string value', { fields: [] }],
    ['malformed JSON', '{not json'],
    ['a JSON scalar', '"text"'],
    ['missing keys', '{}'],
    ['a wrong field type', JSON.stringify({ fields: 'password' })],
    ['an unknown field kind', JSON.stringify({ fields: [{ kind: 'bogus' }] })],
  ])('treats %s as sensitive, never plain', (_label, value) => {
    expect(classifyProbeValue(value).kind).not.toBe('plain');
  });

  it('treats every target-probe failure as sensitive', async () => {
    const failures = [
      createSession(targetHandlers(), () => Promise.reject(new Error('resolve failed'))),
      createSession(targetHandlers({ 'DOM.describeNode': () => ({ node: {} }) })),
      createSession(targetHandlers({ 'Page.createIsolatedWorld': () => ({}) })),
      createSession(targetHandlers({ 'DOM.resolveNode': () => ({ object: {} }) })),
      createSession(targetHandlers({ 'Runtime.callFunctionOn': () => ({ result: {} }) })),
      createSession(
        targetHandlers({ 'Runtime.callFunctionOn': () => ({ result: { value: '{x' } }) })
      ),
      createSession(
        targetHandlers({
          'Runtime.callFunctionOn': () => {
            throw new Error('probe failed');
          },
        })
      ),
    ];

    for (const { session } of failures) {
      // eslint-disable-next-line no-await-in-loop -- each failure shape is independent
      const verdict = await classifyTargetElement(session, 'e12');

      expect(verdict.kind).not.toBe('plain');
    }
  });

  it('classifies a focused field in the isolated world', async () => {
    const { sends, session } = createSession(focusedHandlers());
    const verdict = await classifyFocusedElement(session);

    expect(verdict).toStrictEqual({ kind: 'sensitive', reason: 'typing a password' });
    expect(sends).toContainEqual({
      method: 'Page.createIsolatedWorld',
      params: { frameId: 'main', grantUniveralAccess: false, worldName: 'kilo-agent-probe' },
    });
    const evaluate = sends.find(entry => entry.method === 'Runtime.evaluate');

    expect(evaluate?.params).toMatchObject({ contextId: 9, returnByValue: false });
  });

  it('treats every focused-probe failure as sensitive', async () => {
    const failures = [
      createSession(focusedHandlers({ 'Page.getFrameTree': () => ({}) })),
      createSession(focusedHandlers({ 'Page.createIsolatedWorld': () => ({}) })),
      createSession(focusedHandlers({ 'Runtime.evaluate': () => ({ result: {} }) })),
      createSession(focusedHandlers({ 'DOM.describeNode': () => ({ node: {} }) })),
      createSession(
        focusedHandlers({
          'DOM.describeNode': () => ({ node: { nodeName: 'VIDEO' } }),
          'Runtime.callFunctionOn': () => ({ result: { value: '{}' } }),
        })
      ),
      createSession(
        focusedHandlers({ 'DOM.describeNode': () => ({ node: { nodeName: 'IFRAME' } }) })
      ),
      createSession(
        focusedHandlers({
          'Runtime.evaluate': () => {
            throw new Error('evaluate failed');
          },
        })
      ),
    ];

    for (const { session } of failures) {
      // eslint-disable-next-line no-await-in-loop -- each failure shape is independent
      const verdict = await classifyFocusedElement(session);

      expect(verdict.kind).not.toBe('plain');
    }
  });

  it('marks a focused cross-origin frame sensitive with its owner node', async () => {
    const { session } = createSession(
      focusedHandlers({
        'DOM.describeNode': () => ({ node: { backendNodeId: 41, nodeName: 'IFRAME' } }),
      })
    );

    await expect(classifyFocusedElement(session)).resolves.toStrictEqual({
      frameBackendNodeId: 41,
      kind: 'sensitive',
      reason: 'typing into a field inside a frame the page cannot read',
    });
  });
});
