import { SignInButton } from '@/components/auth/SigninButton';
import type { AuthProviderId } from '@/lib/auth/provider-metadata';
import { getProviderById, ProdNonSSOAuthProviders } from '@/lib/auth/provider-metadata';

type AuthProviderButtonsProps = {
  providers?: readonly AuthProviderId[];
  onProviderClick: (provider: AuthProviderId) => void | Promise<void>;
  customLabels?: Partial<Record<AuthProviderId, string>>;
  disabled?: boolean;
};

/**
 * Renders a list of provider sign-in buttons.
 * Used for displaying OAuth providers and email sign-in options.
 */
export function AuthProviderButtons({
  providers = ProdNonSSOAuthProviders,
  onProviderClick,
  customLabels,
  disabled = false,
}: AuthProviderButtonsProps) {
  return (
    <>
      {providers.map(providerId => {
        const provider = getProviderById(providerId);
        const label = customLabels?.[providerId] || `Continue with ${provider.name}`;
        return (
          <SignInButton
            key={providerId}
            onClick={() => onProviderClick(providerId)}
            disabled={disabled}
          >
            {provider.icon}
            {label}
          </SignInButton>
        );
      })}
    </>
  );
}
