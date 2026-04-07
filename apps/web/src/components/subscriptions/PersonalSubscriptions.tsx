'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { PageLayout } from '@/components/PageLayout';
import { Accordion } from '@/components/ui/accordion';
import { useTRPC } from '@/lib/trpc/utils';
import { isKiloclawTerminal, isKiloPassTerminal } from './helpers';
import { TerminalToggle } from './TerminalToggle';
import { KiloPassGroup } from './kilo-pass/KiloPassGroup';
import { KiloClawGroup } from './kiloclaw/KiloClawGroup';
import { DirectByokGroup } from './direct-byok/DirectByokGroup';
import { ENABLE_DIRECT_BYOK_SUBSCRIPTIONS } from '@/lib/constants';

export function PersonalSubscriptions() {
  const [showTerminal, setShowTerminal] = useState(false);
  const [expandedSection, setExpandedSection] = useState('kilo-pass');
  const trpc = useTRPC();
  const kiloPassQuery = useQuery(trpc.kiloPass.getState.queryOptions());
  const kiloClawQuery = useQuery(trpc.kiloclaw.listPersonalSubscriptions.queryOptions());

  const hasTerminalSubscriptions =
    (kiloPassQuery.data?.subscription != null &&
      isKiloPassTerminal(kiloPassQuery.data.subscription.status)) ||
    (kiloClawQuery.data?.subscriptions.some(subscription =>
      isKiloclawTerminal(subscription.status)
    ) ??
      false);

  return (
    <PageLayout
      title="Subscriptions"
      subtitle="Manage your subscriptions and billing in one place."
      headerActions={
        hasTerminalSubscriptions ? (
          <TerminalToggle
            label="Show ended"
            checked={showTerminal}
            onCheckedChange={setShowTerminal}
          />
        ) : null
      }
    >
      <Accordion
        type="single"
        collapsible
        value={expandedSection}
        onValueChange={setExpandedSection}
        className="space-y-8"
      >
        <KiloPassGroup showTerminal={showTerminal} accordionValue="kilo-pass" />
        <KiloClawGroup showTerminal={showTerminal} accordionValue="kiloclaw" />
        {ENABLE_DIRECT_BYOK_SUBSCRIPTIONS ? (
          <DirectByokGroup accordionValue="coding-plans" />
        ) : null}
      </Accordion>
    </PageLayout>
  );
}
