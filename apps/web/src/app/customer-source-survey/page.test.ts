const mockRedirect = jest.fn<never, [string]>(() => {
  throw new Error('NEXT_REDIRECT');
});

jest.mock('next/navigation', () => ({
  redirect: (...args: [string]) => mockRedirect(...args),
}));

const mockGetUserFromAuthOrRedirect = jest.fn<Promise<void>, [string]>();
jest.mock('@/lib/user/server', () => ({
  getUserFromAuthOrRedirect: (...args: [string]) => mockGetUserFromAuthOrRedirect(...args),
}));

import CustomerSourceSurveyPage from './page';

async function renderPage(searchParams: Record<string, string> = {}) {
  try {
    await CustomerSourceSurveyPage({
      searchParams: Promise.resolve(searchParams),
      params: Promise.resolve(undefined),
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'NEXT_REDIRECT') throw error;
  }
}

describe('GET /customer-source-survey', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserFromAuthOrRedirect.mockResolvedValue();
  });

  it('redirects authenticated users to the dashboard resolver', async () => {
    await renderPage();

    expect(mockGetUserFromAuthOrRedirect).toHaveBeenCalledWith('/users/sign_in');
    expect(mockRedirect).toHaveBeenCalledWith('/get-started');
  });

  it('preserves a valid in-app callbackPath', async () => {
    await renderPage({ callbackPath: '/profile' });

    expect(mockRedirect).toHaveBeenCalledWith('/profile');
  });

  it('rejects an external callbackPath', async () => {
    await renderPage({ callbackPath: 'https://example.com' });

    expect(mockRedirect).toHaveBeenCalledWith('/get-started');
  });
});
