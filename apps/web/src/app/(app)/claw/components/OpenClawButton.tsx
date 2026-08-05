'use client';

import { useCallback, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useAccessCode } from '../hooks/useAccessCode';

type OpenClawButtonProps = {
  canShow: boolean;
  gatewayUrl: string;
  label?: string;
  className?: string;
};

export function OpenClawButton({
  canShow,
  gatewayUrl,
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
      className={className}
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
