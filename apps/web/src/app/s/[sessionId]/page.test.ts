import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { notFound } from 'next/navigation';
import {
  fetchSharedSessionMetadata,
  fetchSharedSessionSnapshot,
} from '@/lib/session-ingest-client';
import SharedSessionPage from './page';

const mockFetchSharedSessionMetadata = jest.mocked(fetchSharedSessionMetadata);
const mockFetchSharedSessionSnapshot = jest.mocked(fetchSharedSessionSnapshot);
const mockNotFound = jest.mocked(notFound);

jest.mock('next/navigation', () => ({
  notFound: jest.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

jest.mock('@/lib/constants', () => ({ APP_URL: 'https://app.test.example.com' }));
jest.mock('@/lib/session-ingest-client', () => ({
  fetchSharedSessionMetadata: jest.fn(),
  fetchSharedSessionSnapshot: jest.fn(),
}));
jest.mock('@/components/AnimatedLogo', () => ({ AnimatedLogo: () => null }));
jest.mock('@/app/share/[shareId]/open-in-cli-button', () => ({
  OpenInCliButton: ({ command }: { command: string }) =>
    React.createElement('button', null, command),
}));
jest.mock('@/app/share/[shareId]/open-in-editor-button', () => ({
  OpenInEditorButton: ({ sessionId, pathOverride }: { sessionId: string; pathOverride: string }) =>
    React.createElement('button', { 'data-session-id': sessionId, 'data-path': pathOverride }),
}));
jest.mock('./shared-session-transcript', () => ({
  SharedSessionTranscript: ({
    messages,
    unavailable,
  }: {
    messages: Array<{ info: { id: string } }>;
    unavailable?: boolean;
  }) =>
    React.createElement('div', {
      'data-message-count': messages.length,
      'data-unavailable': unavailable ? 'true' : 'false',
    }),
}));
jest.mock('./shared-session-date', () => ({
  SharedSessionDate: ({ isoDate }: { isoDate: string | null }) =>
    isoDate ? React.createElement('span', null, 'formatted-date') : null,
}));

describe('SharedSessionPage', () => {
  beforeEach(() => {
    mockFetchSharedSessionMetadata.mockReset();
    mockFetchSharedSessionSnapshot.mockReset();
    mockNotFound.mockClear();
  });

  it('renders metadata, transcript, and keeps the share token in generated links', async () => {
    const shareToken = 'eyJhbGciOiJIUzI1NiJ9.share.token';
    mockFetchSharedSessionMetadata.mockResolvedValue({
      title: 'A shared session',
      ownerName: 'Ada Lovelace',
      gitUrl: 'https://github.com/owner/repo.git',
      gitBranch: 'main',
      createdAt: '2026-08-19T12:00:00.000Z',
    });
    mockFetchSharedSessionSnapshot.mockResolvedValue({
      info: { id: 'ses_1' },
      messages: [
        {
          info: { id: 'msg_1', role: 'user', time: { created: 1 } },
          parts: [{ id: 'p1', type: 'text', text: 'hello' }],
        },
      ],
    });

    const html = renderToStaticMarkup(
      await SharedSessionPage({ params: Promise.resolve({ sessionId: shareToken }) })
    );

    expect(mockFetchSharedSessionMetadata).toHaveBeenCalledWith(shareToken);
    expect(mockFetchSharedSessionSnapshot).toHaveBeenCalledWith(shareToken);
    expect(html).toContain('Shared by Ada Lovelace');
    expect(html).toContain('A shared session');
    expect(html).toContain('owner/repo');
    expect(html).toContain('main');
    expect(html).toContain('formatted-date');
    expect(html).toContain('data-message-count="1"');
    expect(html).toContain('data-unavailable="false"');
    expect(html).toContain('kilo import https://app.test.example.com/s/' + shareToken);
    expect(html).toContain('https://kilo.ai/install');
    expect(html).toContain('Install Kilo');
    expect(html).toContain(`data-session-id="${shareToken}"`);
    expect(html).toContain(`data-path="/s/${shareToken}"`);
  });

  it('falls back to a shared-by heading when the session has no title', async () => {
    const shareToken = 'untitled.share.token';
    mockFetchSharedSessionMetadata.mockResolvedValue({
      title: null,
      ownerName: 'Grace Hopper',
      gitUrl: null,
      gitBranch: null,
      createdAt: null,
    });
    mockFetchSharedSessionSnapshot.mockResolvedValue({
      info: { id: 'ses_2' },
      messages: [],
    });

    const html = renderToStaticMarkup(
      await SharedSessionPage({ params: Promise.resolve({ sessionId: shareToken }) })
    );

    expect(html).toContain('Grace Hopper shared a session');
    expect(html).not.toContain('Shared by Grace Hopper');
    expect(html).toContain('data-message-count="0"');
    expect(html).toContain('data-unavailable="false"');
  });

  it('marks the transcript unavailable when the snapshot fetch fails', async () => {
    const shareToken = 'snapshot.failure.token';
    mockFetchSharedSessionMetadata.mockResolvedValue({
      title: 'Still reachable',
      ownerName: 'Ada Lovelace',
      gitUrl: null,
      gitBranch: null,
      createdAt: null,
    });
    mockFetchSharedSessionSnapshot.mockRejectedValue(new Error('Session ingest snapshot failed'));

    const html = renderToStaticMarkup(
      await SharedSessionPage({ params: Promise.resolve({ sessionId: shareToken }) })
    );

    expect(html).toContain('Still reachable');
    expect(html).toContain('data-message-count="0"');
    expect(html).toContain('data-unavailable="true"');
  });

  it('uses not-found behavior when metadata cannot be resolved', async () => {
    const shareToken = 'rejected.share.token';
    mockFetchSharedSessionMetadata.mockResolvedValue(null);
    mockFetchSharedSessionSnapshot.mockResolvedValue(null);

    await expect(
      SharedSessionPage({ params: Promise.resolve({ sessionId: shareToken }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockFetchSharedSessionMetadata).toHaveBeenCalledWith(shareToken);
    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });
});
