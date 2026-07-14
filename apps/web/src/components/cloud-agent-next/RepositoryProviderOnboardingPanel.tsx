'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import styles from './RepositoryProviderOnboardingPanel.module.css';

const providerLogoPaths = {
  github:
    'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  gitlab:
    'm23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z',
  bitbucket:
    'M.778 1.213a.768.768 0 0 0-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 0 0 .77-.646l3.27-20.03a.768.768 0 0 0-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z',
} as const;

type ProviderLogoProps = {
  provider: keyof typeof providerLogoPaths;
  className?: string;
};

function ProviderLogo({ provider, className }: ProviderLogoProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path d={providerLogoPaths[provider]} fill="currentColor" />
    </svg>
  );
}

type RepositoryProviderOnboardingPanelProps = {
  organizationId?: string;
  isCheckingConnection?: boolean;
  onCheckConnection: () => void;
};

type RepositoryProvider = {
  name: string;
  href: string;
  icon: ReactNode;
};

export function RepositoryProviderOnboardingPanel({
  organizationId,
  isCheckingConnection = false,
  onCheckConnection,
}: RepositoryProviderOnboardingPanelProps) {
  const integrationBasePath = organizationId
    ? `/organizations/${organizationId}/integrations`
    : '/integrations';
  const providers: RepositoryProvider[] = [
    {
      name: 'GitHub',
      href: `${integrationBasePath}/github`,
      icon: <ProviderLogo provider="github" className="size-5 text-foreground" />,
    },
    {
      name: 'GitLab',
      href: `${integrationBasePath}/gitlab`,
      icon: <ProviderLogo provider="gitlab" className="size-5 text-[#FC6D26]" />,
    },
  ];

  if (organizationId) {
    providers.push({
      name: 'Bitbucket',
      href: `${integrationBasePath}/bitbucket`,
      icon: <ProviderLogo provider="bitbucket" className="size-5 text-[#0C66E4]" />,
    });
  }

  return (
    <section
      className="mx-auto w-full max-w-md rounded-xl bg-surface-raised p-6"
      aria-labelledby="source-control-onboarding-title"
    >
      <div className="space-y-1.5">
        <h2 id="source-control-onboarding-title" className="type-heading text-balance">
          Connect a repository provider
        </h2>
        <p className="type-body max-w-xl text-pretty text-muted-foreground">
          Cloud Agent needs access to your code before it can start a session.
        </p>
      </div>

      <div className="mt-6 overflow-hidden rounded-lg border border-border">
        {providers.map(provider => (
          <Link
            key={provider.name}
            href={provider.href}
            className="group relative flex min-h-12 items-center gap-3 px-4 transition-colors duration-150 ease-out-strong not-last:border-b not-last:border-border hover:bg-surface-hover focus-visible:z-10 focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 focus-visible:outline-none active:bg-surface-selected"
          >
            <div className="flex size-8 shrink-0 items-center justify-center text-foreground">
              {provider.icon}
            </div>
            <span className="type-body flex-1 font-medium text-foreground">{provider.name}</span>
            <ChevronRight
              className="size-5 shrink-0 text-muted-foreground transition-colors duration-150 ease-out-strong group-hover:text-foreground"
              aria-hidden="true"
            />
          </Link>
        ))}
      </div>

      <p className="type-body mt-5 text-muted-foreground">
        Already connected?{' '}
        <Button
          variant="link"
          className="relative h-auto rounded-sm p-0 text-muted-foreground underline decoration-muted-foreground/50 underline-offset-4 after:absolute after:-inset-y-3 after:inset-x-0 hover:text-foreground hover:decoration-foreground disabled:no-underline"
          onClick={onCheckConnection}
          disabled={isCheckingConnection}
          aria-busy={isCheckingConnection}
        >
          <span
            className={`type-body ${isCheckingConnection ? styles.shimmer : ''}`}
            aria-live="polite"
          >
            {isCheckingConnection ? 'Checking…' : 'Check connection'}
          </span>
        </Button>
      </p>
    </section>
  );
}
