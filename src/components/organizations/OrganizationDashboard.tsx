'use client';

import { useState, useEffect } from 'react';
import { OrganizationInfoCard } from './OrganizationInfoCard';
import { OrganizationAdminMembers } from './OrganizationMembersCard';
import { OrganizationUsageSummaryCard } from './OrganizationUsageSummaryCard';
import { OrganizationDataCollectionCard } from './OrganizationDataCollectionCard';
import { SeatUsageCard } from './SeatUsageCard';
import { SSOSignupCard } from './SSOSignupCard';
import { LockableContainer } from './LockableContainer';
import { OrganizationAdminContextProvider } from './OrganizationContextWrapper';
import { OrganizationPageHeader } from './OrganizationPageHeader';
import { OrganizationWelcomeHeader } from './OrganizationWelcomeHeader';
import { NewOrganizationWelcomeHeader } from './NewOrganizationWelcomeHeader';
import { OrganizationTopupSuccessHeader } from './OrganizationTopupSuccessHeader';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { useRoleTesting } from '@/contexts/RoleTestingContext';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MessageCircleQuestion, Terminal } from 'lucide-react';
import { OrganizationProvidersAndModelsConfigurationCard } from '@/components/organizations/OrganizationProvidersAndModelsConfigurationCard';
import { OpenInExtensionButton } from '@/components/auth/OpenInExtensionButton';
import Image from 'next/image';
import Link from 'next/link';

const DISMISSED_BANNERS_KEY = 'org-welcome-banner-dismissed';

// Helper functions for managing localStorage
const getDismissedOrganizations = (): string[] => {
  try {
    const stored = localStorage.getItem(DISMISSED_BANNERS_KEY);
    return stored ? (JSON.parse(stored) as string[]) : [];
  } catch {
    return [];
  }
};

const addDismissedOrganization = (organizationId: string): void => {
  try {
    const dismissed = getDismissedOrganizations();
    if (!dismissed.includes(organizationId)) {
      dismissed.push(organizationId);
      localStorage.setItem(DISMISSED_BANNERS_KEY, JSON.stringify(dismissed));
    }
  } catch {
    // Silently fail if localStorage is not available
  }
};

type Props = {
  organizationId: string;
  role: OrganizationRole;
  topupAmount: number;
};

