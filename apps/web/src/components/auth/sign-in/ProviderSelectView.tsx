'use client';

import { AuthProviderButtons } from '@/components/auth/sign-in/AuthProviderButtons';
import type { AuthProviderId } from '@/lib/auth/provider-metadata';

type ProviderSelectViewProps = {
  email: string;
  providers: AuthProviderId[];
  onProviderSelect: (provider: AuthProviderId) => void | Promise<void>;
  onBack: () => void;
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
}: ProviderSelectViewProps) {
  return (
    <div className="w-full text-center">
      <p className="text-muted-foreground mb-8 text-lg">
        Choose how you'd like to sign in as <span className="font-semibold">{email}</span>
      </p>

      <div className="mx-auto max-w-md space-y-4">
        <AuthProviderButtons
          providers={providers}
          onProviderClick={onProviderSelect}
          customLabels={{ email: 'Email me a magic link' }}
        />
      </div>

      <button onClick={onBack} className="text-muted-foreground mt-6 text-sm hover:underline">
        ← Use a different sign-in method
      </button>
    </div>
  );
}
