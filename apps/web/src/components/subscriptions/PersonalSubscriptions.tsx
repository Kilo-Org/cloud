'use client';

import { useQuery } from '@tanstack/react-query';
import { Code2, Crown } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { PageLayout } from '@/components/PageLayout';
import KiloCrabIcon from '@/components/KiloCrabIcon';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTRPC } from '@/lib/trpc/utils';
import { isCodingPlanTerminal, isKiloclawTerminal, isKiloPassTerminal } from './helpers';
import { TerminalToggle } from './TerminalToggle';
import { KiloPassGroup } from './kilo-pass/KiloPassGroup';
import { KiloClawGroup } from './kiloclaw/KiloClawGroup';
import { CodingPlansGroup } from './coding-plans/CodingPlansGroup';

type SubscriptionTab = 'kilo-pass' | 'kiloclaw' | 'coding-plans';

const subscriptionTabClassName =
  'after:bg-brand-primary relative h-11 gap-2 border-transparent px-3 text-muted-foreground after:absolute after:inset-x-3 after:bottom-1 after:h-0.5 after:rounded-full after:opacity-0 after:transition-opacity hover:text-foreground data-[state=active]:border-transparent data-[state=active]:bg-background data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:after:opacity-100';

function getSubscriptionTabFromHash(hash: string): SubscriptionTab {
  if (hash === '#kiloclaw') {
    return 'kiloclaw';
  }

  if (hash === '#coding-plans') {
    return 'coding-plans';
  }

  return 'kilo-pass';
}

function getSubscriptionTabSnapshot(): SubscriptionTab {
  return getSubscriptionTabFromHash(window.location.hash);
}

function getSubscriptionTabServerSnapshot(): SubscriptionTab {
  return 'kilo-pass';
}

function subscribeToSubscriptionTabChange(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function replaceSubscriptionTabHash(tab: SubscriptionTab) {
  const nextHash = `#${tab}`;
  if (window.location.hash === nextHash) {
    return;
  }

  const url = new URL(window.location.href);
  url.hash = nextHash;
  window.history.replaceState(window.history.state, '', url.href);
  window.dispatchEvent(new Event('hashchange'));
}

function scrollSelectedTabIntoView(element: HTMLButtonElement | null) {
  element?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

export function PersonalSubscriptions({ codingPlansEnabled }: { codingPlansEnabled: boolean }) {
  const [showTerminal, setShowTerminal] = useState(false);
  const selectedTab = useSyncExternalStore(
    subscribeToSubscriptionTabChange,
    getSubscriptionTabSnapshot,
    getSubscriptionTabServerSnapshot
  );
  // Fall back to the Kilo Pass tab when Coding Plans is hidden so a stale
  // #coding-plans hash never selects a tab that isn't rendered.
  const activeTab =
    selectedTab === 'coding-plans' && !codingPlansEnabled ? 'kilo-pass' : selectedTab;
  const trpc = useTRPC();
  const kiloPassQuery = useQuery(trpc.kiloPass.getState.queryOptions());
  const kiloClawQuery = useQuery(trpc.kiloclaw.listPersonalSubscriptions.queryOptions());
  const codingPlansQuery = useQuery(
    trpc.codingPlans.listSubscriptions.queryOptions(undefined, { enabled: codingPlansEnabled })
  );

  const hasTerminalSubscriptions =
    (kiloPassQuery.data?.subscription != null &&
      isKiloPassTerminal(kiloPassQuery.data.subscription.status)) ||
    (kiloClawQuery.data?.subscriptions.some(subscription =>
      isKiloclawTerminal(subscription.status)
    ) ??
      false) ||
    (codingPlansQuery.data?.some(subscription => isCodingPlanTerminal(subscription.status)) ??
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
      <Tabs
        value={activeTab}
        onValueChange={value => replaceSubscriptionTabHash(getSubscriptionTabFromHash(`#${value}`))}
        className="space-y-6"
      >
        <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-xl p-1">
          <TabsTrigger
            ref={activeTab === 'kilo-pass' ? scrollSelectedTabIntoView : undefined}
            value="kilo-pass"
            className={subscriptionTabClassName}
          >
            <Crown className="size-4" />
            Kilo Pass
          </TabsTrigger>
          <TabsTrigger
            ref={activeTab === 'kiloclaw' ? scrollSelectedTabIntoView : undefined}
            value="kiloclaw"
            className={subscriptionTabClassName}
          >
            <KiloCrabIcon className="size-4" />
            KiloClaw
          </TabsTrigger>
          {codingPlansEnabled ? (
            <TabsTrigger
              ref={activeTab === 'coding-plans' ? scrollSelectedTabIntoView : undefined}
              value="coding-plans"
              className={subscriptionTabClassName}
            >
              <Code2 className="size-4" />
              Coding Plans
            </TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent value="kilo-pass" className="mt-0">
          <KiloPassGroup showTerminal={showTerminal} hideHeader />
        </TabsContent>
        <TabsContent value="kiloclaw" className="mt-0">
          <KiloClawGroup showTerminal={showTerminal} hideHeader />
        </TabsContent>
        {codingPlansEnabled ? (
          <TabsContent value="coding-plans" className="mt-0">
            <CodingPlansGroup showTerminal={showTerminal} hideHeader />
          </TabsContent>
        ) : null}
      </Tabs>
    </PageLayout>
  );
}
