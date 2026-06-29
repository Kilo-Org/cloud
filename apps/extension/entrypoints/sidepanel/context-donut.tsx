import { useRef } from 'react';
import type { JSX } from 'react';
import { formatContextSummary, getContextRatio, getContextTone } from '@/src/shared/context-usage';

const toneStroke: Record<'danger' | 'safe' | 'warn', string> = {
  danger: '#f87171',
  safe: '#EDFF00',
  warn: '#fbbf24',
};

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export const ContextDonut = ({
  canCompact,
  contextLength,
  onCompact,
  promptTokens,
}: {
  canCompact: boolean;
  contextLength: number | undefined;
  onCompact: () => void;
  promptTokens: number;
}): JSX.Element => {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const ratio = getContextRatio(promptTokens, contextLength);
  const stroke = ratio === undefined ? '#52525b' : toneStroke[getContextTone(ratio)];
  const dash = ratio === undefined ? 0 : ratio * CIRCUMFERENCE;
  const summary = formatContextSummary(promptTokens, contextLength);
  const label = `Context usage: ${summary}`;

  return (
    <details className="relative shrink-0" ref={detailsRef}>
      <summary
        aria-label={label}
        className="flex size-8 cursor-pointer list-none items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 outline-none transition hover:border-zinc-700 focus-visible:ring-2 focus-visible:ring-[#EDFF00]/50"
        title={summary}
      >
        <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
          <circle cx="8" cy="8" fill="none" r={RADIUS} stroke="#27272a" strokeWidth="3" />
          <circle
            cx="8"
            cy="8"
            fill="none"
            r={RADIUS}
            stroke={stroke}
            strokeDasharray={`${dash} ${CIRCUMFERENCE}`}
            strokeLinecap="round"
            strokeWidth="3"
            transform="rotate(-90 8 8)"
          />
        </svg>
      </summary>
      <div className="absolute bottom-10 right-0 z-20 w-56 rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300 shadow-lg shadow-zinc-950/60">
        <p className="font-medium text-zinc-100">Context</p>
        <p className="mt-1 text-zinc-400">{summary}</p>
        <button
          className="mt-3 h-7 w-full rounded-md bg-[#EDFF00] px-2 text-xs font-semibold text-zinc-950 outline-none transition hover:bg-[#d9ea00] focus:ring-2 focus:ring-[#EDFF00]/50 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
          disabled={!canCompact}
          onClick={() => {
            detailsRef.current?.removeAttribute('open');
            onCompact();
          }}
          type="button"
        >
          Compact now
        </button>
      </div>
    </details>
  );
};