export function OrganizationDashboard({ organizationId, role, topupAmount }: Props) {
  const [showWelcomeMessage, setShowWelcomeMessage] = useState(false);
  const [showNewOrgWelcome, setShowNewOrgWelcome] = useState(false);
  const [showTopupSuccess, setShowTopupSuccess] = useState(topupAmount !== 0);
  const { data: organizationData } = useOrganizationWithMembers(organizationId);
  const { assumedRole } = useRoleTesting();

  // Use assumed role if available, otherwise use actual role
  const currentRole = assumedRole === 'KILO ADMIN' ? 'owner' : assumedRole || role;
  const isKiloAdmin = assumedRole === 'KILO ADMIN';

  // Check localStorage on component mount to determine if welcome banners should be shown
  useEffect(() => {
    const dismissedOrgs = getDismissedOrganizations();
    const shouldShowBanner = !dismissedOrgs.includes(organizationId);
    if (!organizationData) {
      return;
    }

    if (shouldShowBanner) {
      if (currentRole === 'owner') {
        const orgCreationDate = new Date(organizationData.created_at).getTime();
        // if org was created more than 6 hours ago do not show the new org welcome
        const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
        if (orgCreationDate < sixHoursAgo) {
          return;
        }
        setShowNewOrgWelcome(true);
      } else {
        setShowWelcomeMessage(true);
      }
    }
  }, [organizationId, currentRole, organizationData]);

  const handleDismissWelcome = () => {
    addDismissedOrganization(organizationId);
    setShowWelcomeMessage(false);
  };

  const handleDismissNewOrgWelcome = () => {
    addDismissedOrganization(organizationId);
    setShowNewOrgWelcome(false);
  };

  return (
    <OrganizationAdminContextProvider organizationId={organizationId}>
      <div className="flex w-full flex-col gap-y-6">
        <OrganizationPageHeader
          organizationId={organizationId}
          title="Organization Details"
          showBackButton={false}
        />
        {showTopupSuccess && organizationData && (
          <OrganizationTopupSuccessHeader
            organizationName={organizationData.name}
            amountUsd={topupAmount.toString()}
            onDismiss={() => setShowTopupSuccess(false)}
          />
        )}
        {showWelcomeMessage && organizationData && (
          <OrganizationWelcomeHeader
            organizationName={organizationData.name}
            onDismiss={handleDismissWelcome}
          />
        )}
        {showNewOrgWelcome && organizationData && (
          <NewOrganizationWelcomeHeader
            organizationId={organizationId}
            organizationName={organizationData.name}
            plan={organizationData.plan}
            onDismiss={handleDismissNewOrgWelcome}
          />
        )}
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
          <div className="space-y-8 lg:col-span-1">
            <LockableContainer>
              <OrganizationInfoCard organizationId={organizationId} />
            </LockableContainer>
            {organizationData && (
              <>
                {organizationData.plan === 'teams' ? (
                  <LockableContainer>
                    <OrganizationDataCollectionCard organizationId={organizationId} />
                  </LockableContainer>
                ) : (
                  <OrganizationProvidersAndModelsConfigurationCard
                    organizationId={organizationId}
                    readonly={!(currentRole === 'owner' || isKiloAdmin)}
                  />
                )}
              </>
            )}
            <OrganizationUsageSummaryCard organizationId={organizationId} />
          </div>
          <div className="space-y-8 lg:col-span-2">
            <LockableContainer>
              <OrganizationAdminMembers organizationId={organizationId} />
            </LockableContainer>
            <SeatUsageCard organizationId={organizationId} />
            {organizationData?.plan === 'enterprise' && (
              <LockableContainer>
                <SSOSignupCard organization={organizationData} role={currentRole} />
              </LockableContainer>
            )}
            <Card>
              <CardHeader>
                <CardTitle>
                  <MessageCircleQuestion className="mr-2 inline h-5 w-5" />
                  Support
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-muted-foreground text-sm">
                  Need help? Have a feature request? Want to chat? Contact us at{' '}
                  <a
                    href="mailto:teams@kilocode.ai"
                    className="text-primary font-medium hover:underline"
                  >
                    teams@kilocode.ai
                  </a>
                </p>
                <div className="border-muted-foreground/20 space-y-3 border-t pt-4">
                  <p className="text-muted-foreground text-sm">
                    Ready to start coding? Get started with Kilo Code for your organization:
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    <OpenInExtensionButton
                      className="flex h-9 items-center gap-2 px-3 py-2 text-sm"
                      ideName="VS Code"
                      source="vscode"
                    >
                      <Image
                        src="/logos/vscode.svg"
                        alt="VS Code"
                        width={16}
                        height={16}
                        className="shrink-0"
                      />
                      <span>VS Code</span>
                    </OpenInExtensionButton>
                    <Link
                      href="https://plugins.jetbrains.com/plugin/28350-kilo-code"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="focus-visible:ring-ring border-input bg-background hover:bg-accent hover:text-accent-foreground inline-flex h-9 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium whitespace-nowrap shadow-sm transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                    >
                      <Image
                        src="/logos/idea.svg"
                        alt="JetBrains"
                        width={16}
                        height={16}
                        className="shrink-0"
                      />
                      <span>JetBrains</span>
                    </Link>
                    <Link
                      href="https://kilo.ai/install#cli"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="focus-visible:ring-ring border-input bg-background hover:bg-accent hover:text-accent-foreground inline-flex h-9 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium whitespace-nowrap shadow-sm transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                    >
                      <Terminal className="h-4 w-4 shrink-0" />
                      <span>CLI</span>
                    </Link>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </OrganizationAdminContextProvider>
  );
}
