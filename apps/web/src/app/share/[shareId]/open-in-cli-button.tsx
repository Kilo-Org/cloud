'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import type { ButtonVariantProps } from '@/components/ui/button-variants';
import { Terminal } from 'lucide-react';

export function OpenInCliButton({
  command,
  variant = 'outline',
}: {
  command: string;
  variant?: ButtonVariantProps['variant'];
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch (error) {
      console.error('Failed to copy command:', error);
    }
  };

  return (
    <Button onClick={handleCopy} variant={variant} className="gap-2" aria-live="polite">
      <Terminal className="h-4 w-4" />
      {copied ? 'Copied!' : 'Open in CLI'}
    </Button>
  );
}
