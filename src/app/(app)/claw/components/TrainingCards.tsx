'use client';

import { Users, Zap } from 'lucide-react';
import { useFeatureFlagVariantKey } from 'posthog-js/react';

const GROUP_VARIANTS = {
  control: {
    headline: 'Learn to build your own AI assistant with OpenClaw.',
    body: 'Free weekly live session. We walk through real setups — email, calendar, messaging — so you can start building on your own.',
  },
  'social-proof': {
    headline: 'See how people are using OpenClaw to automate their work.',
    body: 'Free weekly live session. Watch real use cases — email triage, calendar management, messaging — and see what\u2019s possible.',
  },
} as const;

type GroupVariant = keyof typeof GROUP_VARIANTS;

function isGroupVariant(v: unknown): v is GroupVariant {
  return v === 'control' || v === 'social-proof';
}

export function TrainingCards() {
  const rawVariant = useFeatureFlagVariantKey('join-group-onboarding');
  const variant: GroupVariant = isGroupVariant(rawVariant) ? rawVariant : 'control';
  const group = GROUP_VARIANTS[variant];

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {/* Group training card (A/B tested) */}
      <div className="border-brand-primary/30 bg-brand-primary/5 flex flex-col justify-between gap-3 rounded-xl border p-4">
        <div className="flex items-start gap-3">
          <Users className="text-brand-primary mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="text-brand-primary text-sm font-semibold">{group.headline}</p>
            <p className="text-muted-foreground mt-0.5 text-sm">{group.body}</p>
          </div>
        </div>
        <a
          href="#group-training"
          target="_blank"
          rel="noopener noreferrer"
          className="bg-brand-primary text-primary-foreground hover:bg-brand-primary/90 inline-flex shrink-0 items-center justify-center self-start rounded-md px-4 py-2 text-sm font-medium transition-colors"
        >
          Register for next session
        </a>
      </div>

      {/* 1:1 training card (always shown) */}
      <div className="border-brand-primary/30 bg-brand-primary/5 flex flex-col justify-between gap-3 rounded-xl border p-4">
        <div className="flex items-start gap-3">
          <Zap className="text-brand-primary mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="text-brand-primary text-sm font-semibold">
              Go from inbox chaos to an AI executive assistant — in one hour.
            </p>
            <p className="text-muted-foreground mt-0.5 text-sm">
              A KiloClaw expert configures your email, calendar, and messaging live on a call.
              Personalized to your workflow. Includes <b>2 months free</b> hosting.
            </p>
          </div>
        </div>
        <a
          href="#book-session"
          target="_blank"
          rel="noopener noreferrer"
          className="bg-brand-primary text-primary-foreground hover:bg-brand-primary/90 inline-flex shrink-0 items-center justify-center self-start rounded-md px-4 py-2 text-sm font-medium transition-colors"
        >
          Book your session
        </a>
      </div>
    </div>
  );
}
