import { BookOpenCheck, Check, Star } from 'lucide-react';
import type { JSX } from 'react';
import type { KiloGatewayModelOption } from '@/src/shared/kilo-api-client';
import { modelRowDisplayId } from '@/src/shared/model-picker-rows';

const rowButtonClass =
  'flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left outline-none transition hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background';

const starButtonClass =
  'flex size-8 shrink-0 items-center justify-center rounded-md text-foreground-muted outline-none transition hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background disabled:cursor-not-allowed disabled:opacity-50';

const chipClass =
  'rounded-full border border-border bg-surface-overlay px-1.5 py-0.5 type-label text-foreground-muted';

export const ModelPickerModelRow = ({
  isFavorite,
  isSelected,
  model,
  onSelect,
  onToggleFavorite,
  showStar,
  starDisabled,
}: {
  readonly isFavorite: boolean;
  readonly isSelected: boolean;
  readonly model: KiloGatewayModelOption;
  readonly onSelect: (modelId: string) => void;
  readonly onToggleFavorite: (model: KiloGatewayModelOption) => void;
  readonly showStar: boolean;
  readonly starDisabled: boolean;
}): JSX.Element => {
  const showFree = model.isFree === true && model.hasUserByokAvailable !== true;
  const showByok = model.hasUserByokAvailable === true;
  const showDataCollected = model.mayTrainOnYourPrompts === true;

  return (
    <div className="flex items-start gap-1 px-1 py-0.5" data-model-row={model.id}>
      <button
        aria-current={isSelected ? 'true' : undefined}
        aria-label={model.name}
        className={
          isSelected ? `${rowButtonClass} bg-surface-selected text-foreground` : rowButtonClass
        }
        data-model-id={model.id}
        onClick={() => {
          onSelect(model.id);
        }}
        type="button"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{model.name}</span>
          <span className="mt-0.5 block truncate font-mono text-xs text-foreground-muted">
            {modelRowDisplayId(model.id)}
          </span>
          {showFree || showByok || showDataCollected ? (
            <span className="mt-1 flex flex-wrap items-center gap-1">
              {showFree ? <span className={chipClass}>Free</span> : null}
              {showByok ? <span className={chipClass}>BYOK</span> : null}
              {showDataCollected ? (
                <BookOpenCheck
                  aria-label="Data collected"
                  className="size-3.5 text-status-yellow-500"
                  role="img"
                />
              ) : null}
            </span>
          ) : null}
        </span>
        {isSelected ? (
          <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand-primary" />
        ) : null}
      </button>
      {showStar ? (
        <button
          aria-label={
            isFavorite ? `Remove ${model.name} from favorites` : `Add ${model.name} to favorites`
          }
          aria-pressed={isFavorite}
          className={starButtonClass}
          disabled={starDisabled}
          onClick={() => {
            onToggleFavorite(model);
          }}
          type="button"
        >
          <Star
            aria-hidden="true"
            className={
              isFavorite
                ? 'size-4 fill-brand-primary text-brand-primary'
                : 'size-4 text-foreground-muted'
            }
          />
        </button>
      ) : null}
    </div>
  );
};
