'use client';

import { useState } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import KiloLogo from '@/components/KiloLogo';
import { getPlatform, type PlatformId, type PlatformOption } from '../../_components/platforms';

type ProgressListProps = {
  count: number;
  activeIndex: number;
};

type AuthorizeFlowProps = {
  serviceIds: PlatformId[];
};

export function AuthorizeFlow(props: AuthorizeFlowProps) {
  const { serviceIds } = props;
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState(false);

  const services = serviceIds.map(id => getPlatform(id)).filter(p => p !== undefined);
  const current = services[index];
  const isLast = index === services.length - 1;

  const handleAuthorize = () => {
    // Design-only: simulate a successful OAuth round trip.
    if (!isLast) {
      setIndex(i => i + 1);
    } else {
      setDone(true);
    }
  };

  const handleSkip = () => {
    if (!isLast) {
      setIndex(i => i + 1);
    } else {
      setDone(true);
    }
  };

  if (done || !current) {
    return (
      <div className="flex w-full flex-col items-center gap-12">
        <Completed hasSelectedServices={services.length > 0} onContinue={() => router.push('/')} />
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
            <Button onClick={handleAuthorize} size="lg" className="w-full">
              Authorize on {current.name}
              <ChevronRight className="size-4" />
            </Button>
            <button
              type="button"
              onClick={handleSkip}
              className="text-muted-foreground hover:text-foreground text-sm underline-offset-4 hover:underline"
            >
              Skip for now
            </button>
          </div>
        </motion.section>
      </AnimatePresence>
    </div>
  );
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
  onContinue,
}: {
  hasSelectedServices: boolean;
  onContinue: () => void;
}) {
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
          {hasSelectedServices
            ? 'Setup is complete. You can connect more services or fine-tune access from settings later.'
            : 'No services were connected. You can connect chat, code, and issue tools from settings later.'}
        </p>
      </div>
      <Button onClick={onContinue} size="lg" className="w-full">
        Open Kilo
      </Button>
    </motion.section>
  );
}
