import { ChevronsUpDown, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { StoredAuth } from '@/src/shared/auth';
import type { KiloGatewayModelOption } from '@/src/shared/kilo-api-client';
import { buildExtensionModelPickerRows } from '@/src/shared/model-picker-rows';
import { ModelPickerModelRow } from './model-picker-row';
import { useModelPreferences } from './use-model-preferences';

const triggerClassName =
  'flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border-strong bg-input-bg px-2 type-label text-foreground outline-none transition focus-visible:ring-2 focus-visible:ring-brand-primary-ring ring-offset-2 ring-offset-surface-background disabled:cursor-not-allowed disabled:text-foreground-subtle';

const secondaryButtonClassName =
  'h-8 shrink-0 rounded-md border border-border bg-surface-overlay px-2 type-label text-foreground-on-secondary outline-none transition hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand-primary-ring ring-offset-2 ring-offset-surface-background';

export const ModelPicker = ({
  auth,
  disabled,
  model,
  modelOptions,
  onModelChange,
  organizationId,
}: {
  readonly auth: StoredAuth;
  readonly disabled: boolean;
  readonly model: string;
  readonly modelOptions: readonly KiloGatewayModelOption[];
  readonly onModelChange: (modelId: string) => void;
  readonly organizationId: string | undefined;
}): JSX.Element => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const selectedRowRef = useRef<HTMLDivElement | null>(null);
  const { favorites, refetch, status, toggleError, toggleFavorite } = useModelPreferences({
    auth,
    organizationId,
  });

  const selectedOption = modelOptions.find(option => option.id === model);
  const triggerLabel =
    modelOptions.length === 0 ? 'Loading models...' : (selectedOption?.name ?? model);

  const rows = useMemo(
    () =>
      buildExtensionModelPickerRows({
        favoriteIds: favorites,
        models: modelOptions,
        search,
      }),
    [favorites, modelOptions, search]
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    searchInputRef.current?.focus();
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [isOpen]);

  const closeOverlay = (): void => {
    setIsOpen(false);
    setSearch('');
  };

  const handleSelect = (modelId: string): void => {
    onModelChange(modelId);
    closeOverlay();
  };

  return (
    <div className="relative min-w-0 flex-1">
      <button
        aria-label="Model"
        className={triggerClassName}
        data-model-id={modelOptions.length === 0 || model === '' ? undefined : model}
        disabled={disabled}
        onClick={() => {
          if (disabled) {
            return;
          }

          setSearch('');
          setIsOpen(true);
        }}
        type="button"
      >
        <span className="min-w-0 flex-1 truncate text-left">{triggerLabel}</span>
        <ChevronsUpDown aria-hidden="true" className="size-3.5 shrink-0 text-foreground-muted" />
      </button>

      {isOpen ? (
        <div
          aria-label="Select model"
          aria-modal="true"
          className="agent-conversation-scrollbar fixed inset-0 z-30 flex flex-col overflow-y-auto bg-surface-background"
          role="dialog"
        >
          <div className="sticky top-0 z-10 flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface-raised px-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">Select model</p>
              <p className="type-label text-foreground-muted">Search and favorites</p>
            </div>
            <button
              aria-label="Close model picker"
              className="flex size-8 items-center justify-center rounded-md border border-border bg-surface-overlay text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background"
              onClick={closeOverlay}
              type="button"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>

          <div className="border-b border-border px-3 py-3">
            <input
              aria-label="Search models"
              className="h-9 w-full rounded-md border border-border-strong bg-input-bg px-3 type-label text-foreground outline-none transition placeholder:text-foreground-subtle focus-visible:ring-2 focus-visible:ring-brand-primary-ring ring-offset-2 ring-offset-surface-background"
              onChange={event => {
                setSearch(event.currentTarget.value);
              }}
              placeholder="Search models..."
              ref={searchInputRef}
              type="search"
              value={search}
            />
          </div>

          {status === 'retryable' ? (
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
              <p className="type-label text-status-red-400">Couldn&apos;t load favorites.</p>
              <button
                className={secondaryButtonClassName}
                onClick={() => {
                  void refetch();
                }}
                type="button"
              >
                Retry
              </button>
            </div>
          ) : null}

          {status === 'terminal' ? (
            <p className="border-b border-border px-4 py-2 type-label text-foreground-muted">
              Favorites aren&apos;t available here.
            </p>
          ) : null}

          {toggleError ? (
            <p className="border-b border-border px-4 py-2 type-label text-status-red-400">
              Couldn&apos;t update favorites.
            </p>
          ) : null}

          <div className="px-2 py-2">
            {rows.length === 0 && search.trim().length > 0 ? (
              <div className="grid gap-3 px-2 py-8 text-center">
                <p className="type-body text-foreground-muted">
                  No models match &quot;{search}&quot;.
                </p>
                <button
                  className={`${secondaryButtonClassName} mx-auto`}
                  onClick={() => {
                    setSearch('');
                  }}
                  type="button"
                >
                  Clear search
                </button>
              </div>
            ) : (
              // Ponytail: no list virtualization — gateway catalog is a few hundred models.
              <>
                {rows.map(row => {
                  if (row.type === 'header') {
                    return (
                      <p
                        className="type-eyebrow px-3 pb-1 pt-3 text-foreground-muted"
                        key={row.key}
                      >
                        {row.title}
                      </p>
                    );
                  }

                  const isSelected = row.model.id === model;

                  return (
                    <div key={row.key} ref={isSelected ? selectedRowRef : undefined}>
                      <ModelPickerModelRow
                        isFavorite={row.isFavorite}
                        isSelected={isSelected}
                        model={row.model}
                        onSelect={handleSelect}
                        onToggleFavorite={toggleFavorite}
                        showStar={status !== 'terminal'}
                        starDisabled={status === 'loading'}
                      />
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
};
