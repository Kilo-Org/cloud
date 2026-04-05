import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

const AccessCodeResponse = z.object({
  code: z.string(),
  expiresIn: z.number(),
});

export function useAccessCode() {
  const [isGenerating, setIsGenerating] = useState(false);

  const generateAccessCode = useCallback(async (): Promise<string | null> => {
    setIsGenerating(true);
    try {
      const res = await fetch('/api/kiloclaw/access-code', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to generate access code');
      const data = AccessCodeResponse.parse(await res.json());
      return data.code;
    } catch (err) {
      const message =
        err instanceof z.ZodError
          ? 'Unexpected response from access code API'
          : 'Failed to generate access code';
      toast.error(message);
      return null;
    } finally {
      setIsGenerating(false);
    }
  }, []);

  return {
    isGenerating,
    generateAccessCode,
  };
}
