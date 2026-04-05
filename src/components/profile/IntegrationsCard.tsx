'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { OpenInExtensionButton } from '@/components/auth/OpenInExtensionButton';
import { CopyTokenButton } from '@/components/auth/CopyTokenButton';
import { Code, Terminal } from 'lucide-react';
import type { CustomerInfo } from '@/lib/customerInfo';
import { ResetAPITokenDialog } from './ResetAPITokenDialog';
import Image from 'next/image';
import Link from 'next/link';

type IntegrationsCardProps = {
  customerInfo: CustomerInfo;
  ideName: string;
  logoSrc: string | undefined;
  isProminent?: boolean;
};

// Normalize IDE name for comparison
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

export function IntegrationsCard({
  customerInfo,
  ideName,
  logoSrc,
  isProminent = false,
}: IntegrationsCardProps) {
  const normalizedLastUsed = normalizeIdeName(ideName);
  const isKnownIde = ['vscode', 'jetbrains', 'cli'].includes(normalizedLastUsed);

  return (
    <Card
      className={`w-full text-left ${isProminent ? 'border-2 border-blue-800 bg-blue-950/30 shadow-lg' : ''}`}
    >
      <CardHeader>
        <CardTitle className={`flex items-center gap-2 ${isProminent ? 'text-blue-200' : ''}`}>
          <Code className="h-5 w-5" />
          Integrations
          {isProminent && (
            <span className="ml-2 rounded-full bg-blue-900 px-2 py-1 text-xs font-medium text-blue-200">
              Get Started
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col pt-2">
        <div className="flex flex-row flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {/* Show "last used" button for unknown IDEs */}
            {!isKnownIde && (
              <OpenInExtensionButton
                className="flex h-9 items-center gap-2 px-3 py-2 text-sm"
                ideName={ideName}
                logoSrc={logoSrc}
              >
                {logoSrc && (
                  <Image src={logoSrc} alt={ideName} width={16} height={16} className="shrink-0" />
                )}
                <span>{ideName}</span>
                <LastUsedBadge />
              </OpenInExtensionButton>
            )}
            {/* VS Code button */}
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
            {/* JetBrains button */}
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
              {normalizedLastUsed === 'jetbrains' && <LastUsedBadge />}
            </Link>
            {/* CLI button */}
            <Link
              href="https://kilo.ai/install#cli"
              target="_blank"
              rel="noopener noreferrer"
              className="focus-visible:ring-ring border-input bg-background hover:bg-accent hover:text-accent-foreground inline-flex h-9 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium whitespace-nowrap shadow-sm transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
            >
              <Terminal className="h-4 w-4 shrink-0" />
              <span>CLI</span>
              {normalizedLastUsed === 'cli' && <LastUsedBadge />}
            </Link>
          </div>
          <ResetAPITokenDialog />
        </div>
        <div className="mt-6 space-y-3">
          <h3 className="text-sm font-medium">API Key</h3>
          <CopyTokenButton kiloToken={customerInfo.kiloToken} />
        </div>
      </CardContent>
    </Card>
  );
}
