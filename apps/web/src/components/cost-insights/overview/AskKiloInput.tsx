'use client';

import { Eye, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CostInsightsOwner } from '../types';

export function AskKiloInput({ owner }: { owner: CostInsightsOwner }) {
  const helpId = 'ask-kilo-question-help';

  return (
    <section
      className="border-border bg-card rounded-xl border p-4"
      aria-labelledby="ask-kilo-preview-title"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="border-border bg-surface-overlay inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 type-label">
          <Eye className="size-icon-sm" aria-hidden="true" />
          Preview
        </span>
        <p id="ask-kilo-preview-title" className="type-label text-muted-foreground">
          Ask Kilo is not available yet. No question is submitted and no analysis is generated.
        </p>
      </div>
      <div className="relative">
        <Label htmlFor="ask-kilo-question" className="sr-only">
          Ask Kilo about spending for {owner.name}
        </Label>
        <Input
          id="ask-kilo-question"
          disabled
          aria-describedby={helpId}
          placeholder="Ask Kilo about your spending"
          className="bg-input-background h-12! rounded-xl pr-14"
        />
        <span id={helpId} className="sr-only">
          Disabled preview. Ask Kilo cannot analyze spend data in this version.
        </span>
        <Button
          type="button"
          size="icon"
          disabled
          aria-label="Ask Kilo unavailable"
          className="absolute top-1.5 right-1.5"
        >
          <Send className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}
