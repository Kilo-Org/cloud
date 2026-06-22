import React from 'react';
import { KiloMark } from '@/src/shared/kilo-mark';

export const App = (): React.JSX.Element => (
  <main className="flex min-h-dvh flex-col bg-zinc-950 text-zinc-50">
    <div className="border-b border-zinc-800 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[#EDFF00] text-zinc-950">
          <KiloMark className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-zinc-50">Kilo</p>
          <p className="truncate text-xs text-zinc-400">Native side panel</p>
        </div>
      </div>
    </div>

    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-zinc-100">Current tab</p>
          <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-xs font-medium text-zinc-300">
            Connected
          </span>
        </div>
      </div>

      <div className="flex flex-1 flex-col px-4 py-5">
        <div className="rounded-md border border-dashed border-zinc-800 bg-zinc-900/40 p-4">
          <p className="text-sm font-medium text-zinc-100">No actions yet</p>
          <p className="mt-1 text-sm leading-5 text-zinc-400">
            Tools for this tab will appear here.
          </p>
        </div>
      </div>
    </div>
  </main>
);
