import { QueryClient } from '@tanstack/react-query';
import {
  deriveToolDetailView,
  removeToolDetailQueries,
  shouldRetryToolDetail,
  toolDetailQueryKey,
} from './tool-part-detail-state';
import type { ToolPart } from './types';

function tool(output: string, extra: Record<string, unknown> = {}): ToolPart {
  return {
    id: 'prt_1',
    messageID: 'msg_1',
    sessionID: 'ses_root',
    type: 'tool',
    callID: 'call_1',
    tool: 'read',
    state: {
      status: 'completed',
      input: { filePath: '/a' },
      output,
      title: 'a',
      metadata: {},
      time: { start: 1, end: 2 },
    },
    ...extra,
  } as ToolPart;
}

const marker = { version: 1, revision: 5, omitted: ['output'], omittedCount: 1, omittedBytes: 9 };
const preview = tool('pre', { cloudDetail: marker });
const scope = { userId: 'u', organizationId: null, cloudAgentSessionId: 'workspace_1' };

function view(query: Parameters<typeof deriveToolDetailView>[0]['query'], requested = true) {
  return deriveToolDetailView({ preview, revision: 5, requested, scoped: true, query });
}

describe('deriveToolDetailView', () => {
  const success = (data: unknown) => view({ status: 'success', data, error: null });

  it('keeps the preview until details are requested and loaded', () => {
    expect(view({ status: 'pending', data: undefined, error: null }, false).state).toEqual({
      status: 'idle',
    });
    expect(view({ status: 'pending', data: undefined, error: null })).toEqual({
      part: preview,
      state: { status: 'loading' },
    });
  });

  it('shows the complete part for the same or a newer revision only', () => {
    const complete = tool('complete');
    expect(
      success({ kind: 'found', source: { version: 'v1' }, revision: 6, part: complete })
    ).toEqual({ part: complete, state: { status: 'complete' } });
    expect(
      success({ kind: 'found', source: { version: 'v1' }, revision: 4, part: complete })
    ).toMatchObject({ part: preview, state: { status: 'unavailable' } });
  });

  it('reports absence and size limits instead of empty output', () => {
    expect(success({ kind: 'not_found' })).toMatchObject({
      part: preview,
      state: { status: 'unavailable', message: expect.stringContaining('no longer available') },
    });
    expect(success({ kind: 'too_large', bytes: 9 })).toMatchObject({
      state: { status: 'unavailable', message: expect.stringContaining('too large') },
    });
    expect(success({ kind: 'surprise' }).state.status).toBe('error');
  });

  it('separates terminal denials from retryable failures', () => {
    expect(
      view({ status: 'error', data: undefined, error: { data: { code: 'FORBIDDEN' } } }).state
        .status
    ).toBe('unavailable');
    expect(
      view({ status: 'error', data: undefined, error: { data: { httpStatus: 503 } } }).state.status
    ).toBe('error');
  });

  it('never reads without a workspace scope', () => {
    expect(
      deriveToolDetailView({
        preview,
        revision: 5,
        requested: true,
        scoped: false,
        query: { status: 'pending', data: undefined, error: null },
      }).state.status
    ).toBe('unavailable');
  });
});

describe('tool detail cache', () => {
  it('keys entries by account, session, part and revision', () => {
    expect(toolDetailQueryKey(scope, preview, 5)).not.toEqual(
      toolDetailQueryKey(scope, preview, 6)
    );
    expect(toolDetailQueryKey(scope, preview, 5)).not.toEqual(
      toolDetailQueryKey({ ...scope, organizationId: 'org' }, preview, 5)
    );
  });

  it('retires one native session without touching others', () => {
    const client = new QueryClient();
    const other = { ...preview, sessionID: 'ses_other' } as ToolPart;
    client.setQueryData(toolDetailQueryKey(scope, preview, 5), 1);
    client.setQueryData(toolDetailQueryKey(scope, other, 5), 2);
    removeToolDetailQueries(client, 'ses_root');
    expect(client.getQueryData(toolDetailQueryKey(scope, preview, 5))).toBeUndefined();
    expect(client.getQueryData(toolDetailQueryKey(scope, other, 5))).toBe(2);
  });

  it('retries one transient failure and never retries known failures', () => {
    expect(shouldRetryToolDetail(0, { data: { httpStatus: 503 } })).toBe(true);
    expect(shouldRetryToolDetail(0, new Error('network'))).toBe(true);
    expect(shouldRetryToolDetail(1, { data: { httpStatus: 503 } })).toBe(false);
    expect(shouldRetryToolDetail(0, { data: { code: 'NOT_FOUND' } })).toBe(false);
    expect(shouldRetryToolDetail(0, { data: { httpStatus: 400 } })).toBe(false);
  });
});
