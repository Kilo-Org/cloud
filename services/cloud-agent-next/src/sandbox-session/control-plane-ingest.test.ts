import { describe, expect, it, vi } from 'vitest';
import {
  cloudAgentSessionScopeHeaders,
  cloudAgentSessionScopeProtocolVersion,
} from '@kilocode/session-ingest-contracts';
import {
  controlEventToIngestItems,
  ingestKiloSessionId,
  publishControlPlaneSessionIngest,
} from './control-plane-ingest.js';

describe('controlEventToIngestItems', () => {
  it('maps message and part updates', () => {
    expect(
      controlEventToIngestItems('message.updated', { info: { id: 'msg_1', role: 'user' } })
    ).toEqual([{ type: 'message', data: { id: 'msg_1', role: 'user' } }]);
    expect(
      controlEventToIngestItems('message.part.updated', { part: { id: 'prt_1', type: 'text' } })
    ).toEqual([{ type: 'part', data: { id: 'prt_1', type: 'text' } }]);
  });

  it.each(['session.created', 'session.updated'] as const)('maps %s events', type => {
    expect(
      controlEventToIngestItems(type, { info: { id: 'ses_root', title: 'Root session' } })
    ).toEqual([{ type: 'session', data: { id: 'ses_root', title: 'Root session' } }]);
  });

  it.each(['busy', 'idle', 'retry'] as const)('maps %s session status events', status => {
    expect(
      controlEventToIngestItems('session.status', {
        sessionID: 'ses_root',
        status: { type: status },
      })
    ).toEqual([{ type: 'session_status', data: { status } }]);
  });

  it('projects retry status without retaining runtime details', () => {
    expect(
      controlEventToIngestItems('session.status', {
        sessionID: 'ses_root',
        status: { type: 'retry', attempt: 2, message: 'Rate limited', next: 5_000 },
      })
    ).toEqual([{ type: 'session_status', data: { status: 'retry' } }]);
  });

  it('normalizes offline runtime status to the supported retry status', () => {
    expect(
      controlEventToIngestItems('session.status', {
        sessionID: 'ses_root',
        status: { type: 'offline', requestID: 'req_1', message: 'Network unavailable' },
      })
    ).toEqual([{ type: 'session_status', data: { status: 'retry' } }]);
  });

  it.each([undefined, null, 'busy', true, 1, [], {}, { type: null }, { type: 1 }])(
    'rejects malformed session status payload %p',
    status => {
      expect(
        controlEventToIngestItems('session.status', { sessionID: 'ses_root', status })
      ).toEqual([]);
    }
  );

  it.each(['unknown', 'question', 'permission', 'finalizing'])(
    'rejects unsupported %s status',
    status => {
      expect(
        controlEventToIngestItems('session.status', {
          sessionID: 'ses_root',
          status: { type: status },
        })
      ).toEqual([]);
    }
  );

  it.each([
    { name: 'missing', properties: { status: { type: 'busy' } } },
    { name: 'empty', properties: { sessionID: '', status: { type: 'busy' } } },
    { name: 'non-string', properties: { sessionID: 1, status: { type: 'busy' } } },
    {
      name: 'noncanonical',
      properties: { sessionId: 'ses_root', status: { type: 'busy' } },
    },
    {
      name: 'conflicting',
      properties: { sessionID: 'ses_root', sessionId: 'ses_other', status: { type: 'busy' } },
    },
  ])('rejects $name session identities', ({ properties }) => {
    expect(controlEventToIngestItems('session.status', properties)).toEqual([]);
  });

  it('ignores deltas and incomplete payloads', () => {
    expect(controlEventToIngestItems('message.part.delta', { text: 'x' })).toEqual([]);
    expect(controlEventToIngestItems('message.updated', {})).toEqual([]);
  });
});

