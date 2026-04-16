'use client';

import { useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { kilologHash } from '@/lib/ai-gateway/kilologHash';

export function SafetyIdentifierHashGenerator() {
  const [id, setId] = useState('');
  const [hash, setHash] = useState('');
  // Tracks the latest invocation so stale async results from earlier keystrokes are discarded.
  const generation = useRef(0);

  async function handleChange(value: string) {
    setId(value);
    const gen = ++generation.current;
    if (value.trim()) {
      const computed = await kilologHash(value.trim());
      if (gen === generation.current) {
        setHash(computed);
      }
    } else {
      setHash('');
    }
  }

  return (
    <div className="bg-background rounded-lg border p-6 space-y-4">
      <p className="text-muted-foreground text-sm">
        Generates the hashed ID used in the <code>users</code> and <code>organizations</code>{' '}
        allowlists in <code>handleRequestLogging.ts</code>. Paste a user or organization ID to get
        the hash that can be added to those lists to enable request logging for that entity.
      </p>
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
