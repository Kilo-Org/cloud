'use client';

import { useState, useEffect } from 'react';
import { Copy, Check } from 'lucide-react';

type CopyTextButtonProps = {
  text: string;
  className?: string;
  showText?: boolean;
};

export function CopyTextButton({ text, className = '', showText = false }: CopyTextButtonProps) {
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
      console.error('Failed to copy:', error);
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

  return (
    <button
      onClick={handleCopy}
      className={`inline-flex items-center gap-1 rounded p-1 transition-all duration-200 hover:bg-gray-100 focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 focus:outline-none ${className}`}
      title={copied ? 'Copied!' : `Copy '${text}' to clipboard`}
    >
      <div className={`transition-all duration-200 ${copied ? 'scale-110' : 'scale-100'}`}>
        {copied ? (
          <Check className="h-4 w-4 text-green-600" />
        ) : (
          <Copy className="h-4 w-4 text-gray-500 hover:text-gray-700" />
        )}
      </div>
      {showText && (
        <span className="text-muted-foreground text-sm">{copied ? 'Copied!' : 'Copy'}</span>
      )}
    </button>
  );
}
