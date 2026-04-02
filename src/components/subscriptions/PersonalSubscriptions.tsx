'use client';

import { useState } from 'react';
import { PageLayout } from '@/components/PageLayout';
import { TerminalToggle } from './TerminalToggle';
import { KiloPassGroup } from './kilo-pass/KiloPassGroup';
import { KiloClawGroup } from './kiloclaw/KiloClawGroup';
import { CodingPlansGroup } from './coding-plans/CodingPlansGroup';
import { ENABLE_CODING_PLAN_SUBSCRIPTIONS } from '@/lib/constants';

export function PersonalSubscriptions() {
  const [showTerminal, setShowTerminal] = useState(false);

  return (
    <PageLayout
      title="Subscriptions"
      subtitle="Manage your subscriptions and billing in one place."
      headerActions={
        <TerminalToggle
          label="Show cancelled"
          checked={showTerminal}
          onCheckedChange={setShowTerminal}
        />
      }
    >
      <KiloPassGroup showTerminal={showTerminal} />
      <KiloClawGroup showTerminal={showTerminal} />
      {ENABLE_CODING_PLAN_SUBSCRIPTIONS ? <CodingPlansGroup /> : null}
    </PageLayout>
  );
}
