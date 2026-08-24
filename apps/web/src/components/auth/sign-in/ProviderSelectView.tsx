'use client';

import { AuthProviderButtons } from '@/components/auth/sign-in/AuthProviderButtons';
import type { AuthProviderId } from '@/lib/auth/provider-metadata';
import React, { useState } from 'react';

type ProviderSelectViewProps = {
  email: string;
  providers: AuthProviderId[];
  onProviderSelect: (provider: AuthProviderId) => Promise<boolean>;
  onBack: () => void;
  purpose?: 'sign-in' | 'sign-up';
};

/**
 * Provider selection view shown after email lookup.
 * Displays available authentication providers for the user.
 */
export function ProviderSelectView({
  email,
  providers,
  onProviderSelect,
  onBack,
  purpose = 'sign-in',
}: ProviderSelectViewProps) {
  const [isSelecting, setIsSelecting] = useState(false);
  const handleProviderSelect = async (provider: AuthProviderId) => {
    setIsSelecting(true);
    try {
      const isRedirecting = await onProviderSelect(provider);
      if (isRedirecting) {
        return;
      }
      setIsSelecting(false);
    } catch {
      setIsSelecting(false);
    }
  };
  return (
    <div className="w-full text-center">
      <p className="text-muted-foreground mb-8 text-lg">
        {purpose === 'sign-up' ? 'Create an account as' : "Choose how you'd like to sign in as"}{' '}
        <span className="font-semibold break-all">{email}</span>
      </p>

      <div className="mx-auto max-w-md space-y-4">
        <AuthProviderButtons
          providers={providers}
          onProviderClick={handleProviderSelect}
          customLabels={{ email: 'Email me a magic link' }}
          disabled={isSelecting}
        />
      </div>

      <button
        onClick={onBack}
        disabled={isSelecting}
        className="text-muted-foreground mt-6 min-h-11 text-sm hover:underline disabled:cursor-not-allowed disabled:opacity-50"
      >
        ← Use a different email
      </button>
    </div>
  );
}
