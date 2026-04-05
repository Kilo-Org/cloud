'use client';

import { OpenInExtensionButton } from '@/components/auth/OpenInExtensionButton';
import { Banner } from '@/components/shared/Banner';
import { EDITOR_OPTIONS } from '@/lib/editorOptions';
import { ExternalLink, Info } from 'lucide-react';
import { LANDING_URL } from '@/lib/constants';

type OrganizationWelcomeHeaderProps = {
  organizationName: string;
  onDismiss: () => void;
};

export function OrganizationWelcomeHeader({
  organizationName,
  onDismiss,
}: OrganizationWelcomeHeaderProps) {
  return (
    <Banner color="blue" size="lg">
      <Banner.Icon>
        <Info className="h-6 w-6" />
      </Banner.Icon>
      <Banner.Content>
        <Banner.Title>Welcome to {organizationName}!</Banner.Title>
        <Banner.Description>
          You&apos;ve been added to the <strong>{organizationName}</strong> organization. Click
          &apos;Open in vscode&apos; to get started with Kilo Code.
        </Banner.Description>
        <Banner.Action>
          <span className="bg-background">
            <OpenInExtensionButton
              className="h-10 px-4 py-2"
              ideName="vscode"
              logoSrc={EDITOR_OPTIONS.find(x => x.name === 'VS Code')?.logoSrc}
            />
          </span>
          <Banner.Button href={`${LANDING_URL}/docs`} target="_blank" variant="outline">
            Read documentation
            <ExternalLink />
          </Banner.Button>
        </Banner.Action>
      </Banner.Content>
      <Banner.Dismiss onDismiss={onDismiss} />
    </Banner>
  );
}
