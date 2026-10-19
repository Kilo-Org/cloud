import { describe, expect, it, vi } from 'vitest';
import {
  assertColdNativeSnapshot,
  assertColdRuntimeUnchanged,
  classifyPermissionReply,
  injectColdPrimaryFault,
  isLiveRuntimeUnavailable,
} from '../../e2e/native-facade-acceptance.js';
import type { DockerCommandExecutor, SandboxContainer } from '../../e2e/sandbox-control.js';

const primary: SandboxContainer = {
  id: 'owned-primary',
  name: 'workerd-cloud-agent-next-dev-SandboxContainers-owned',
  image: 'sandbox:test',
  isProxy: false,
};
const proxy: SandboxContainer = {
  ...primary,
  id: 'owned-proxy',
  name: `${primary.name}-proxy`,
  isProxy: true,
};
const sessionID = 'ses_owned';
const user = { id: 'msg_user', sessionID, role: 'user', time: { created: 1 } };
const assistant = {
  id: 'msg_assistant',
  sessionID,
  role: 'assistant',
  parentID: user.id,
  time: { created: 2, completed: 3 },
};
const part = {
  id: 'part_text',
  sessionID,
  messageID: assistant.id,
  type: 'text',
  text: 'persisted answer',
};
const transcript = [
  { info: user, parts: [] },
  { info: assistant, parts: [part] },
];
const fence = {
  type: 'kilo.native.fence',
  properties: {
    sessionID,
    directory: `/cloud-agent/sessions/${sessionID}`,
    snapshotComplete: true,
    fence: 4,
  },
};
const snapshot = [
  { type: 'message.updated', properties: { info: user } },
  { type: 'message.updated', properties: { info: assistant } },
  { type: 'message.part.updated', properties: { part } },
  fence,
];

describe('ordinary permission autoapproval race', () => {
  const conflict = {
    status: 409,
    body: { error: 'KILO_INTERACTION_UNAVAILABLE' },
    cursor: null,
  };

  it('classifies a vanished interaction after legitimate 409 as blocked, not passed', () => {
    expect(classifyPermissionReply(conflict, [], 'per_owned')).toBe('blocked');
    expect(classifyPermissionReply(conflict, [{ id: 'per_other' }], 'per_owned')).toBe('blocked');
  });

  it('fails a rejected reply if the same interaction remains pending', () => {
    expect(() => classifyPermissionReply(conflict, [{ id: 'per_owned' }], 'per_owned')).toThrow(
      'interaction remains pending'
    );
  });

  it('accepts only an actual successful reply', () => {
    expect(
      classifyPermissionReply({ status: 200, body: true, cursor: null }, [], 'per_owned')
    ).toBe('accepted');
  });

  it('does not hide other response failures as an approval race', () => {
    for (const response of [
      { ...conflict, status: 503 },
      { ...conflict, status: 404 },
      { ...conflict, body: { error: 'OTHER_CONFLICT' } },
    ])
      expect(() => classifyPermissionReply(response, [], 'per_owned')).toThrow();
    expect(() => classifyPermissionReply(conflict, {}, 'per_owned')).toThrow();
  });
});

describe('bounded live runtime polling', () => {
  it('retries only the exact runtime-unavailable response', () => {
    expect(
      isLiveRuntimeUnavailable({
        status: 503,
        body: { error: 'KILO_LIVE_RUNTIME_UNAVAILABLE' },
        cursor: null,
      })
    ).toBe(true);
    for (const response of [
      { status: 200, body: {}, cursor: null },
      { status: 409, body: { error: 'KILO_INTERACTION_UNAVAILABLE' }, cursor: null },
      { status: 503, body: { error: 'KILO_SESSION_SNAPSHOT_PENDING' }, cursor: null },
      { status: 404, body: { error: 'KILO_LIVE_RUNTIME_UNAVAILABLE' }, cursor: null },
    ])
      expect(isLiveRuntimeUnavailable(response)).toBe(false);
  });
});

