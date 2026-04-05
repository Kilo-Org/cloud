'use client';

import { useCallback, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useAccessCode } from '../hooks/useAccessCode';

const ACCENT_CLASSES = {
  header:
    'animate-pulse-once bg-[oklch(95%_0.15_108)] text-black shadow-[0_0_20px_rgba(237,255,0,0.3)] ring-[oklch(95%_0.15_108)]/20 transition-all duration-500 ease-in-out hover:bg-[oklch(95%_0.15_108)]/90 hover:ring-[oklch(95%_0.15_108)]/40',
  hero: 'min-w-[180px] bg-emerald-600 text-white hover:bg-emerald-700',
} as const;

type OpenClawButtonProps = {
  canShow: boolean;
  gatewayUrl: string;
  /** "header" = yellow accent (default), "hero" = green prominent */
  look?: keyof typeof ACCENT_CLASSES;
  label?: string;
  className?: string;
};

export function OpenClawButton({
  canShow,
  gatewayUrl,
  look = 'header',
  label = 'Open',
  className,
}: OpenClawButtonProps) {
  const { isGenerating, generateAccessCode } = useAccessCode();
  const [isOpening, setIsOpening] = useState(false);

  // Open the window synchronously (in the click handler's call stack) to avoid
  // popup blockers, then navigate it once the access code arrives.
  const openWithAutoAuth = useCallback(async () => {
    setIsOpening(true);
    const win = window.open('about:blank', '_blank');
    try {
      const code = await generateAccessCode();
      if (code && win) {
        const url = new URL(gatewayUrl, window.location.origin);
        url.searchParams.set('auth_code', code);
        win.location.href = url.toString();
      } else {
        win?.close();
      }
    } catch {
      win?.close();
      toast.error('Failed to open KiloClaw — invalid gateway URL');
    } finally {
      setIsOpening(false);
    }
  }, [gatewayUrl, generateAccessCode]);

  if (!canShow) return null;

  return (
    <Button
      variant="primary"
      className={cn(ACCENT_CLASSES[look], className)}
      disabled={isOpening || isGenerating}
      onClick={openWithAutoAuth}
    >
      {isOpening ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      ) : (
        <ExternalLink className="mr-2 h-4 w-4" />
      )}
      {isOpening ? 'Opening...' : label}
    </Button>
  );
}
