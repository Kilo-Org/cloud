'use client';

import { useState } from 'react';
import { Button } from '@/components/Button';
import { Input } from '../ui/input';
import { CheckCheck, Copy, Eye, EyeOff } from 'lucide-react';

export function CopyTokenButton({ kiloToken }: { kiloToken: string }) {
  const [copied, setCopied] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);

  const copyToClipboard = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    await navigator.clipboard.writeText(kiloToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 1000);
  };

  return (
    <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
      <Input
        id="api-key"
        type={showApiKey ? 'text' : 'password'}
        value={kiloToken}
        readOnly
        className="flex-1 font-mono text-sm"
      />
      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => setShowApiKey(!showApiKey)} className="shrink-0">
          {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
        <Button
          variant={copied ? 'green' : 'secondary'}
          type="button"
          onClick={copyToClipboard}
          title="Copy API Key to clipboard"
          className="shrink-0"
        >
          {copied ? <CheckCheck className="bg h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
