import { describe, expect, it, vi } from 'vitest';
import type { ControlPlaneHistoryResultFrame } from '../../shared/control-plane-protocol.js';
import type { RouteRecord } from './routes.js';
import type { SessionMessagesPage } from '../session/history.js';
import { serveHistoryPage, serveRecentHistory } from './history-pages.js';

const frame = {
  type: 'history.page' as const,
  requestId: 'request',
  sessionId: 'workspace_sibling',
  kiloSessionId: 'ses_sibling',
  workspaceSessionId: 'workspace_anchor',
};
const route = { spec: { kiloSessionId: 'ses_anchor' } } as RouteRecord;
const page = { kind: 'success', messages: [] } as unknown as SessionMessagesPage;

function setup() {
  const sent: ControlPlaneHistoryResultFrame[] = [];
  const getSessionMessagesPage = vi.fn(async () => page);
  return {
    sent,
    getSessionMessagesPage,
    input: {
      frame,
      readRoute: vi.fn(async () => route),
      authorizeWorkspaceSession: vi.fn(async () => true),
      session: vi.fn(async () => ({ getSessionMessagesPage })),
      send: (result: ControlPlaneHistoryResultFrame) => {
        sent.push(result);
      },
    },
  };
}

describe('wrapper history reads', () => {
  it('reads a sibling only after checking its exact ids against the hosted workspace route', async () => {
    const h = setup();
    await serveHistoryPage(h.input);
    expect(h.input.readRoute).toHaveBeenCalledWith(frame.workspaceSessionId);
    expect(h.input.authorizeWorkspaceSession).toHaveBeenCalledWith(route, frame);
    expect(h.input.session).toHaveBeenCalledWith(frame.sessionId);
    expect(h.getSessionMessagesPage).toHaveBeenCalledWith({
      limit: 100,
      expectedRootKiloSessionId: frame.kiloSessionId,
    });
    expect(h.sent).toEqual([{ type: 'history.result', requestId: 'request', ok: true, page }]);
  });

  it('does not read any transcript when workspace authorization fails or is unavailable', async () => {
    for (const authorize of [
      async () => false,
      async () => {
        throw new Error('unavailable');
      },
    ]) {
      const h = setup();
      h.input.authorizeWorkspaceSession.mockImplementation(authorize);
      await serveHistoryPage(h.input);
      expect(h.input.session).not.toHaveBeenCalled();
      expect(h.sent[0].ok).toBe(false);
    }
  });

  it('requires a hosted route even if the requested session exists elsewhere', async () => {
    const h = setup();
    await serveHistoryPage({ ...h.input, readRoute: async () => null });
    expect(h.input.authorizeWorkspaceSession).not.toHaveBeenCalled();
    expect(h.input.session).not.toHaveBeenCalled();
    expect(h.sent[0]).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('does not grant sibling access through the ordinary hosted-session path', async () => {
    const h = setup();
    const { workspaceSessionId: _unused, ...ordinary } = frame;
    await serveHistoryPage({ ...h.input, frame: ordinary });
    expect(h.input.authorizeWorkspaceSession).not.toHaveBeenCalled();
    expect(h.input.session).not.toHaveBeenCalled();
    expect(h.sent[0]).toMatchObject({ ok: false });
  });

  it('discovers recent chats through the hosted route without attaching or running them', async () => {
    const h = setup();
    const recent = [{ sessionId: frame.sessionId, kiloSessionId: frame.kiloSessionId }];
    const readRecent = vi.fn(async () => recent);
    await serveRecentHistory({
      ...h.input,
      frame: { type: 'history.recent', requestId: 'recent', sessionId: frame.workspaceSessionId },
      readRecent,
    });
    expect(readRecent).toHaveBeenCalledWith(route);
    expect(h.sent[0]).toEqual({
      type: 'history.result',
      requestId: 'recent',
      ok: true,
      page: recent,
    });
    expect(h.input.session).not.toHaveBeenCalled();
  });

  it('returns a bounded failure when discovery fails', async () => {
    const h = setup();
    await serveRecentHistory({
      ...h.input,
      frame: { type: 'history.recent', requestId: 'recent', sessionId: 'workspace_anchor' },
      readRecent: async () => {
        throw new Error('private database detail');
      },
    });
    expect(h.sent[0]).toMatchObject({ ok: false, error: { code: 'unavailable', retryable: true } });
    expect(JSON.stringify(h.sent)).not.toContain('private database detail');
  });
});
