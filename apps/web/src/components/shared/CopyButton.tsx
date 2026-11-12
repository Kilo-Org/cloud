'use client';

import { useState, useEffect } from 'react';
import { Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

type CopyButtonProps = {
  text: string;
  className?: string;
  showText?: boolean;
  label?: string;
};

export function CopyButton({ text, className = '', showText = false, label }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (error) {
      console.error('Failed to copy text:', error);
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        setCopied(true);
      } catch (fallbackError) {
        console.error('Fallback copy failed:', fallbackError);
      }
      document.body.removeChild(textArea);
    }
  };

  const defaultLabel = label || 'text';
  const title = copied ? `${defaultLabel} copied!` : `Copy ${defaultLabel} to clipboard`;

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring focus-visible:ring-offset-background pointer-events-auto inline-flex cursor-pointer items-center gap-1 rounded p-1 transition-all duration-200 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
        className
      )}
      title={title}
      aria-label={title}
    >
      <div className={`transition-all duration-200 ${copied ? 'scale-110' : 'scale-100'}`}>
        {copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
      </div>
      {showText && (
        <span className="text-muted-foreground text-sm">{copied ? 'Copied!' : 'Copy'}</span>
      )}
    </button>
  );
}
