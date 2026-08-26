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
  });
});
