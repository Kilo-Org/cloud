'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, Check, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import KiloLogo from '@/components/KiloLogo';
import { useUser } from '@/hooks/useUser';
import {
  getPlatformOAuthConnectPath,
  type StandardOAuthPlatform,
} from '@/lib/integrations/oauth/paths';
import { getPlatform, type PlatformId, type PlatformOption } from '../../_components/platforms';
import { buildReturnToPath } from './authorize-path';

type ProgressListProps = {
  count: number;
  activeIndex: number;
};

type AuthorizeFlowProps = {
  serviceIds: PlatformId[];
  connectedServiceIds: PlatformId[];
  organizationId?: string;
  initialIndex: number;
  initialError?: string;
};

export function AuthorizeFlow(props: AuthorizeFlowProps) {
  const { serviceIds, connectedServiceIds, organizationId, initialIndex, initialError } = props;
  const router = useRouter();
  const { data: user } = useUser();
  const [index, setIndex] = useState(initialIndex);
  const [done, setDone] = useState(initialIndex >= serviceIds.length);
  const [connectionError, setConnectionError] = useState<string | null>(initialError ?? null);
  const [isStartingOAuth, setIsStartingOAuth] = useState(false);

  const services = serviceIds.map(id => getPlatform(id)).filter(p => p !== undefined);
  const current = services[index];
  const getAuthorizePath = (step: number) =>
    buildReturnToPath({
      serviceIds,
      connectedServiceIds,
      organizationId,
      step,
    });
  const returnTo = getAuthorizePath(index);

  const isLoadingGitHubUser = current?.id === 'github' && !organizationId && !user;

  useEffect(() => {
    setIndex(initialIndex);
    setDone(initialIndex >= serviceIds.length);
    setConnectionError(initialError ?? null);
  }, [initialError, initialIndex, serviceIds.length]);

  const advance = () => {
    const nextIndex = index + 1;
    setConnectionError(null);
    setIndex(nextIndex);
    setDone(nextIndex >= services.length);
    router.push(getAuthorizePath(nextIndex), { scroll: false });
  };

  const handleAuthorize = async () => {
    if (!current || isStartingOAuth || isLoadingGitHubUser) return;
    setConnectionError(null);

    try {
      setIsStartingOAuth(true);
      const oauthUrl = await getOAuthUrl(current.id, {
        organizationId,
        returnTo,
        userId: user?.id,
      });

      if (!oauthUrl) {
        setConnectionError(`${current.name} setup is not available from this flow yet.`);
        setIsStartingOAuth(false);
        return;
      }

      window.location.href = oauthUrl;
    } catch (error) {
      setIsStartingOAuth(false);
      setConnectionError(
        error instanceof Error ? error.message : `Couldn't start ${current.name}.`
      );
    }
  };

  const handleSkip = () => {
    if (isStartingOAuth) return;
    advance();
  };

  if (done || !current) {
    return (
      <div className="flex w-full flex-col items-center gap-12">
        <Completed
          hasSelectedServices={services.length > 0}
          connectedServiceIds={connectedServiceIds}
          onContinue={() => router.push('/')}
        />
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col items-center gap-12">
      <ProgressList count={services.length} activeIndex={index} />

      <AnimatePresence mode="wait" initial={false}>
        <motion.section
          key={current.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
          className="flex w-full max-w-sm flex-col items-center gap-12"
        >
          <ConnectionBadge service={current} />

          <div className="flex w-full flex-col gap-4 text-center">
            <h1 className="text-2xl font-bold tracking-tight">
              Kilo wants to connect with {current.name}
            </h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              You'll be redirected to {current.name} to grant access. Kilo only requests the
              permissions it needs.
            </p>
          </div>

          <div className="flex w-full flex-col items-center gap-4">
            {connectionError && (
              <p className="text-destructive flex items-center gap-2 text-sm" role="alert">
                <AlertCircle className="size-4" />
                {connectionError}
              </p>
            )}
            <Button
              onClick={handleAuthorize}
              size="lg"
              className="w-full"
              disabled={isStartingOAuth || isLoadingGitHubUser}
            >
              {isStartingOAuth || isLoadingGitHubUser
                ? 'Starting authorization...'
                : `Authorize on ${current.name}`}
              <ChevronRight className="size-4" />
            </Button>
            <button
              type="button"
              onClick={handleSkip}
              disabled={isStartingOAuth}
              className="text-muted-foreground hover:text-foreground disabled:text-muted-foreground/60 text-sm underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:no-underline"
            >
              Skip for now
            </button>
          </div>
        </motion.section>
      </AnimatePresence>
    </div>
  );
}

async function getOAuthUrl(
  platformId: PlatformId,
  options: {
    organizationId?: string;
    returnTo: string;
    userId?: string;
  }
): Promise<string | null> {
  if (isCollabOAuthConnectPlatform(platformId)) {
    return getPlatformOAuthConnectPath(platformId, options.organizationId, options.returnTo);
  }
  if (platformId === 'github') {
    const ownerToken = options.organizationId
      ? `org_${options.organizationId}`
      : options.userId
        ? `user_${options.userId}`
        : null;
    if (!ownerToken) return null;
    const githubAppName = process.env.NEXT_PUBLIC_GITHUB_APP_NAME || 'KiloConnect';
    const state = `${ownerToken}|return=${encodeURIComponent(options.returnTo)}`;
    return `https://github.com/apps/${githubAppName}/installations/new?state=${encodeURIComponent(state)}`;
  }
  return null;
}

const COLLAB_OAUTH_CONNECT_PLATFORM_IDS = new Set<PlatformId>([
  'slack',
  'discord',
  'linear',
  'gitlab',
]);

function isCollabOAuthConnectPlatform(
  platformId: PlatformId
): platformId is Extract<PlatformId, StandardOAuthPlatform> {
  return COLLAB_OAUTH_CONNECT_PLATFORM_IDS.has(platformId);
}

function ConnectionBadge({ service }: { service: PlatformOption }) {
  const Icon = service.icon;
  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <div className="bg-card border-border grid size-20 place-items-center rounded-2xl border">
        <span className="text-primary size-10">
          <KiloLogo />
        </span>
      </div>
      <ConnectorDots />
      <div className="bg-card border-border grid size-20 place-items-center rounded-2xl border shadow-[0_0_24px_-4px_rgba(237,255,0,0.18)]">
        <Icon className="size-10" />
      </div>
    </div>
  );
}

function ConnectorDots() {
  return (
    <span className="flex items-center gap-1">
      <span className="bg-muted-foreground/40 size-1 rounded-full" />
      <span className="bg-muted-foreground/60 size-1 rounded-full" />
      <span className="bg-muted-foreground/40 size-1 rounded-full" />
    </span>
  );
}

function ProgressList({ count, activeIndex }: ProgressListProps) {
  return (
    <div
      className="flex w-full max-w-sm items-center gap-2"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={count}
      aria-valuenow={activeIndex + 1}
      aria-label="Authorization progress"
    >
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className={cn(
            'h-1 flex-1 rounded-full transition-colors duration-200',
            i <= activeIndex ? 'bg-primary' : 'bg-border'
          )}
        />
      ))}
    </div>
  );
}

