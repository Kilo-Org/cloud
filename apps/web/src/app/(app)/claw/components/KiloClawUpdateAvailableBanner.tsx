'use client';

import { ArrowUpCircle, X } from 'lucide-react';
import { Banner } from '@/components/shared/Banner';

type KiloClawUpdateAvailableBannerProps = {
  catalogNewerThanImage: boolean;
  onUpgrade: () => void;
  onDismiss: () => void;
  className?: string;
};

export function KiloClawUpdateAvailableBanner({
  catalogNewerThanImage,
  onUpgrade,
  onDismiss,
  className,
}: KiloClawUpdateAvailableBannerProps) {
  return (
    <Banner color="amber" className={className}>
      <Banner.Icon>
        <ArrowUpCircle />
      </Banner.Icon>
      <Banner.Content>
        <Banner.Title>A new version of KiloClaw is available</Banner.Title>
        <Banner.Description>
          {catalogNewerThanImage ? 'This update includes a new OpenClaw version. ' : null}
          Upgrade your instance to get the latest features and fixes.
        </Banner.Description>
      </Banner.Content>
      <Banner.Button className="text-white" onClick={onUpgrade}>
        Upgrade now
      </Banner.Button>
      <button
        type="button"
        onClick={onDismiss}
        className="text-amber-400/60 hover:text-amber-400 transition-colors"
        aria-label="Dismiss upgrade banner"
      >
        <X className="h-4 w-4" />
      </button>
    </Banner>
  );
}
