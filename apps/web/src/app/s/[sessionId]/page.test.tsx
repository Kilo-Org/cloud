import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { notFound } from 'next/navigation';
import { fetchSharedSessionMetadata } from '@/lib/session-ingest-client';
import SharedSessionPage from './page';

// The repository Jest transform uses classic JSX for this focused server-component test.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mockFetchSharedSessionMetadata = jest.mocked(fetchSharedSessionMetadata);
const mockNotFound = jest.mocked(notFound);

jest.mock('next/navigation', () => ({
  notFound: jest.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

jest.mock('@/lib/constants', () => ({ APP_URL: 'https://app.test.example.com' }));
jest.mock('@/lib/session-ingest-client', () => ({
  fetchSharedSessionMetadata: jest.fn(),
}));
jest.mock('@/components/AnimatedLogo', () => ({ AnimatedLogo: () => null }));
jest.mock('@/components/CopyableCommand', () => ({
  CopyableCommand: ({ command }: { command: string }) => <code>{command}</code>,
}));
jest.mock('@/app/share/[shareId]/open-in-cli-button', () => ({
  OpenInCliButton: ({ command }: { command: string }) => <button>{command}</button>,
}));
jest.mock('@/app/share/[shareId]/open-in-editor-button', () => ({
  OpenInEditorButton: ({
    sessionId,
    pathOverride,
  }: {
    sessionId: string;
    pathOverride: string;
  }) => <button data-session-id={sessionId} data-path={pathOverride} />,
}));
jest.mock('@/components/ui/card', () => ({
  Card: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
}));

describe('SharedSessionPage', () => {
  beforeEach(() => {
    mockFetchSharedSessionMetadata.mockReset();
    mockNotFound.mockClear();
  });

  it('renders metadata and keeps the share token in generated links', async () => {
    const shareToken = 'eyJhbGciOiJIUzI1NiJ9.share.token';
    mockFetchSharedSessionMetadata.mockResolvedValue({
      title: 'A shared session',
      ownerName: 'Ada Lovelace',
    });

    const html = renderToStaticMarkup(
      await SharedSessionPage({ params: Promise.resolve({ sessionId: shareToken }) })
    );

    expect(mockFetchSharedSessionMetadata).toHaveBeenCalledWith(shareToken);
    expect(html).toContain('Ada Lovelace shared a session');
    expect(html).toContain('A shared session');
    expect(html).toContain('kilo import https://app.test.example.com/s/' + shareToken);
    expect(html).toContain(`data-session-id="${shareToken}"`);
    expect(html).toContain(`data-path="/s/${shareToken}"`);
  });

  it('uses not-found behavior when metadata cannot be resolved', async () => {
    const shareToken = 'rejected.share.token';
    mockFetchSharedSessionMetadata.mockResolvedValue(null);

    await expect(
      SharedSessionPage({ params: Promise.resolve({ sessionId: shareToken }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockFetchSharedSessionMetadata).toHaveBeenCalledWith(shareToken);
    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });
});
