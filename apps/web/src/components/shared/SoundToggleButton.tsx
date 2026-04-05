'use client';

import { Button } from '@/components/ui/button';
import { Volume2, VolumeX } from 'lucide-react';
import { cn } from '@/lib/utils';

type SoundToggleButtonProps = {
  /** Whether sound is currently enabled */
  enabled: boolean;
  /** Callback when toggle is clicked */
  onToggle: () => void;
  /** Size variant - affects icon and button dimensions */
  size?: 'sm' | 'default';
  /** Additional CSS classes */
  className?: string;
};

/**
 * A toggle button for enabling/disabling sound notifications.
 * Shows Volume2 icon when enabled, VolumeX when muted.
 * The parent component should manage state persistence.
 */
export function SoundToggleButton({
  enabled,
  onToggle,
  size = 'sm',
  className,
}: SoundToggleButtonProps) {
  const iconSize = size === 'sm' ? 'h-3 w-3' : 'h-4 w-4';
  const buttonSize = size === 'sm' ? 'h-6 w-6' : 'h-8 w-8';

  return (
    <Button
      size="icon"
      variant="ghost"
      onClick={onToggle}
      className={cn(buttonSize, 'hover:text-blue-400', className)}
      title={
        enabled
          ? 'Mute completion sounds on this device'
          : 'Enable completion sounds on this device'
      }
      aria-label={enabled ? 'Mute completion sounds' : 'Enable completion sounds'}
    >
      {enabled ? <Volume2 className={iconSize} /> : <VolumeX className={iconSize} />}
    </Button>
  );
}
