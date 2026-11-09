const mockGetUserFromAuthOrRedirect = jest.fn();

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuthOrRedirect: mockGetUserFromAuthOrRedirect,
}));

jest.mock('@/components/cloud-agent-next/NewSessionPanel', () => ({
  NewSessionPanel: () => null,
}));

describe('PersonalCloudPage sign-in callback', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockGetUserFromAuthOrRedirect.mockResolvedValue({ id: 'user-1' });
  });

  it('preserves the personal profile deep link across sign-in', async () => {
    mockGetUserFromAuthOrRedirect.mockRejectedValue(new Error('NEXT_REDIRECT'));
    const { default: PersonalCloudPage } = await import('./page');

    await expect(
      PersonalCloudPage({ searchParams: Promise.resolve({ settings: 'profiles' }) })
    ).rejects.toThrow('NEXT_REDIRECT');

    expect(mockGetUserFromAuthOrRedirect).toHaveBeenCalledWith(
      '/users/sign_in?callbackPath=%2Fcloud%3Fsettings%3Dprofiles'
    );
  });

  it('keeps the plain cloud callback without a settings query', async () => {
    mockGetUserFromAuthOrRedirect.mockRejectedValue(new Error('NEXT_REDIRECT'));
    const { default: PersonalCloudPage } = await import('./page');

    await expect(PersonalCloudPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'NEXT_REDIRECT'
    );

    expect(mockGetUserFromAuthOrRedirect).toHaveBeenCalledWith(
      '/users/sign_in?callbackPath=%2Fcloud'
    );
  });
});
