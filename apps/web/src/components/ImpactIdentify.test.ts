import type { User } from '@kilocode/db/schema';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The component's JSX compiles to `React.createElement`, and Next supplies the
// binding its own build; here it comes from the test.
Object.assign(globalThis, { React });

const mockUseEffect = jest.fn((effect: () => void | (() => void), _deps?: unknown[]) => effect());
const mockUseUser = jest.fn();
const mockPathname = jest.fn(() => '/');

jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => mockUseEffect(effect, deps),
}));

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname(),
}));

jest.mock('@/hooks/useUser', () => ({
  useUser: () => mockUseUser(),
}));

jest.mock('@/lib/impact/debug', () => ({
  logImpactReferralDebug: jest.fn(),
}));

import { ImpactIdentify } from './ImpactIdentify';

const TEST_USER = {
  id: 'user_123',
  google_user_email: ' Logged.In@Example.COM ',
} as User;

function createLocalStorage() {
  const values = new Map<string, string>();
  return {
    getItem: jest.fn((key: string) => values.get(key) ?? null),
    setItem: jest.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

async function waitForIreCalls(ire: jest.Mock, expectedCallCount: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (ire.mock.calls.length >= expectedCallCount) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('ImpactIdentify', () => {
  let originalWindow: typeof globalThis.window | undefined;
  let originalCrypto: Crypto;
  let originalUttId: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    // The component renders nothing without the Impact tag, so every render
    // case below configures it; the shell case asserts the other skip.
    originalUttId = process.env.NEXT_PUBLIC_IMPACT_UTT_ID;
    process.env.NEXT_PUBLIC_IMPACT_UTT_ID = 'impact-utt-test-id';
    mockPathname.mockReturnValue('/');
    originalWindow = globalThis.window;
    originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        ...originalCrypto,
        randomUUID: jest.fn(() => 'anonymous-profile-id'),
        subtle: originalCrypto.subtle,
      },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalUttId === undefined) {
      delete process.env.NEXT_PUBLIC_IMPACT_UTT_ID;
    } else {
      process.env.NEXT_PUBLIC_IMPACT_UTT_ID = originalUttId;
    }
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: originalCrypto,
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  });

  it('identifies anonymous visitors with empty customer fields and a stable first-party profile id', async () => {
    const ire = jest.fn();
    const localStorage = createLocalStorage();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { ire, localStorage },
    });
    mockUseUser.mockReturnValue({ data: null });

    // The gate reads `usePathname`, so the component renders through the
    // renderer instead of being called as a plain function.
    renderToStaticMarkup(createElement(ImpactIdentify));
    await waitForIreCalls(ire, 1);
    renderToStaticMarkup(createElement(ImpactIdentify));
    await waitForIreCalls(ire, 2);

    expect(ire).toHaveBeenNthCalledWith(1, 'identify', {
      customerId: '',
      customerEmail: '',
      customProfileId: 'kilo-anon:anonymous-profile-id',
    });
    expect(ire).toHaveBeenNthCalledWith(2, 'identify', {
      customerId: '',
      customerEmail: '',
      customProfileId: 'kilo-anon:anonymous-profile-id',
    });
    expect(localStorage.setItem).toHaveBeenCalledTimes(1);
  });

  it('identifies logged-in users with Kilo user id, SHA-1 email hash, and user-derived profile id', async () => {
    const ire = jest.fn();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { ire, localStorage: createLocalStorage() },
    });
    mockUseUser.mockReturnValue({ data: TEST_USER });

    renderToStaticMarkup(createElement(ImpactIdentify));
    await waitForIreCalls(ire, 1);

    expect(ire).toHaveBeenCalledWith('identify', {
      customerId: 'user_123',
      customerEmail: '155b33cbec67ea77560d6ad79d7245d9b7c285e3',
      customProfileId: 'kilo-user:user_123',
    });
  });

  it('identifies nobody inside the app shell, where /api/user cannot see the shell session', async () => {
    const ire = jest.fn();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { ire, localStorage: createLocalStorage() },
    });
    mockPathname.mockReturnValue('/app-shell/integrations/slack');

    renderToStaticMarkup(createElement(ImpactIdentify));

    expect(ire).not.toHaveBeenCalled();
    // The shell page never issues the /api/user read the identify call needs.
    expect(mockUseUser).not.toHaveBeenCalled();
  });
});
