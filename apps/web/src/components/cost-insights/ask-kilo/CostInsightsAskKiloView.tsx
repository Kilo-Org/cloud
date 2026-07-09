'use client';

import { useEffect, useRef } from 'react';
import { Eye, Lock, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCostInsightsTracking } from '../useCostInsightsTracking';

export function CostInsightsAskKiloView({
  initialQuestion,
  organizationId,
}: {
  initialQuestion?: string;
  organizationId?: string;
}) {
  const { trackUiInteraction } = useCostInsightsTracking(organizationId);
  const trackedAskKiloOwner = useRef<string | undefined>(undefined);
  const previewQuestion = initialQuestion?.trim() ?? '';

  useEffect(() => {
    const ownerKey = organizationId ?? 'personal';
    if (trackedAskKiloOwner.current === ownerKey) return;
    trackedAskKiloOwner.current = ownerKey;
    trackUiInteraction({ interaction: 'ask_kilo_viewed' });
  }, [organizationId, trackUiInteraction]);

  return (
    <section
      className="flex min-h-[calc(100vh-15rem)] items-center justify-center"
      aria-labelledby="ask-kilo-preview-title"
      aria-describedby="ask-kilo-preview-description"
    >
      <div className="border-border bg-card w-full max-w-2xl rounded-xl border p-6 sm:p-8">
        <div className="border-border bg-surface-overlay inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 type-label">
          <Eye className="size-icon-sm" aria-hidden="true" />
          Preview
        </div>
        <div className="mt-5 flex items-start gap-3">
          <span className="border-border bg-surface-inset flex size-10 shrink-0 items-center justify-center rounded-lg border">
            <Lock className="size-4 text-muted-foreground" aria-hidden="true" />
          </span>
          <div>
            <h1 id="ask-kilo-preview-title" className="type-heading">
              Ask Kilo is not available yet
            </h1>
            <p id="ask-kilo-preview-description" className="type-body text-muted-foreground mt-2">
              This preview does not query spend data. No question is submitted and no financial
              analysis is generated. When Ask Kilo becomes available, answers will use current Cost
              Insights data for this Spend owner.
            </p>
          </div>
        </div>

        <div className="mt-6">
          <Label htmlFor="ask-kilo-preview-question" className="type-label">
            Preview question
          </Label>
          <div className="relative mt-2">
            <Input
              id="ask-kilo-preview-question"
              disabled
              value={previewQuestion}
              placeholder="Ask Kilo about your spending"
              className="bg-input-background h-12! rounded-xl pr-14"
            />
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
          <p className="type-label text-muted-foreground mt-2">
            Input is disabled in this preview.
          </p>
        </div>
      </div>
    </section>
  );
}
