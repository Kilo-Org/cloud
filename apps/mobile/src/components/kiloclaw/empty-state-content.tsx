import { Plus, Server } from 'lucide-react-native';

import { EmptyState } from '@/components/empty-state';
import {
  AccessRequiredScreen,
  type AccessRequiredSubcase,
} from '@/components/kiloclaw/access-required-screen';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { type MobileOnboardingState } from '@/lib/derive-mobile-onboarding-state';

type EmptyStateContentProps = {
  state: MobileOnboardingState | undefined;
  foregroundColor: string;
  onCreate: () => void;
};

export function resolveAccessRequiredSubcase(
  state: MobileOnboardingState
): AccessRequiredSubcase | null {
  if (state.state === 'access_required') {
    return state.reason;
  }
  if (
    state.state === 'quarantined' ||
    state.state === 'multiple_current_conflict' ||
    state.state === 'non_canonical_earlybird'
  ) {
    return state.state;
  }
  // trial_eligible | has_access | pending_settlement — the `satisfies` guard forces
  // a typecheck failure if the server ever adds a new state kind we forgot to handle.
  state.state satisfies 'trial_eligible' | 'has_access' | 'pending_settlement';
  return null;
}

export function EmptyStateContent({
  state,
  foregroundColor,
  onCreate,
}: Readonly<EmptyStateContentProps>) {
  if (state === undefined) {
    return (
      <EmptyState
        icon={Server}
        title="No KiloClaw instances"
        description="You don't have any KiloClaw instances yet. Continue on kilo.ai to get started."
      />
    );
  }

  if (state.state === 'pending_settlement') {
    return (
      <EmptyState
        icon={Server}
        title="Finishing setup"
        description="Hang tight — we're finalizing your account. This usually takes a moment."
      />
    );
  }

  const accessRequiredSubcase = resolveAccessRequiredSubcase(state);
  if (accessRequiredSubcase) {
    return <AccessRequiredScreen subcase={accessRequiredSubcase} />;
  }

  return (
    <EmptyState
      icon={Server}
      title="No KiloClaw instances"
      description="Create your first instance to start running coding agents."
      action={
        <Button variant="outline" onPress={onCreate}>
          <Plus size={16} color={foregroundColor} />
          <Text>Get started</Text>
        </Button>
      }
    />
  );
}
