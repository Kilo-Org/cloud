'use client';

import LogosSection from '@/components/LogosSection';
import { Check } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import { Dithering } from '@paper-design/shaders-react';

type Bullet = {
  lead: string;
  detail?: string;
};

const bullets: Bullet[] = [
  {
    lead: 'The most popular open source coding agent.',
    detail: 'Build, ship, and iterate faster.',
  },
  {
    lead: 'Everywhere you code.',
    detail: 'VS Code, JetBrains, CLI, Cloud, and App Builder.',
  },
  {
    lead: '500+ AI models.',
    detail: 'Claude Opus 4.8, GPT-5.5, Gemini 3.5, and hundreds more.',
  },
  {
    lead: 'Fully open source.',
    detail: 'Transparent pricing. No vendor lock-in.',
  },
];

export function AuthMarketingAside() {
  const reduceMotion = useReducedMotion();

  return (
    <aside className="relative isolate hidden min-h-screen w-2/5 shrink-0 flex-col items-center justify-center overflow-hidden px-16 xl:flex">
      {/* Dithered shader background — the one visual effect on this column */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <Dithering
          width="100%"
          height="100%"
          colorBack="#0a0a0a"
          colorFront="#3d3d3d"
          shape="warp"
          type="4x4"
          size={2.5}
          speed={reduceMotion === true ? 0 : 0.12}
        />
      </div>

      <div className="relative w-full max-w-md">
        <div
          style={{ backgroundColor: 'rgba(10, 10, 10, 0.82)' }}
          className="border-border/60 flex flex-col rounded-xl border p-8 shadow-lg backdrop-blur-md"
        >
          {/* Hero claim */}
          <h2 className="flex flex-col text-center text-balance">
            <span className="text-foreground text-3xl leading-[1.1] font-bold tracking-[-0.02em]">
              One coding agent.
            </span>
            <span className="text-foreground text-3xl leading-[1.1] font-bold tracking-[-0.02em]">
              Every model.
            </span>
            <span className="text-brand-primary text-3xl leading-[1.1] font-bold tracking-[-0.02em]">
              No subscription.
            </span>
          </h2>

          {/* Bullets */}
          <ul className="mt-8 flex flex-col gap-4">
            {bullets.map(bullet => (
              <li key={bullet.lead} className="flex items-start gap-3">
                <Check
                  className="text-brand-primary mt-1 size-4 shrink-0"
                  strokeWidth={2.5}
                  aria-hidden
                />
                <div className="flex flex-col gap-0.5">
                  <span className="text-foreground text-sm leading-snug font-semibold">
                    {bullet.lead}
                  </span>
                  {bullet.detail && (
                    <span className="text-muted-foreground text-[13px] leading-snug">
                      {bullet.detail}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {/* Logos */}
          <div className="border-border/60 mt-8 flex flex-col items-center gap-4 border-t pt-6">
            <span className="text-muted-foreground/60 font-jetbrains text-center text-[10px] font-medium tracking-[0.22em] uppercase">
              Trusted by teams at
            </span>
            <LogosSection className="!pb-0" />
          </div>
        </div>
      </div>
    </aside>
  );
}
