'use client';

import { useState, useEffect } from 'react';

type CopyableCommandProps = {
  command: string;
  className?: string;
};

export function CopyableCommand({ command, className = '' }: CopyableCommandProps) {
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
    <div
      className={`relative cursor-pointer ${className}`}
      onClick={handleCopy}
      title={copied ? 'Copied!' : 'Click to copy command'}
      role="button"
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          void handleCopy();
        }
      }}
    >
      <code className="block font-mono break-all">{command}</code>
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
