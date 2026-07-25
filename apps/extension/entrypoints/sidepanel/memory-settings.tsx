import { storage } from '#imports';
import { Trash2 } from 'lucide-react';
import type { JSX } from 'react';
import { deleteAgentMemory } from '@/src/shared/agent-memories-storage';
import { deriveMemoriesSettingsView } from './memory-settings-state';
import { useAgentMemories } from './use-agent-memories';

const EMPTY_MESSAGE =
  'No memories yet. Highlight text on any page, right-click, and choose Add to memory.';
const LOAD_ERROR_MESSAGE = "Couldn't load memories. Try again.";

const secondaryButtonClass =
  'h-8 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950';

export const MemorySettings = (): JSX.Element => {
  const { isLoaded, loadError, memories, reload } = useAgentMemories();
  const view = deriveMemoriesSettingsView({ isLoaded, loadError, memories });

  return (
    <section
      aria-label="Memories"
      className="min-w-0 rounded-md border border-zinc-800 bg-zinc-900/40 p-3"
    >
      <h2 className="text-xs font-medium text-zinc-500">Memories</h2>

      {view.kind === 'loading' ? <p className="mt-2 text-sm text-zinc-400">Loading…</p> : null}

      {view.kind === 'loadError' ? (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-sm text-zinc-300">{LOAD_ERROR_MESSAGE}</p>
          <div className="flex justify-end">
            <button className={secondaryButtonClass} onClick={reload} type="button">
              Retry
            </button>
          </div>
        </div>
      ) : null}

      {view.kind === 'empty' ? <p className="mt-2 text-sm text-zinc-400">{EMPTY_MESSAGE}</p> : null}

      {view.kind === 'list' ? (
        <ul className="mt-2 flex flex-col gap-2">
          {view.items.map(item => (
            <li
              className="flex min-w-0 items-start gap-2 rounded-md border border-zinc-800/80 bg-zinc-950/40 p-2"
              key={item.id}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-zinc-100" title={item.preview}>
                  {item.preview}
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {item.domain === undefined
                    ? item.dateLabel
                    : `${item.domain} · ${item.dateLabel}`}
                </p>
              </div>
              <button
                aria-label={item.deleteAriaLabel}
                className="flex size-7 shrink-0 items-center justify-center rounded-md border border-zinc-800 text-zinc-400 transition hover:border-red-500/70 hover:bg-red-950/30 hover:text-red-300 focus:outline-none focus:ring-2 focus:ring-red-400/50"
                onClick={() => {
                  void deleteAgentMemory(storage, item.id);
                }}
                type="button"
              >
                <Trash2 aria-hidden="true" className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
};