function Completed({
  hasSelectedServices,
  connectedServiceIds,
  onContinue,
}: {
  hasSelectedServices: boolean;
  connectedServiceIds: PlatformId[];
  onContinue: () => void;
}) {
  const connectedServiceNames = connectedServiceIds.map(getPlatformName);

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
      className="flex w-full max-w-sm flex-col items-center gap-12"
    >
      <div className="bg-primary/10 ring-primary/30 grid size-16 place-items-center rounded-full ring-1">
        <Check className="text-primary size-7" strokeWidth={3} />
      </div>
      <div className="flex w-full flex-col gap-4 text-center">
        <h1 className="text-2xl font-bold tracking-tight">Kilo is ready</h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {getCompletionDescription({ hasSelectedServices, connectedServiceNames })}
        </p>
      </div>
      <Button onClick={onContinue} size="lg" className="w-full">
        Open Kilo
      </Button>
    </motion.section>
  );
}

function getCompletionDescription({
  hasSelectedServices,
  connectedServiceNames,
}: {
  hasSelectedServices: boolean;
  connectedServiceNames: string[];
}): string {
  if (hasSelectedServices) {
    return 'Setup is complete. You can connect more services or fine-tune access from settings later.';
  }

  if (connectedServiceNames.length > 0) {
    const serviceList = formatServiceList(connectedServiceNames);
    const verb = connectedServiceNames.length === 1 ? 'is' : 'are';
    return `${serviceList} ${verb} already set up. You can connect more services or fine-tune access from settings later.`;
  }

  return 'No services were connected. You can connect chat, code, and issue tools from settings later.';
}

function getPlatformName(platformId: PlatformId): string {
  return getPlatform(platformId)?.name ?? platformId;
}

function formatServiceList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? 'Selected services';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}
