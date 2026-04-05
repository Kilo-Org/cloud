'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { signIn } from 'next-auth/react';
import { Button } from '../Button';
import getSignInCallbackUrl from '@/lib/getSignInCallbackUrl';
import { captureException } from '@sentry/nextjs';

export type FakeSignInButtonProps = {
  searchParams: NextAppSearchParams;
};

export function FakeLoginForm({ searchParams }: FakeSignInButtonProps) {
  const fakeUserEmail = searchParams?.fakeUser as string | undefined;
  const [email, setEmail] = useState(fakeUserEmail || '');
  const [isLoading, setIsLoading] = useState(false);
  const [isVisible, setIsVisible] = useState(true);
  const [stytchBehavior, setStytchBehavior] = useState<'default' | 'pass' | 'fail'>('default');
  const callbackUrl = getSignInCallbackUrl(searchParams);
  // Track if auto-submit has been triggered to prevent double submission in React Strict Mode
  const hasAutoSubmitted = useRef(false);

  const handleStytchBehaviorChange = useCallback((behavior: 'default' | 'pass' | 'fail') => {
    setStytchBehavior(behavior);
  }, []);

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      if (e) e.preventDefault();
      if (!email.trim()) return;

      // Modify email based on selected Stytch behavior.
      // The backend handler will look for these in the email address.
      let submissionEmail = email.trim();
      if (stytchBehavior === 'pass') {
        submissionEmail = submissionEmail.replace('@', '+stytchpass@');
      } else if (stytchBehavior === 'fail') {
        submissionEmail = submissionEmail.replace('@', '+stytchfail@');
      }

      setIsLoading(true);
      try {
        await signIn('fake-login', {
          email: submissionEmail,
          callbackUrl,
        });
      } catch (error) {
        console.error('Fake login error:', error);
        captureException(error, {
          tags: { source: 'fake_login' },
          extra: {
            email: submissionEmail,
            callbackUrl,
          },
          level: 'warning',
        });
      } finally {
        setIsLoading(false);
      }
    },
    [email, callbackUrl, stytchBehavior]
  );

  // Auto-submit if fakeUser is provided in search params
  // Use ref to prevent double submission in React Strict Mode
  useEffect(() => {
    if (fakeUserEmail && fakeUserEmail.trim() && !hasAutoSubmitted.current) {
      hasAutoSubmitted.current = true;
      void handleSubmit();
    }
  }, [fakeUserEmail, handleSubmit]);

  if (!isVisible) {
    return null;
  }

  return (
    <div className="fixed bottom-6 left-6 w-80 overflow-visible rounded-lg border border-amber-600/50 bg-gray-900 p-4 shadow-lg">
      {/* Close button */}
      <button
        onClick={() => setIsVisible(false)}
        className="absolute top-2 right-2 z-20 flex h-6 w-6 items-center justify-center rounded text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
        aria-label="Close dev login"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path d="M6 18L18 6M6 6l12 12"></path>
        </svg>
      </button>

      <div className="mb-4 flex items-center gap-2 border-b border-gray-700 pb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded bg-amber-600/20">
          <svg
            className="h-4 w-4 text-amber-500"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-gray-100">Development Login</h3>
          <p className="text-xs text-gray-500">Local environment only</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label htmlFor="fake-email" className="block text-xs font-medium text-gray-300">
            Email Address
          </label>
          <input
            id="fake-email"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="test@example.com"
            className="mt-1 block w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-amber-500 focus:ring-1 focus:ring-amber-500 focus:outline-none"
            required
          />
        </div>

        <div className="space-y-2">
          <label className="block text-xs font-medium text-gray-300">Stytch Behavior</label>
          <div className="flex items-center gap-4">
            {[
              { value: 'default', label: 'Default' },
              { value: 'pass', label: 'Force Pass' },
              { value: 'fail', label: 'Force Fail' },
            ].map(({ value, label }) => (
              <label key={value} className="flex items-center gap-1.5 text-xs text-gray-400">
                <input
                  type="radio"
                  name="stytch-behavior"
                  value={value}
                  checked={stytchBehavior === value}
                  onChange={() => handleStytchBehaviorChange(value as typeof stytchBehavior)}
                  className="h-3.5 w-3.5 border-gray-600 bg-gray-800 text-amber-600 focus:ring-1 focus:ring-amber-500 focus:ring-offset-0"
                />
                {label}
              </label>
            ))}
          </div>
        </div>

        <Button
          type="submit"
          disabled={isLoading || !email.trim()}
          size="sm"
          className="w-full bg-amber-600 text-white hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500"
        >
          {isLoading ? 'Signing in...' : 'Sign In'}
        </Button>
      </form>
    </div>
  );
}
