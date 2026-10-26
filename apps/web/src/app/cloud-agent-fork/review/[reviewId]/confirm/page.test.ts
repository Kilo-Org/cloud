import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';

const mockRedirect = jest.fn();
const mockGetUserFromAuthOrRedirect = jest.fn<(url: string) => Promise<{ id: string }>>();

(globalThis as typeof globalThis & { React: typeof React }).React = React;

jest.mock('next/navigation', () => ({ redirect: mockRedirect }));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuthOrRedirect: mockGetUserFromAuthOrRedirect,
}));
jest.mock('@/components/KiloCardLayout', () => ({
  KiloCardLayout: ({ children }: { children: React.ReactNode }) => children,
}));

let ConfirmFixSessionPage: (props: {
  params: Promise<{ reviewId: string }>;
  searchParams: Promise<{ error?: string }>;
}) => Promise<React.ReactNode>;

const REVIEW_ID = '00000000-0000-4000-8000-000000000001';

function findProps(
  element: React.ReactNode,
  predicate: (props: Record<string, unknown>) => boolean,
  found: Record<string, unknown>[] = []
): Record<string, unknown>[] {
  if (Array.isArray(element)) {
    for (const child of element) findProps(child, predicate, found);
    return found;
  }
  if (!React.isValidElement(element)) return found;

  const props = element.props as Record<string, unknown>;
  if (predicate(props)) found.push(props);
  findProps(props.children as React.ReactNode, predicate, found);
  return found;
}

function renderedText(element: React.ReactNode): string {
  if (typeof element === 'string' || typeof element === 'number') return String(element);
  if (Array.isArray(element)) return element.map(renderedText).join('');
  if (!React.isValidElement(element)) return '';
  const props = element.props as { children?: React.ReactNode };
  return renderedText(props.children);
}

async function renderPage(error?: string): Promise<React.ReactNode> {
  return ConfirmFixSessionPage({
    params: Promise.resolve({ reviewId: REVIEW_ID }),
    searchParams: Promise.resolve({ error }),
  });
}

describe('confirm fix session page', () => {
  beforeAll(async () => {
    ({ default: ConfirmFixSessionPage } = await import('./page'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserFromAuthOrRedirect.mockResolvedValue({ id: 'user_1' });
  });

  it('sends invalid review ids to the code reviews page without requiring a session', async () => {
    mockRedirect.mockImplementation(() => {
      throw new Error('NEXT_REDIRECT');
    });

    await expect(
      ConfirmFixSessionPage({
        params: Promise.resolve({ reviewId: 'not-a-uuid' }),
        searchParams: Promise.resolve({}),
      })
    ).rejects.toThrow('NEXT_REDIRECT');

    expect(mockRedirect).toHaveBeenCalledWith('/code-reviews?error=invalid_review_id');
    expect(mockGetUserFromAuthOrRedirect).not.toHaveBeenCalled();
  });

  it('sends signed-out readers back to this page after sign-in', async () => {
    await renderPage();

    expect(mockGetUserFromAuthOrRedirect).toHaveBeenCalledWith(
      `/users/sign_in?callbackPath=${encodeURIComponent(`/cloud-agent-fork/review/${REVIEW_ID}/confirm`)}`
    );
  });

  it('posts the confirmation to the route that starts the session', async () => {
    const forms = findProps(
      await renderPage(),
      props => props.method === 'post' && typeof props.action === 'string'
    );

    expect(forms).toHaveLength(1);
    expect(forms[0]?.action).toBe(`/cloud-agent-fork/review/${REVIEW_ID}`);
  });

  it('explains the wait when the reader is over the session start cap', async () => {
    const limited = renderedText(await renderPage('rate_limited'));
    const normal = renderedText(await renderPage());

    expect(limited).toContain('Try again later');
    expect(normal).not.toContain('Try again later');
  });

  it('asks the reader to reload when the submission could not be confirmed', async () => {
    const rejected = renderedText(await renderPage('invalid_origin'));
    const normal = renderedText(await renderPage());

    expect(rejected).toContain('Reload the page and try again');
    expect(normal).not.toContain('Reload the page and try again');
  });
});
