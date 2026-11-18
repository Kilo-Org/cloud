'use client';

import { SUPPORT_EMAIL } from '@kilocode/app-shared/support';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { OpenInExtensionButton } from '@/components/auth/OpenInExtensionButton';
import { CopyTokenButton } from '@/components/auth/CopyTokenButton';
import { ResetAPITokenDialog } from '@/components/profile/ResetAPITokenDialog';
import { MessageCircleQuestion, Monitor, Terminal } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';

type SupportCardProps = {
  forOrganization?: boolean;
  kiloToken?: string;
  ideName?: string;
  logoSrc?: string;
  isProminent?: boolean;
};

function normalizeIdeName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('vs code') || lower.includes('vscode')) return 'vscode';
  if (lower.includes('jetbrains') || lower.includes('idea') || lower.includes('intellij'))
    return 'jetbrains';
  if (lower.includes('cli')) return 'cli';
  return lower;
}

function LastUsedBadge() {
  return (
    <span className="bg-muted text-muted-foreground ml-1 rounded px-1.5 py-0.5 text-xs">
      last used
    </span>
  );
}

export function SupportCard({
  forOrganization = false,
  kiloToken,
  ideName,
  logoSrc,
  isProminent = false,
}: SupportCardProps) {
  const normalizedLastUsed = ideName ? normalizeIdeName(ideName) : null;
  const isKnownIde =
    normalizedLastUsed !== null && ['vscode', 'jetbrains', 'cli'].includes(normalizedLastUsed);
  const installLead = forOrganization
    ? 'Ready to start coding? Get started with Kilo Code for your organization:'
    : 'Ready to start coding? Get started with Kilo Code:';

  return (
    <Card
      className={`w-full text-left ${isProminent ? 'border-2 border-blue-800 bg-blue-950/30 shadow-lg' : ''}`}
    >
      <CardHeader>
        <CardTitle className={`flex items-center gap-2 ${isProminent ? 'text-blue-200' : ''}`}>
          <MessageCircleQuestion className="h-5 w-5" />
          Support
          {isProminent && (
            <span className="ml-2 rounded-full bg-blue-900 px-2 py-1 text-xs font-medium text-blue-200">
              Get Started
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">
          Need help? Have a feature request? Want to chat? Contact us at{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary font-medium hover:underline">
            {SUPPORT_EMAIL}
          </a>
        </p>
        <div className="border-muted-foreground/20 space-y-3 border-t pt-4">
          <p className="text-muted-foreground text-sm">{installLead}</p>
          <div className="space-y-2">
            <Button asChild className="h-9 w-full sm:w-auto">
              <Link
                href="https://kilo.ai/install#desktop-downloads"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Monitor className="h-4 w-4 shrink-0" />
                Download Kilo Desktop
              </Link>
            </Button>
            <p className="text-muted-foreground text-xs">
              Free to download. macOS, Windows &amp; Linux.
            </p>
          </div>
          <p className="text-muted-foreground text-sm">
            Already have an editor? Use Kilo in your IDE or terminal.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {ideName && !isKnownIde && (
              <OpenInExtensionButton
                className="flex h-9 items-center gap-2 px-3 py-2 text-sm"
                ideName={ideName}
              >
                {logoSrc && (
                  <Image src={logoSrc} alt={ideName} width={16} height={16} className="shrink-0" />
                )}
                <span>{ideName}</span>
                <LastUsedBadge />
              </OpenInExtensionButton>
            )}
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
              {normalizedLastUsed === 'vscode' && <LastUsedBadge />}
            </OpenInExtensionButton>
            <Button asChild variant="outline" className="h-9">
              <Link
                href="https://plugins.jetbrains.com/plugin/28350-kilo-code"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Image
                  src="/logos/idea.svg"
                  alt="JetBrains"
                  width={16}
                  height={16}
                  className="shrink-0"
                />
                <span>JetBrains IDEs</span>
                {normalizedLastUsed === 'jetbrains' && <LastUsedBadge />}
              </Link>
            </Button>
            <Button asChild variant="outline" className="h-9">
              <Link href="https://kilo.ai/install#cli" target="_blank" rel="noopener noreferrer">
                <Terminal className="h-4 w-4 shrink-0" />
                <span>CLI</span>
                {normalizedLastUsed === 'cli' && <LastUsedBadge />}
              </Link>
            </Button>
          </div>
          <Link
            href="https://kilo.ai/install"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary text-sm font-medium hover:underline"
          >
            View all install options
          </Link>
        </div>
        {kiloToken && (
          <div className="border-muted-foreground/20 space-y-3 border-t pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">API Key</h3>
              <ResetAPITokenDialog />
            </div>
            <CopyTokenButton kiloToken={kiloToken} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
