'use client';

import { useState } from 'react';
import type { ByokEndpointModel } from '@kilocode/db/schema-types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

function matchesSearch(model: ByokEndpointModel, search: string) {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return [model.id, model.internal_id, model.name ?? ''].some(value =>
    value.toLowerCase().includes(query)
  );
}

export function ByokEndpointImportDialog({
  models,
  listedInternalIds,
  onAdd,
  onClose,
}: {
  /** The models the endpoint lists. */
  models: ByokEndpointModel[];
  /** Upstream ids the endpoint already has; they cannot be added twice. */
  listedInternalIds: ReadonlySet<string>;
  onAdd: (models: ByokEndpointModel[]) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const visible = models.filter(model => matchesSearch(model, search));
  const selectable = visible.filter(model => !listedInternalIds.has(model.internal_id));
  const selectedVisible = selectable.filter(model => selected.has(model.internal_id)).length;
  const allVisibleSelected = selectable.length > 0 && selectedVisible === selectable.length;

  const toggle = (internalId: string, checked: boolean) => {
    setSelected(current => {
      const next = new Set(current);
      if (checked) next.add(internalId);
      else next.delete(internalId);
      return next;
    });
  };

  const toggleAllVisible = (checked: boolean) => {
    setSelected(current => {
      const next = new Set(current);
      for (const model of selectable) {
        if (checked) next.add(model.internal_id);
        else next.delete(model.internal_id);
      }
      return next;
    });
  };

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-3xl grid-rows-[auto_auto_minmax(0,1fr)_auto]">
        <DialogHeader>
          <DialogTitle>Import models</DialogTitle>
          <DialogDescription>
            The endpoint lists {models.length} model{models.length === 1 ? '' : 's'}. Select the
            ones to add, then check their limits before saving.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search models"
            aria-label="Search models"
            className="sm:flex-1"
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={allVisibleSelected ? true : selectedVisible > 0 ? 'indeterminate' : false}
              onCheckedChange={toggleAllVisible}
              disabled={selectable.length === 0}
            />
            Select all{search.trim() ? ' matching' : ''}
          </label>
        </div>
        <ul className="-mx-6 min-h-0 overflow-y-auto border-y px-6">
          {visible.length === 0 ? (
            <li className="text-muted-foreground py-6 text-center text-sm">No models match.</li>
          ) : (
            visible.map(model => {
              const listed = listedInternalIds.has(model.internal_id);
              return (
                <li key={model.internal_id} className="border-b last:border-0">
                  <label className="flex items-center gap-3 py-2 text-sm">
                    <Checkbox
                      checked={listed || selected.has(model.internal_id)}
                      disabled={listed}
                      onCheckedChange={checked => toggle(model.internal_id, checked)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{model.name ?? model.internal_id}</span>
                      <span className="text-muted-foreground block truncate font-mono text-xs">
                        {model.internal_id}
                      </span>
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {listed ? 'Added' : `${model.context_length.toLocaleString()} tokens`}
                    </span>
                  </label>
                </li>
              );
            })
          )}
        </ul>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={selected.size === 0}
            onClick={() => onAdd(models.filter(model => selected.has(model.internal_id)))}
          >
            Add {selected.size} model{selected.size === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
