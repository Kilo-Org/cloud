'use client';

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { GatewayModelListConfigSchema } from '@kilocode/db/schema-types';
import { formatZodError } from '@/lib/zod/format-zod-error';
import type { GatewayModelList } from '@/routers/admin/gateway-model-lists-router';

type GatewayModelListContentProps = {
  list: GatewayModelList;
  title: string;
  description: ReactNode;
  ordered: boolean;
};

function moveItem(items: readonly string[], from: number, to: number): string[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((model, index) => model === b[index]);
}

export function GatewayModelListContent({
  list,
  title,
  description,
  ordered,
}: GatewayModelListContentProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery(trpc.admin.gatewayModelLists.get.queryOptions({ list }));
  const catalogQuery = useQuery(trpc.models.list.queryOptions());

  const savedModels = useMemo(() => data?.config?.models ?? [], [data]);
  const [models, setModels] = useState<string[]>([]);
  const [customModelId, setCustomModelId] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setModels(savedModels);
    setValidationError(null);
  }, [savedModels]);

  const catalogNames = useMemo(
    () => new Map((catalogQuery.data ?? []).map(model => [model.id, model.name])),
    [catalogQuery.data]
  );

  const addableModels = useMemo<ModelOption[]>(() => {
    const selected = new Set(models);
    return (catalogQuery.data ?? [])
      .filter(model => !selected.has(model.id))
      .map(model => ({ id: model.id, name: model.name }));
  }, [catalogQuery.data, models]);

  const mutation = useMutation(
    trpc.admin.gatewayModelLists.set.mutationOptions({
      onSuccess: result => {
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.gatewayModelLists.get.queryKey({ list }),
        });
        toast.success(result.config ? `${title} saved` : `${title} cleared`);
      },
      onError: error => {
        toast.error(formatZodError(error));
      },
    })
  );

  function updateModels(next: string[]) {
    setModels(next);
    setValidationError(null);
  }

  function addModel(model: string) {
    if (models.includes(model)) {
      setValidationError(`${model} is already in the list`);
      return;
    }
    updateModels([...models, model]);
  }

  function handleAddCustomModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const model = customModelId.trim();
    if (!model) return;
    addModel(model);
    setCustomModelId('');
  }

  function handleSave() {
    const parsed = GatewayModelListConfigSchema.safeParse({ models });
    if (!parsed.success) {
      setValidationError(formatZodError(parsed.error));
      return;
    }
    mutation.mutate({ list, config: parsed.data });
  }

  if (isLoading) {
    return <div className="text-muted-foreground py-8 text-sm">Loading...</div>;
  }

  const hasStoredConfig = Boolean(data?.config);
  const hasChanges = !sameOrder(models, savedModels);
  const customInputId = `${list}-custom-model`;

  return (
    <div className="flex w-full flex-col gap-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">
            {hasStoredConfig
              ? 'Showing the stored list. Changes take effect within one minute on warm instances.'
              : 'No list stored. The gateway treats this as an empty list.'}
          </p>

          <Table>
            <TableHeader>
              <TableRow>
                {ordered && <TableHead className="w-12">#</TableHead>}
                <TableHead>Model</TableHead>
                <TableHead className="w-32 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={ordered ? 3 : 2}
                    className="text-muted-foreground text-center text-sm"
                  >
                    No models. Add one below.
                  </TableCell>
                </TableRow>
              )}
              {models.map((model, index) => {
                const name = catalogNames.get(model);
                return (
                  <TableRow key={model}>
                    {ordered && (
                      <TableCell className="text-muted-foreground font-mono tabular-nums">
                        {index + 1}
                      </TableCell>
                    )}
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm">{model}</span>
                        {name && <span className="text-muted-foreground text-sm">{name}</span>}
                        {!name && catalogQuery.isSuccess && (
                          <Badge variant="secondary">Not in catalog</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {ordered && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Move ${model} up`}
                              disabled={index === 0}
                              onClick={() => updateModels(moveItem(models, index, index - 1))}
                            >
                              <ArrowUp className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Move ${model} down`}
                              disabled={index === models.length - 1}
                              onClick={() => updateModels(moveItem(models, index, index + 1))}
                            >
                              <ArrowDown className="size-4" />
                            </Button>
                          </>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${model}`}
                          onClick={() => updateModels(models.filter(m => m !== model))}
                        >
                          <X className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          <div className="grid max-w-3xl gap-4 md:grid-cols-2">
            <ModelCombobox
              id={`${list}-add-model`}
              label="Add from catalog"
              placeholder="Select a model to add"
              models={addableModels}
              isLoading={catalogQuery.isLoading}
              error={catalogQuery.error?.message}
              onValueChange={addModel}
            />
            <form className="space-y-2" onSubmit={handleAddCustomModel}>
              <Label htmlFor={customInputId}>Add by ID</Label>
              <div className="flex gap-2">
                <Input
                  id={customInputId}
                  className="font-mono"
                  placeholder="provider/model-id"
                  value={customModelId}
                  onChange={event => setCustomModelId(event.target.value)}
                />
                <Button type="submit" variant="outline" disabled={!customModelId.trim()}>
                  <Plus className="size-4" />
                  Add
                </Button>
              </div>
            </form>
          </div>

          {validationError && (
            <pre
              className="bg-destructive/10 text-destructive rounded-md p-3 text-sm whitespace-pre-wrap"
              role="alert"
            >
              {validationError}
            </pre>
          )}

          <div className="flex items-center gap-3">
            <Button
              onClick={handleSave}
              disabled={mutation.isPending || (!hasChanges && hasStoredConfig)}
              size="sm"
            >
              {mutation.isPending ? 'Saving...' : 'Save'}
            </Button>
            {hasChanges && (
              <Button
                onClick={() => updateModels(savedModels)}
                disabled={mutation.isPending}
                variant="outline"
                size="sm"
              >
                Discard changes
              </Button>
            )}
            {hasStoredConfig && (
              <Button
                onClick={() => mutation.mutate({ list, config: null })}
                disabled={mutation.isPending}
                variant="outline"
                size="sm"
              >
                Clear stored list
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
