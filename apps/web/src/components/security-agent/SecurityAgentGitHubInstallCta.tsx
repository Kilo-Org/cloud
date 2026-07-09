'use client';

import Link from 'next/link';
import { Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';

type SecurityAgentGitHubInstallCtaProps = {
  installUrl: string;
};

export function SecurityAgentGitHubInstallCta({ installUrl }: SecurityAgentGitHubInstallCtaProps) {
  return (
    <div className="border-border flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-16 text-center">
      <Shield className="text-muted-foreground mb-4 size-12 opacity-40" aria-hidden="true" />
      <h3 className="text-lg font-medium">Connect GitHub to get started</h3>
      <p className="text-muted-foreground mt-2 max-w-md text-center text-sm">
        Install the Kilo GitHub App to automatically sync Dependabot alerts and manage security
        findings across your repositories.
      </p>
      <Button
        asChild
        className="bg-brand-primary text-primary-foreground hover:bg-brand-primary/90 mt-6"
      >
        <Link href={installUrl}>Install GitHub App</Link>
      </Button>
    </div>
  );
}
