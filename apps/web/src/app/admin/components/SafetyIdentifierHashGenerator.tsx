'use client';

import { useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

async function computeKilologHash(id: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode('kilolog|' + id);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function SafetyIdentifierHashGenerator() {
  const [id, setId] = useState('');
  const [hash, setHash] = useState('');
  // Tracks the latest invocation so stale async results from earlier keystrokes are discarded.
  const generation = useRef(0);

  async function handleChange(value: string) {
    setId(value);
    const gen = ++generation.current;
    if (value.trim()) {
      const computed = await computeKilologHash(value.trim());
      if (gen === generation.current) {
        setHash(computed);
      }
    } else {
      setHash('');
    }
  }

  return (
    <div className="bg-background rounded-lg border p-6 space-y-4">
      <div className="space-y-2">
        <Label htmlFor="hash-id-input">ID (user ID or organization ID)</Label>
        <Input
          id="hash-id-input"
          value={id}
          onChange={e => void handleChange(e.target.value)}
          placeholder="Paste a user or organization ID here"
          className="font-mono"
        />
      </div>
      {hash && (
        <div className="space-y-1">
          <Label>Hash (for handleRequestLogging.ts)</Label>
          <p className="font-mono text-sm break-all select-all rounded bg-muted px-3 py-2">
            {hash}
          </p>
        </div>
      )}
    </div>
  );
}
