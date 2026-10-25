import { describe, expect, it } from '@jest/globals';
import { getSessionTraceHref } from './UserAdminHeuristicAbuse';

describe('getSessionTraceHref', () => {
  it.each([
    'ses_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    'ses_abcdef012345AbCdEf01234567',
    'agent_550e8400-e29b-41d4-a716-446655440000',
    'workspace_abc-123_DEF',
    '550e8400-e29b-41d4-a716-446655440000',
    '550E8400-E29B-41D4-A716-446655440000',
  ])('links supported session ID %s without changing it', sessionId => {
    const href = getSessionTraceHref(sessionId);
    expect(href).toBe(`/admin/session-traces?sessionId=${encodeURIComponent(sessionId)}`);

    const url = new URL(href ?? '', 'https://app.kilo.ai');
    expect(url.origin).toBe('https://app.kilo.ai');
    expect(url.pathname).toBe('/admin/session-traces');
    expect([...url.searchParams]).toEqual([['sessionId', sessionId]]);
    expect(url.hash).toBe('');
  });

  it.each([
    null,
    undefined,
    '',
    ' ',
    'task-123',
    'agent-briefing:550e8400-e29b-41d4-a716-446655440000',
    '550e8400-e29b-41d4-a716-44665544000',
    '550e8400-e29b-41d4-a716-44665544000g',
    'agent_',
    'workspace_',
    'ses_',
    'SES_abc',
    'Agent_abc',
    'Workspace_abc',
    ' ses_abc',
    'ses_abc ',
    'ses_abc\n',
    'ses_abc\r\n',
    'ses_ab\tc',
    'ses_ab\0c',
    'ses_abc\u2028',
    'ses_\ud800',
    'ses_\u00e9',
    'ses_abc?other=value',
    'ses_abc&sessionId=other',
    'ses_abc#fragment',
    'agent_abc/../other',
    'workspace_abc%26other',
    'ses_abc"onclick="alert(1)',
    'https://example.com/ses_abc',
    'javascript:alert(1)',
    '550e8400-e29b-41d4-a716-446655440000\n',
  ])('does not build a link for unsupported value %j', sessionId => {
    expect(getSessionTraceHref(sessionId)).toBeNull();
  });
});
