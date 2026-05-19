'use client';

import { useCallback, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import {
  useModelExperiments,
  useModelExperiment,
  useCreateExperiment,
  useDeleteExperiment,
  useActivateExperiment,
  usePauseExperiment,
  useCompleteExperiment,
  useSetExperimentArchived,
  useAddVariant,
  useRemoveVariant,
  useSwapVariantVersion,
  useRotateApiKey,
} from '@/app/admin/api/model-experiments/hooks';
import {
  ExperimentUpstreamSchema,
  type ExperimentUpstream,
} from '@/lib/ai-gateway/experiments/upstream-schema';
import { toast } from 'sonner';
import { Plus, ChevronLeft, KeyRound, RefreshCw } from 'lucide-react';
import Editor from '@monaco-editor/react';

const INITIAL_UPSTREAM: ExperimentUpstream = {
  internal_id: '',
  base_url: '',
};

type Status = 'draft' | 'active' | 'paused' | 'completed';

const STATUS_VARIANT: Record<Status, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  draft: 'outline',
  active: 'default',
  paused: 'secondary',
  completed: 'outline',
};

function StatusBadge({ status }: { status: Status }) {
  return <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>;
}

function getActivationDisabledReason(variants: readonly Variant[]) {
  if (variants.length < 1) {
    return 'Active experiments must have at least 1 variant';
  }
  if (variants.some(v => v.weight <= 0)) {
    return 'Every variant must have a positive weight';
  }
  const now = new Date();
  if (variants.some(v => !v.current_version || new Date(v.current_version.effective_at) > now)) {
    return 'Every variant must have at least one variant_version with effective_at <= now()';
  }
  return null;
}

function ActivationButton({
  label,
  disabledReason,
  isPending,
  onActivate,
}: {
  label: string;
  disabledReason: string | null;
  isPending: boolean;
  onActivate: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" tabIndex={disabledReason ? 0 : undefined}>
          <Button onClick={onActivate} disabled={isPending || disabledReason !== null}>
            {label}
          </Button>
        </span>
      </TooltipTrigger>
      {disabledReason && (
        <TooltipContent side="bottom" className="max-w-xs">
          {disabledReason}
        </TooltipContent>
      )}
    </Tooltip>
  );
}

