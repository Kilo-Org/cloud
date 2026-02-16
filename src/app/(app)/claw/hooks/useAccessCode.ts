import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

const AccessCodeResponse = z.object({
  code: z.string(),
  expiresIn: z.number(),
});

export function useAccessCode() {
  const [accessCode, setAccessCode] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  const generateAccessCode = useCallback(async () => {
    setIsGenerating(true);
    try {
      const res = await fetch('/api/kiloclaw/access-code', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to generate access code');
      const data = AccessCodeResponse.parse(await res.json());
      setAccessCode(data.code);
      setIsCopied(false);
    } catch (err) {
      const message =
        err instanceof z.ZodError
          ? 'Unexpected response from access code API'
          : 'Failed to generate access code';
      toast.error(message);
    } finally {
      setIsGenerating(false);
    }
  }, []);

  const copyAccessCode = useCallback(async () => {
    if (!accessCode) return;
    if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
      setIsCopied(false);
      toast.error('Clipboard is not available in this environment');
      return;
    }

    try {
      await navigator.clipboard.writeText(accessCode);
      setIsCopied(true);
      toast.success('Access code copied');
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      setIsCopied(false);
      toast.error('Failed to copy access code');
    }
  }, [accessCode]);

  return {
    accessCode,
    isGenerating,
    isCopied,
    generateAccessCode,
    copyAccessCode,
  };
}
