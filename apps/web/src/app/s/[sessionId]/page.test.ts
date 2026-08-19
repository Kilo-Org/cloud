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
jest.mock('@/components/CopyableCommand', () => ({
  CopyableCommand: ({ command }: { command: string }) => React.createElement('code', null, command),
}));
jest.mock('@/app/share/[shareId]/open-in-cli-button', () => ({
  OpenInCliButton: ({ command }: { command: string }) =>
    React.createElement('button', null, command),
}));
jest.mock('@/app/share/[shareId]/open-in-editor-button', () => ({
  OpenInEditorButton: ({ sessionId, pathOverride }: { sessionId: string; pathOverride: string }) =>
    React.createElement('button', { 'data-session-id': sessionId, 'data-path': pathOverride }),
}));
jest.mock('./shared-session-transcript', () => ({
  SharedSessionTranscript: ({ messages }: { messages: Array<{ info: { id: string } }> }) =>
    React.createElement('div', { 'data-message-count': messages.length }),
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
    expect(html).toContain('Ada Lovelace shared a session');
    expect(html).toContain('A shared session');
    expect(html).toContain('data-message-count="1"');
    expect(html).toContain('kilo import https://app.test.example.com/s/' + shareToken);
    expect(html).toContain(`data-session-id="${shareToken}"`);
    expect(html).toContain(`data-path="/s/${shareToken}"`);
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
