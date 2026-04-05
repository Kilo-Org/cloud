'use client';

import { Card, CardContent } from '@/components/ui/card';
import { OpenInExtensionButton } from '@/components/auth/OpenInExtensionButton';
import { EDITOR_OPTIONS } from '@/lib/editorOptions';
import { ExternalLink, X } from 'lucide-react';
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
    <Card className="border-blue-900 bg-blue-950/30">
      <CardContent className="p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="shrink-0">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-900/50">
              <svg
                className="h-6 w-6 text-blue-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
          </div>
          <div className="flex-1">
            <h3 className="mb-2 text-xl font-semibold text-blue-100">
              Welcome to {organizationName}!
            </h3>
            <p className="mb-4 text-blue-200">
              You&apos;ve been added to the <strong>{organizationName}</strong> organization. Click
              &apos;Open in vscode&apos; to get started with Kilo Code.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <span className="bg-background">
                <OpenInExtensionButton
                  className="h-10 px-4 py-2"
                  ideName="vscode"
                  logoSrc={EDITOR_OPTIONS.find(x => x.name === 'VS Code')?.logoSrc}
                />
              </span>
              <a
                href={`${LANDING_URL}/docs`}
                target="_blank"
                className="bg-background inline-flex items-center justify-center gap-2 rounded-md border border-blue-700 px-4 py-2 text-sm font-medium text-blue-400 hover:bg-blue-950/50 focus:ring-2 focus:ring-blue-400 focus:ring-blue-500 focus:outline-none"
              >
                Read documentation
                <ExternalLink className="h-4 w-4" />
              </a>
            </div>
          </div>
          <button
            onClick={onDismiss}
            title="Dismiss"
            className="shrink-0 rounded-full p-1 text-blue-400 hover:bg-blue-900/50 hover:text-blue-300 focus:ring-2 focus:ring-blue-400 focus:ring-blue-500 focus:outline-none"
            aria-label="Dismiss welcome message"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