describe('publishControlPlaneSessionIngest', () => {
  it('posts mapped items to session-ingest', async () => {
    const fetchIngest = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await publishControlPlaneSessionIngest({
      fetchIngest,
      token: 'tok',
      rootKiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      cloudAgentSessionId: 'workspace_1',
      items: [{ type: 'message', data: { id: 'msg_1' } }],
    });
    expect(fetchIngest).toHaveBeenCalledOnce();
    const request = fetchIngest.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe('POST');
    expect(request.url).toContain('/api/session/ses_aaaaaaaaaaaaaaaaaaaaaaaaaa/ingest?v=2');
    expect(request.headers.get('Authorization')).toBe('Bearer tok');
    expect(request.headers.get('Content-Length')).toBe(
      String(
        new TextEncoder().encode(
          JSON.stringify({ data: [{ type: 'message', data: { id: 'msg_1' } }] })
        ).byteLength
      )
    );
    expect(request.headers.get(cloudAgentSessionScopeHeaders.cloudAgentSessionId)).toBeNull();
    expect(request.headers.get(cloudAgentSessionScopeHeaders.rootKiloSessionId)).toBeNull();
    expect(request.headers.get(cloudAgentSessionScopeHeaders.protocolVersion)).toBeNull();
    expect(await request.json()).toEqual({ data: [{ type: 'message', data: { id: 'msg_1' } }] });
  });

  it('creates and ingests child sessions through the scoped internal API', async () => {
    const fetchIngest = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const root = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
    const child = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    await publishControlPlaneSessionIngest({
      fetchIngest,
      token: 'tok',
      rootKiloSessionId: root,
      eventKiloSessionId: child,
      cloudAgentSessionId: 'workspace_1',
      internalSecret: 'internal',
      items: [{ type: 'message', data: { id: 'msg_1' } }],
    });

    expect(fetchIngest).toHaveBeenCalledTimes(2);
    const createRequest = fetchIngest.mock.calls[0]?.[0] as Request;
    const ingestRequest = fetchIngest.mock.calls[1]?.[0] as Request;
    expect(createRequest.url).toBe('https://session-ingest/internal/cloud-agent/v1/session');
    expect(ingestRequest.url).toBe(
      `https://session-ingest/internal/cloud-agent/v1/session/${child}/ingest?v=2`
    );
    expect(createRequest.headers.get('Content-Length')).toBeNull();
    expect(ingestRequest.headers.get('Content-Length')).toBe(
      String(
        new TextEncoder().encode(
          JSON.stringify({ data: [{ type: 'message', data: { id: 'msg_1' } }] })
        ).byteLength
      )
    );
    for (const request of [createRequest, ingestRequest]) {
      expect(request.headers.get('Authorization')).toBe('Bearer tok');
      expect(request.headers.get('X-Internal-Secret')).toBe('internal');
      expect(request.headers.get(cloudAgentSessionScopeHeaders.cloudAgentSessionId)).toBe(
        'workspace_1'
      );
      expect(request.headers.get(cloudAgentSessionScopeHeaders.rootKiloSessionId)).toBe(root);
      expect(request.headers.get(cloudAgentSessionScopeHeaders.protocolVersion)).toBe(
        cloudAgentSessionScopeProtocolVersion
      );
    }
    expect(await createRequest.json()).toEqual({ sessionId: child });
    expect(await ingestRequest.json()).toEqual({
      data: [{ type: 'message', data: { id: 'msg_1' } }],
    });
  });

  it('forwards authoritative creation lineage before a child has any messages', async () => {
    const requests: Request[] = [];
    const root = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
    const child = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    const directory = '/workspace/owner/worktrees/worktree_11111111-1111-4111-8111-111111111111';
    await publishControlPlaneSessionIngest({
      fetchIngest: async request => {
        requests.push(request);
        return new Response(null, { status: 200 });
      },
      token: 'tok',
      rootKiloSessionId: root,
      eventKiloSessionId: child,
      cloudAgentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
      directory,
      internalSecret: 'internal',
      items: controlEventToIngestItems('session.created', {
        sessionID: child,
        info: { id: child, parentID: root, directory, title: 'Never run' },
      }),
    });
    expect(requests).toHaveLength(2);
    expect(await requests[0].json()).toEqual({ sessionId: child, parentSessionId: root });
  });

  it('stops child ingest when scoped session creation fails', async () => {
    const fetchIngest = vi.fn().mockResolvedValue(new Response(null, { status: 409 }));
    await publishControlPlaneSessionIngest({
      fetchIngest,
      token: 'tok',
      rootKiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      eventKiloSessionId: 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb',
      cloudAgentSessionId: 'workspace_1',
      internalSecret: 'internal',
      items: [{ type: 'session', data: { id: 'child' } }],
    });

    expect(fetchIngest).toHaveBeenCalledOnce();
  });
});

describe('ingestKiloSessionId', () => {
  it('resolves session ids from info, part, and top-level properties', () => {
    expect(ingestKiloSessionId('message.updated', { info: { sessionID: 'info' } })).toBe('info');
    expect(ingestKiloSessionId('message.part.updated', { part: { sessionID: 'part' } })).toBe(
      'part'
    );
    expect(ingestKiloSessionId('session.updated', { sessionID: 'top-level' })).toBe('top-level');
    expect(
      ingestKiloSessionId('session.status', { sessionID: 'status-root', status: { type: 'busy' } })
    ).toBe('status-root');
  });
});