describe('native acceptance cold primary fault', () => {
  it('kills only the owned primary and leaves its exact proxy running', async () => {
    let containers = [primary, proxy];
    const executeDocker: DockerCommandExecutor = vi.fn(async args => {
      if (args[0] === 'ps')
        return {
          stdout: containers.map(item => `${item.id}\t${item.name}\t${item.image}`).join('\n'),
        };
      if (args[0] === 'kill' && args[1] === primary.id) {
        containers = [proxy];
        return { stdout: primary.id };
      }
      throw new Error(`Unexpected Docker command ${args.join(' ')}`);
    });

    await expect(injectColdPrimaryFault(primary, executeDocker)).resolves.toEqual(proxy);
    expect(executeDocker).toHaveBeenCalledWith(['kill', primary.id]);
    expect(executeDocker).not.toHaveBeenCalledWith(['kill', proxy.id]);
  });

  it('refuses to inject a fault after the owned primary identity changes', async () => {
    const executeDocker: DockerCommandExecutor = vi.fn(async () => ({
      stdout: `replacement\t${primary.name}\t${primary.image}`,
    }));
    await expect(injectColdPrimaryFault(primary, executeDocker)).rejects.toThrow(
      'owned primary identity changed'
    );
    expect(executeDocker).not.toHaveBeenCalledWith(['kill', primary.id]);
  });

  it('refuses to kill a primary whose networking proxy is already absent', async () => {
    const executeDocker: DockerCommandExecutor = vi.fn(async () => ({
      stdout: `${primary.id}\t${primary.name}\t${primary.image}`,
    }));
    await expect(injectColdPrimaryFault(primary, executeDocker)).rejects.toThrow(
      'networking proxy was not found'
    );
    expect(executeDocker).not.toHaveBeenCalledWith(['kill', primary.id]);
  });

  it('rejects a same-name replacement primary during cold reads', () => {
    expect(() =>
      assertColdRuntimeUnchanged([{ ...primary, id: 'replacement' }, proxy], primary, proxy)
    ).toThrow('cold reads woke the sandbox');
  });

  it('rejects a lost or replaced networking proxy', () => {
    expect(() => assertColdRuntimeUnchanged([], primary, proxy)).toThrow('networking proxy');
    expect(() =>
      assertColdRuntimeUnchanged([{ ...proxy, id: 'replacement-proxy' }], primary, proxy)
    ).toThrow('networking proxy');
  });
});

describe('cold native SSE persisted snapshot', () => {
  it('matches the persisted transcript before a complete root-scoped fence', () => {
    expect(assertColdNativeSnapshot(snapshot, sessionID, transcript)).toEqual(fence);
  });

  it('reconciles materialized part rewrites and removals before comparing', () => {
    const replay = [
      ...snapshot.slice(0, -1),
      {
        type: 'message.part.updated',
        properties: { part: { ...part, text: 'obsolete answer' } },
      },
      { type: 'message.part.updated', properties: { part } },
      {
        type: 'message.part.updated',
        properties: { part: { ...part, id: 'removed-part', text: 'removed' } },
      },
      { type: 'message.part.removed', properties: { sessionID, partID: 'removed-part' } },
      fence,
    ];
    expect(assertColdNativeSnapshot(replay, sessionID, transcript)).toEqual(fence);
  });

  it('does not accept transcript parts that arrive only after the fence', () => {
    expect(() =>
      assertColdNativeSnapshot(
        [snapshot[0], snapshot[1], fence, snapshot[2]],
        sessionID,
        transcript
      )
    ).toThrow();
  });

  it('rejects an incomplete or other-session fence', () => {
    for (const properties of [
      { ...fence.properties, snapshotComplete: false },
      { ...fence.properties, sessionID: 'ses_other' },
    ]) {
      expect(() =>
        assertColdNativeSnapshot(
          [...snapshot.slice(0, -1), { ...fence, properties }],
          sessionID,
          transcript
        )
      ).toThrow();
    }
  });

  it('rejects missing or changed persisted text', () => {
    expect(() =>
      assertColdNativeSnapshot(
        [
          snapshot[0],
          snapshot[1],
          { type: 'message.part.updated', properties: { part: { ...part, text: 'changed' } } },
          fence,
        ],
        sessionID,
        transcript
      )
    ).toThrow();
  });

  it('rejects missing or differing completion timestamps rather than masking async persistence defects', () => {
    for (const time of [{ created: 2 }, { created: 2, completed: 4 }]) {
      expect(() =>
        assertColdNativeSnapshot(
          [
            snapshot[0],
            { type: 'message.updated', properties: { info: { ...assistant, time } } },
            snapshot[2],
            fence,
          ],
          sessionID,
          transcript
        )
      ).toThrow();
    }
  });

  it('rejects another session message even when the fence selects the owned root', () => {
    expect(() =>
      assertColdNativeSnapshot(
        [
          ...snapshot.slice(0, -1),
          {
            type: 'message.updated',
            properties: { info: { ...user, id: 'other-user', sessionID: 'ses_other' } },
          },
          fence,
        ],
        sessionID,
        transcript
      )
    ).toThrow('cold SSE leaked another session');
  });
});
