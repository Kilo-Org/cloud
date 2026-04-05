'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Terminal } from 'lucide-react';

export function OpenInCliButton({ command }: { command: string }) {
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
    <div className="relative">
      <Button onClick={handleCopy} variant="outline" className="gap-2">
        <Terminal className="h-4 w-4" />
        Open in CLI
      </Button>
      {copied && (
        <div
          className="animate-in fade-in slide-in-from-bottom-2 absolute -top-10 right-0 rounded-md bg-green-600 px-3 py-1 text-sm font-medium text-white shadow-lg duration-200"
          role="status"
          aria-live="polite"
        >
          Copied!
        </div>
      )}
    </div>
  );
}
