import type { Meta, StoryObj } from '@storybook/nextjs';
import { SignInForm } from '@/components/auth/SignInForm';

const meta: Meta<typeof SignInForm> = {
  title: 'Auth/SignInForm',
  component: SignInForm,
  parameters: {
    layout: 'centered',
  },
  args: {
    searchParams: {},
    isSignUp: false,
    error: undefined,
    allowFakeLogin: false,
    title: undefined,
    subtitle: undefined,
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

// ============================================================================
// LANDING STATE - Tier 2: New User (Default)
// ============================================================================

export const LandingNewUser: Story = {
  args: {
    storybookInitialState: {
      flowState: 'landing',
      tier: 'new',
      email: '',
    },
  },
};

export const LandingNewUserEmailInput: Story = {
  args: {
    storybookInitialState: {
      flowState: 'landing',
      tier: 'new',
      email: '',
      showEmailInput: true,
    },
  },
};

export const LandingNewUserEmailInputWithValue: Story = {
  args: {
    storybookInitialState: {
      flowState: 'landing',
      tier: 'new',
      email: 'newuser@example.com',
      showEmailInput: true,
    },
  },
};

export const LandingNewUserSignUp: Story = {
  args: {
    isSignUp: true,
    storybookInitialState: {
      flowState: 'landing',
      tier: 'new',
      email: '',
    },
  },
};

export const LandingNewUserWithError: Story = {
  args: {
    error: 'An error occurred. Please try again.',
    storybookInitialState: {
      flowState: 'landing',
      tier: 'new',
      email: '',
    },
  },
};

// ============================================================================
// LANDING STATE - Tier 1: Returning User
// ============================================================================

export const LandingReturningOAuthGoogle: Story = {
  args: {
    storybookInitialState: {
      flowState: 'landing',
      tier: 'returning',
      email: 'user@gmail.com',
      hint: {
        lastEmail: 'user@gmail.com',
        lastAuthMethod: 'google',
        lastLogin: new Date().toISOString(),
      },
    },
  },
};

export const LandingReturningOAuthGithub: Story = {
  args: {
    storybookInitialState: {
      flowState: 'landing',
      tier: 'returning',
      email: 'user@github.com',
      hint: {
        lastEmail: 'user@github.com',
        lastAuthMethod: 'github',
        lastLogin: new Date().toISOString(),
      },
    },
  },
};

export const LandingReturningOAuthEmail: Story = {
  args: {
    storybookInitialState: {
      flowState: 'landing',
      tier: 'returning',
      email: 'user@example.com',
      hint: {
        lastEmail: 'user@example.com',
        lastAuthMethod: 'email',
        lastLogin: new Date().toISOString(),
      },
    },
  },
};

export const LandingReturningSSO: Story = {
  args: {
    storybookInitialState: {
      flowState: 'landing',
      tier: 'returning',
      email: 'user@acme.com',
      hint: {
        lastEmail: 'user@acme.com',
        lastAuthMethod: 'workos',
        orgId: 'acme-corp',
        lastLogin: new Date().toISOString(),
      },
    },
  },
};

export const LandingReturningOtherMethodsExpanded: Story = {
  args: {
    storybookInitialState: {
      flowState: 'landing',
      tier: 'returning',
      email: 'user@gmail.com',
      showOtherMethods: true,
      hint: {
        lastEmail: 'user@gmail.com',
        lastAuthMethod: 'google',
        lastLogin: new Date().toISOString(),
      },
    },
  },
};

// ============================================================================
// LANDING STATE - Tier 3: Invite
// ============================================================================

export const LandingInvite: Story = {
  args: {
    searchParams: {
      email: 'user@acme.com',
      org: 'acme-corp',
    },
    storybookInitialState: {
      flowState: 'landing',
      tier: 'invite',
      email: 'user@acme.com',
    },
  },
};

export const LandingInviteWithOrgName: Story = {
  args: {
    searchParams: {
      email: 'user@acme.com',
      org: 'acme-corp',
    },
    storybookInitialState: {
      flowState: 'landing',
      tier: 'invite',
      email: 'user@acme.com',
    },
  },
};

// ============================================================================
// PROVIDER SELECT STATE - New User
// ============================================================================

export const ProviderSelectNewUser: Story = {
  args: {
    storybookInitialState: {
      flowState: 'provider-select',
      email: 'newuser@example.com',
      availableProviders: ['google', 'github', 'gitlab', 'linkedin', 'email'],
      isNewUser: true,
    },
  },
};

export const ProviderSelectNewUserWithPreferredProvider: Story = {
  args: {
    storybookInitialState: {
      flowState: 'provider-select',
      tier: 'returning', // This simulates having a hint, so preferred provider is first
      email: 'user@example.com',
      // Providers would be sorted with preferred (e.g., 'github') first
      availableProviders: ['github', 'google', 'gitlab', 'linkedin', 'email'],
      isNewUser: true,
    },
  },
};

// ============================================================================
// PROVIDER SELECT STATE - Existing User
// ============================================================================

export const ProviderSelectExistingUserSingle: Story = {
  args: {
    storybookInitialState: {
      flowState: 'provider-select',
      email: 'user@example.com',
      availableProviders: ['email'],
      isNewUser: false,
    },
  },
};

export const ProviderSelectExistingUserMultiple: Story = {
  args: {
    storybookInitialState: {
      flowState: 'provider-select',
      email: 'user@example.com',
      availableProviders: ['github', 'email'],
      isNewUser: false,
    },
  },
};

export const ProviderSelectExistingUserWithPreferredFirst: Story = {
  args: {
    storybookInitialState: {
      flowState: 'provider-select',
      tier: 'returning', // Simulates hint, so preferred provider is first
      email: 'user@gmail.com',
      // 'google' would be first if it was the last used method
      availableProviders: ['google', 'github', 'email'],
      isNewUser: false,
    },
  },
};

export const ProviderSelectExistingUserWithError: Story = {
  args: {
    error: 'Failed to sign in. Please try again.',
    storybookInitialState: {
      flowState: 'provider-select',
      email: 'user@example.com',
      availableProviders: ['github', 'email'],
      isNewUser: false,
    },
  },
};

// ============================================================================
// TURNSTILE STATES
// ============================================================================

export const TurnstileVerificationWithEmail: Story = {
  args: {
    storybookInitialState: {
      flowState: 'landing',
      showTurnstile: true,
      email: 'user@example.com',
      turnstileError: false,
    },
  },
};

export const TurnstileVerificationWithProvider: Story = {
  args: {
    storybookInitialState: {
      flowState: 'landing',
      showTurnstile: true,
      pendingSignIn: 'google',
      turnstileError: false,
    },
  },
};

export const TurnstileVerifying: Story = {
  args: {
    storybookInitialState: {
      flowState: 'landing',
      showTurnstile: true,
      email: 'user@example.com',
      turnstileError: false,
      // Note: isVerifying is not part of initial state, it's set during flow
    },
  },
};

export const TurnstileError: Story = {
  args: {
    storybookInitialState: {
      flowState: 'landing',
      showTurnstile: true,
      email: 'user@example.com',
      turnstileError: true,
    },
  },
};

// ============================================================================
// MAGIC LINK SENT STATE
// ============================================================================

export const MagicLinkSent: Story = {
  args: {
    storybookInitialState: {
      flowState: 'magic-link-sent',
      email: 'user@example.com',
    },
  },
};

export const MagicLinkSentWithTitle: Story = {
  args: {
    title: 'Check your email',
    storybookInitialState: {
      flowState: 'magic-link-sent',
      email: 'user@example.com',
    },
  },
};

// ============================================================================
// REDIRECTING STATE
// ============================================================================

export const Redirecting: Story = {
  args: {
    storybookInitialState: {
      flowState: 'redirecting',
    },
  },
};

export const RedirectingWithTitle: Story = {
  args: {
    title: 'Signing you in...',
    storybookInitialState: {
      flowState: 'redirecting',
    },
  },
};

// ============================================================================
// CUSTOM TITLES AND SUBTITLES
// ============================================================================

export const LandingNewUserWithCustomTitle: Story = {
  args: {
    title: 'Welcome to Kilocode',
    subtitle: 'Sign in to continue to your workspace',
    storybookInitialState: {
      flowState: 'landing',
      tier: 'new',
      email: '',
    },
  },
};

export const LandingReturningWithCustomTitle: Story = {
  args: {
    title: 'Welcome back!',
    storybookInitialState: {
      flowState: 'landing',
      tier: 'returning',
      email: 'user@example.com',
      hint: {
        lastEmail: 'user@example.com',
        lastAuthMethod: 'google',
        lastLogin: new Date().toISOString(),
      },
    },
  },
};