export function ModelExperimentsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const selectedId = searchParams.get('experimentId');

  const updateSelectedId = useCallback(
    (id: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', 'model-experiments');
      if (id === null) {
        params.delete('experimentId');
      } else {
        params.set('experimentId', id);
      }
      const qs = params.toString();
      router.push(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  return selectedId ? (
    <ExperimentDetail id={selectedId} onBack={() => updateSelectedId(null)} />
  ) : (
    <ExperimentList onSelect={id => updateSelectedId(id)} />
  );
}

// -------------------------------------------------------------------------
// List view
// -------------------------------------------------------------------------

function ExperimentList({ onSelect }: { onSelect: (id: string) => void }) {
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data, isLoading } = useModelExperiments(includeArchived);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex w-full flex-col gap-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Model Experiments</h2>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setIncludeArchived(v => !v)}>
            {includeArchived ? 'Hide archived' : 'Show archived'}
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New experiment
          </Button>
        </div>
      </div>

      <p className="text-muted-foreground text-sm">
        A/B test preview-model checkpoints. Each experiment targets one <code>
          public_model_id
        </code>{' '}
        and swaps the upstream checkpoint behind it. Clients keep sending the same public model id.
        See <code>.plans/experimental-models-1.md</code> for the full design.
      </p>

      {isLoading ? (
        <div className="text-muted-foreground text-sm">Loading…</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Public model id</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.items.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground text-center">
                  No experiments yet.
                </TableCell>
              </TableRow>
            )}
            {data?.items.map(item => (
              <TableRow
                key={item.id}
                tabIndex={0}
                role="button"
                aria-label={`Open experiment ${item.name}`}
                onClick={() => onSelect(item.id)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(item.id);
                  }
                }}
                className="hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-ring cursor-pointer focus-visible:outline-2"
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    {item.name}
                    {item.is_archived && (
                      <Badge variant="outline" className="text-muted-foreground">
                        archived
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-sm">{item.public_model_id}</TableCell>
                <TableCell>
                  <StatusBadge status={item.status as Status} />
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {new Date(item.created_at).toLocaleDateString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <CreateExperimentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={id => {
          setCreateOpen(false);
          onSelect(id);
        }}
      />
    </div>
  );
}

function CreateExperimentDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [publicModelId, setPublicModelId] = useState('');
  const [description, setDescription] = useState('');
  const create = useCreateExperiment();

  const reset = useCallback(() => {
    setName('');
    setPublicModelId('');
    setDescription('');
  }, []);

  const handleSave = useCallback(async () => {
    if (!name.trim() || !publicModelId.trim()) return;
    try {
      const created = await create.mutateAsync({
        name: name.trim(),
        public_model_id: publicModelId.trim(),
        description: description.trim() || undefined,
      });
      toast.success('Experiment created');
      reset();
      onCreated(created.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create');
    }
  }, [create, name, publicModelId, description, reset, onCreated]);

  return (
    <Dialog
      open={open}
      onOpenChange={v => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New experiment</DialogTitle>
          <DialogDescription>
            Creates a draft experiment. Add a variant and at least one variant version before
            activating.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div>
            <Label htmlFor="exp-name">Name</Label>
            <Input
              id="exp-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Preview Foo April 2026"
            />
          </div>
          <div>
            <Label htmlFor="exp-public-id">Public model id</Label>
            <Input
              id="exp-public-id"
              value={publicModelId}
              onChange={e => setPublicModelId(e.target.value)}
              placeholder="e.g. kilo/preview-experiment-foo"
              className="font-mono"
            />
          </div>
          <div>
            <Label htmlFor="exp-description">Description (optional)</Label>
            <Textarea
              id="exp-description"
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={create.isPending || !name.trim() || !publicModelId.trim()}
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// -------------------------------------------------------------------------
// Detail view
// -------------------------------------------------------------------------

function ExperimentDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { data, isLoading } = useModelExperiment(id);
  const activate = useActivateExperiment();
  const pause = usePauseExperiment();
  const complete = useCompleteExperiment();
  const setArchived = useSetExperimentArchived();
  const remove = useDeleteExperiment();

  if (isLoading || !data) {
    return (
      <div className="flex flex-col gap-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="w-fit">
          <ChevronLeft className="mr-1 h-4 w-4" /> Back
        </Button>
        <div className="text-muted-foreground text-sm">Loading…</div>
      </div>
    );
  }

  const { experiment, variants } = data;
  const status = experiment.status as Status;
  const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
  const activationDisabledReason = getActivationDisabledReason(variants);

  const handleAction = async <T,>(label: string, p: Promise<T>) => {
    try {
      await p;
      toast.success(label);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed: ${label}`);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Button variant="ghost" size="sm" onClick={onBack} className="w-fit -ml-2">
            <ChevronLeft className="mr-1 h-4 w-4" /> Back
          </Button>
          <h2 className="text-2xl font-bold">{experiment.name}</h2>
          <div className="flex items-center gap-2">
            <StatusBadge status={status} />
            {experiment.is_archived && <Badge variant="outline">archived</Badge>}
            <code className="text-muted-foreground text-sm">{experiment.public_model_id}</code>
          </div>
          {experiment.description && (
            <p className="text-muted-foreground mt-2 text-sm">{experiment.description}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {status === 'draft' && (
            <ActivationButton
              label="Activate"
              disabledReason={activationDisabledReason}
              isPending={activate.isPending}
              onActivate={() =>
                handleAction('Activated', activate.mutateAsync({ id: experiment.id }))
              }
            />
          )}
          {status === 'active' && (
            <Button
              variant="outline"
              onClick={() => handleAction('Paused', pause.mutateAsync({ id: experiment.id }))}
              disabled={pause.isPending}
            >
              Pause
            </Button>
          )}
          {status === 'paused' && (
            <ActivationButton
              label="Resume"
              disabledReason={activationDisabledReason}
              isPending={activate.isPending}
              onActivate={() =>
                handleAction('Activated', activate.mutateAsync({ id: experiment.id }))
              }
            />
          )}
          {(status === 'active' || status === 'paused') && (
            <Button
              variant="outline"
              onClick={() => handleAction('Completed', complete.mutateAsync({ id: experiment.id }))}
              disabled={complete.isPending}
            >
              Complete
            </Button>
          )}
          {status !== 'active' && (
            <Button
              variant="outline"
              onClick={() =>
                handleAction(
                  experiment.is_archived ? 'Unarchived' : 'Archived',
                  setArchived.mutateAsync({
                    id: experiment.id,
                    archived: !experiment.is_archived,
                  })
                )
              }
              disabled={setArchived.isPending}
            >
              {experiment.is_archived ? 'Unarchive' : 'Archive'}
            </Button>
          )}
          {status === 'draft' && (
            <InlineDeleteConfirmation
              onDelete={async () => {
                try {
                  await remove.mutateAsync({ id: experiment.id });
                  toast.success('Deleted');
                  onBack();
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : 'Failed to delete');
                }
              }}
              isLoading={remove.isPending}
            />
          )}
        </div>
      </div>

      <VariantsSection
        experimentId={experiment.id}
        status={status}
        variants={variants}
        totalWeight={totalWeight}
      />
    </div>
  );
}

// -------------------------------------------------------------------------
// Variants section
// -------------------------------------------------------------------------

type Variant = {
  id: string;
  experiment_id: string;
  label: string;
  weight: number;
  readonly current_version: {
    readonly id: string;
    readonly upstream?: unknown;
    readonly effective_at: string;
    readonly created_at: string;
  } | null;
};

function VariantsSection({
  experimentId,
  status,
  variants,
  totalWeight,
}: {
  experimentId: string;
  status: Status;
  variants: readonly Variant[];
  totalWeight: number;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [versionEditor, setVersionEditor] = useState<{
    open: boolean;
    variantId: string;
    variantLabel: string;
  } | null>(null);
  const [keyRotator, setKeyRotator] = useState<{
    open: boolean;
    variantId: string;
    variantLabel: string;
  } | null>(null);

  const remove = useRemoveVariant();

  const isStructuralLocked = status !== 'draft';
  const isTerminal = status === 'completed';

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Variants</h3>
        {!isStructuralLocked && (
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add variant
          </Button>
        )}
      </div>

      {isStructuralLocked && (
        <p className="text-muted-foreground text-xs">
          Structural edits (add/remove/weight) are locked once an experiment leaves draft. You can
          still hot-swap a variant&rsquo;s upstream config or rotate its api key.
        </p>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Label</TableHead>
            <TableHead>Weight</TableHead>
            <TableHead>Share</TableHead>
            <TableHead>Current internal_id</TableHead>
            <TableHead>Last updated</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {variants.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-muted-foreground text-center">
                No variants yet.
              </TableCell>
            </TableRow>
          )}
          {variants.map(variant => {
            const upstream =
              variant.current_version &&
              ExperimentUpstreamSchema.safeParse(variant.current_version.upstream);
            const internalId = upstream && upstream.success ? upstream.data.internal_id : '—';
            const share =
              totalWeight > 0 ? `${Math.round((variant.weight / totalWeight) * 100)}%` : '—';

            return (
              <TableRow key={variant.id}>
                <TableCell>{variant.label}</TableCell>
                <TableCell className="font-mono text-sm">{variant.weight}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{share}</TableCell>
                <TableCell className="font-mono text-sm">{internalId}</TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {variant.current_version
                    ? new Date(variant.current_version.created_at).toLocaleString()
                    : 'never'}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isTerminal}
                      onClick={() =>
                        setVersionEditor({
                          open: true,
                          variantId: variant.id,
                          variantLabel: variant.label,
                        })
                      }
                    >
                      <RefreshCw className="mr-1 h-3 w-3" />
                      {variant.current_version ? 'Hot-swap' : 'Set version'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isTerminal || !variant.current_version}
                      onClick={() =>
                        setKeyRotator({
                          open: true,
                          variantId: variant.id,
                          variantLabel: variant.label,
                        })
                      }
                    >
                      <KeyRound className="mr-1 h-3 w-3" />
                      Rotate key
                    </Button>
                    {!isStructuralLocked && (
                      <InlineDeleteConfirmation
                        onDelete={async () => {
                          try {
                            await remove.mutateAsync({ variantId: variant.id });
                            toast.success('Variant removed');
                          } catch (err) {
                            toast.error(err instanceof Error ? err.message : 'Failed to remove');
                          }
                        }}
                        isLoading={remove.isPending}
                      />
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <AddVariantDialog experimentId={experimentId} open={addOpen} onOpenChange={setAddOpen} />

      {versionEditor && (
        <SwapVersionDialog
          open={versionEditor.open}
          onOpenChange={open => {
            if (!open) setVersionEditor(null);
          }}
          variantId={versionEditor.variantId}
          variantLabel={versionEditor.variantLabel}
          hasExistingVersion={
            variants.find(v => v.id === versionEditor.variantId)?.current_version != null
          }
          initialUpstream={
            variants.find(v => v.id === versionEditor.variantId)?.current_version?.upstream
          }
        />
      )}

      {keyRotator && (
        <RotateKeyDialog
          open={keyRotator.open}
          onOpenChange={open => {
            if (!open) setKeyRotator(null);
          }}
          variantId={keyRotator.variantId}
          variantLabel={keyRotator.variantLabel}
        />
      )}
    </section>
  );
}

function AddVariantDialog({
  experimentId,
  open,
  onOpenChange,
}: {
  experimentId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [label, setLabel] = useState('');
  const [weight, setWeight] = useState('1');
  const add = useAddVariant();

  const reset = useCallback(() => {
    setLabel('');
    setWeight('1');
  }, []);

  const handleSave = useCallback(async () => {
    const w = Number.parseInt(weight, 10);
    if (!label.trim() || !Number.isFinite(w) || w <= 0) return;
    try {
      await add.mutateAsync({ id: experimentId, label: label.trim(), weight: w });
      toast.success('Variant added');
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add');
    }
  }, [add, experimentId, label, weight, reset, onOpenChange]);

  return (
    <Dialog
      open={open}
      onOpenChange={v => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add variant</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div>
            <Label htmlFor="variant-label">Label</Label>
            <Input
              id="variant-label"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="e.g. control, treatment-a"
            />
          </div>
          <div>
            <Label htmlFor="variant-weight">Weight (positive integer)</Label>
            <Input
              id="variant-weight"
              type="number"
              min={1}
              step={1}
              value={weight}
              onChange={e => setWeight(e.target.value)}
            />
            <p className="text-muted-foreground mt-1 text-xs">
              Bucketing uses the sum of weights as the denominator.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={add.isPending}>
            {add.isPending ? 'Adding…' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SwapVersionDialog({
  open,
  onOpenChange,
  variantId,
  variantLabel,
  initialUpstream,
  hasExistingVersion,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  variantId: string;
  variantLabel: string;
  initialUpstream: unknown;
  hasExistingVersion: boolean;
}) {
  const seed = useMemo<ExperimentUpstream>(() => {
    const parsed = ExperimentUpstreamSchema.safeParse(initialUpstream);
    return parsed.success ? parsed.data : INITIAL_UPSTREAM;
  }, [initialUpstream]);

  const [upstreamJson, setUpstreamJson] = useState(() => JSON.stringify(seed, null, 2));
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const swap = useSwapVariantVersion();

  const handleSave = useCallback(async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(upstreamJson);
    } catch {
      setError('Invalid JSON syntax');
      return;
    }
    const result = ExperimentUpstreamSchema.safeParse(parsed);
    if (!result.success) {
      setError(
        result.error.issues
          .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('\n')
      );
      return;
    }
    const trimmedKey = apiKey.trim();
    if (!hasExistingVersion && !trimmedKey) {
      setError('api key is required for the first version');
      return;
    }
    try {
      await swap.mutateAsync({
        variantId,
        upstream: result.data,
        // Omit apiKey to reuse the existing variant's encrypted key. The
        // server reads the prior version's encrypted_api_key blob in
        // that case.
        ...(trimmedKey ? { apiKey: trimmedKey } : {}),
      });
      toast.success('Variant version inserted');
      setApiKey('');
      setError(null);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  }, [apiKey, hasExistingVersion, onOpenChange, swap, upstreamJson, variantId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Hot-swap version: {variantLabel}</DialogTitle>
          <DialogDescription>
            Inserts a new immutable <code>model_experiment_variant_version</code> row. Old request
            rows continue to point at the previous version. The api key is encrypted before storage
            and is never readable from this UI again.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div>
            <Label>Upstream config (JSON)</Label>
            <div className="border-input mt-1 overflow-hidden rounded-md border">
              <Editor
                height="320px"
                defaultLanguage="json"
                value={upstreamJson}
                onChange={value => {
                  setUpstreamJson(value ?? '');
                  setError(null);
                }}
                theme="vs-dark"
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 2,
                  formatOnPaste: true,
                }}
              />
            </div>
            <p className="text-muted-foreground mt-1 text-xs">
              Validated against <code>ExperimentUpstreamSchema</code> (strict). Do not put the api
              key in this blob — use the field below.
            </p>
          </div>

          <div>
            <Label htmlFor="api-key">API key{hasExistingVersion ? ' (optional)' : ''}</Label>
            <Input
              id="api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={e => {
                setApiKey(e.target.value);
                setError(null);
              }}
              placeholder={
                hasExistingVersion
                  ? 'Leave blank to keep the existing key'
                  : 'Encrypted before storage; never displayed back'
              }
            />
            {hasExistingVersion && (
              <p className="text-muted-foreground mt-1 text-xs">
                Leave this blank to reuse the existing variant&rsquo;s encrypted key. Use the Rotate
                key action instead if you only want to change the key.
              </p>
            )}
          </div>

          {error && (
            <pre className="bg-destructive/10 text-destructive rounded-md p-3 text-sm whitespace-pre-wrap">
              {error}
            </pre>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={swap.isPending}>
            {swap.isPending ? 'Saving…' : 'Save new version'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RotateKeyDialog({
  open,
  onOpenChange,
  variantId,
  variantLabel,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  variantId: string;
  variantLabel: string;
}) {
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rotate = useRotateApiKey();

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) {
      setError('api key is required');
      return;
    }
    try {
      await rotate.mutateAsync({ variantId, apiKey: apiKey.trim() });
      toast.success('API key rotated');
      setApiKey('');
      setError(null);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rotate');
    }
  }, [apiKey, onOpenChange, rotate, variantId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rotate api key: {variantLabel}</DialogTitle>
          <DialogDescription>
            Inserts a new variant version copying the current upstream config and using this key.
            The previous version&rsquo;s key remains in the database for historical attribution.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div>
            <Label htmlFor="rotate-api-key">New API key</Label>
            <Input
              id="rotate-api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={e => {
                setApiKey(e.target.value);
                setError(null);
              }}
            />
          </div>
          {error && (
            <pre className="bg-destructive/10 text-destructive rounded-md p-3 text-sm whitespace-pre-wrap">
              {error}
            </pre>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={rotate.isPending}>
            {rotate.isPending ? 'Rotating…' : 'Rotate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
