'use client';

import { useEffect, useRef } from 'react';
import { Input } from '@/components/ui/input';
import { useUser } from '@/hooks/useUser';
import { useOnboarding } from './OnboardingContext';
import { TOWN_NAME_MAX_LENGTH, deriveDefaultTownName, validateTownName } from './onboarding.domain';

export function OnboardingStepName() {
  const { state, setTownName, goNext } = useOnboarding();
  const { data: user } = useUser();
  const hasSetDefault = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Pre-populate with user's name + '-town' once user data loads
  useEffect(() => {
    if (hasSetDefault.current) return;
    if (!user) return;
    if (state.townName) {
      hasSetDefault.current = true;
      return;
    }
    const defaultName = deriveDefaultTownName(user.google_user_name);
    if (defaultName) {
      setTownName(defaultName);
    }
    hasSetDefault.current = true;
  }, [user, state.townName, setTownName]);

  // Auto-focus the input
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const error = state.townName ? validateTownName(state.townName) : null;
  const canAdvance = state.townName.trim().length > 0 && !validateTownName(state.townName);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && canAdvance) {
      goNext();
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    if (value.length <= TOWN_NAME_MAX_LENGTH + 1) {
      setTownName(value, true);
    }
  }

  return (
    <div className="flex flex-col items-center justify-center py-12">
      <h2 className="text-xl font-semibold text-white/90">Name your town</h2>
      <p className="mt-2 text-sm text-white/40">
        This is your workspace where agents will collaborate on your code.
      </p>

      <div className="mt-8 w-full max-w-sm">
        <Input
          ref={inputRef}
          value={state.townName}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="My Town"
          aria-invalid={error ? true : undefined}
          className="h-12 text-center text-lg"
          autoComplete="off"
          spellCheck={false}
        />
        {error && <p className="mt-2 text-center text-sm text-red-400/80">{error}</p>}
        {!error && state.townName && (
          <p className="mt-2 text-center text-sm text-white/25">Press Enter to continue</p>
        )}
      </div>
    </div>
  );
}
