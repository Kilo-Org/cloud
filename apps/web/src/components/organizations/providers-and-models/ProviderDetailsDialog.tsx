import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  PolicyPill,
  ProviderPolicyTag,
} from '@/components/organizations/providers-and-models/PolicyPills';
import { DiscountedPrice } from '@/components/organizations/providers-and-models/DiscountedPrice';
import type {
  ProviderModelRow,
  ProviderRow,
} from '@/components/organizations/providers-and-models/providersAndModels.types';
import { getCountryDisplayName } from '@/components/models/util';

export function ProviderDetailsDialog({
  open,
  canEdit,
  infoProvider,
  enabledProviderSlugs,
  infoProviderModels,
  allowedModelIds,
  formatPriceCompact,
  onToggleProviderEnabled,
  onToggleModelAllowed,
  onSetModelsAllowed,
  onClose,
}: {
  open: boolean;
  canEdit: boolean;
  infoProvider: ProviderRow | null;
  enabledProviderSlugs: ReadonlySet<string>;
  infoProviderModels: ReadonlyArray<ProviderModelRow>;
  allowedModelIds: ReadonlySet<string>;
  formatPriceCompact: (raw: string) => string;
  onToggleProviderEnabled: (providerSlug: string, nextEnabled: boolean) => void;
  onToggleModelAllowed: (modelId: string, nextAllowed: boolean) => void;
  onSetModelsAllowed: (modelIds: ReadonlyArray<string>, nextAllowed: boolean) => void;
  onClose: () => void;
}) {
  const isProviderEnabled = infoProvider
    ? enabledProviderSlugs.has(infoProvider.providerSlug)
    : false;
  const providerModelIds = infoProviderModels.map(model => model.modelId);
  const hasModels = providerModelIds.length > 0;
  const allModelsAllowed = providerModelIds.every(modelId => allowedModelIds.has(modelId));
  const noModelsAllowed = providerModelIds.every(modelId => !allowedModelIds.has(modelId));

  return (
    <Dialog open={open} onOpenChange={nextOpen => (nextOpen ? null : onClose())}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col">
        <DialogHeader>
          <div className="flex items-center gap-3">
            {infoProvider?.providerIconUrl ? (
              <img
                src={infoProvider.providerIconUrl}
                alt=""
                className="h-6 w-6 shrink-0 object-contain"
              />
            ) : null}
            <DialogTitle className="leading-none">
              {infoProvider ? infoProvider.providerDisplayName : 'Provider details'}
            </DialogTitle>

            {infoProvider ? (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={isProviderEnabled}
                  disabled={!canEdit}
                  onCheckedChange={nextChecked => {
                    onToggleProviderEnabled(infoProvider.providerSlug, Boolean(nextChecked));
                  }}
                />
                Enabled
              </label>
            ) : null}
          </div>
          <DialogDescription>
            {infoProvider ? infoProvider.providerSlug : 'Provider details'}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          {infoProvider ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <ProviderPolicyTag value={infoProvider.trains} variant="trains" />
                <ProviderPolicyTag value={infoProvider.retainsPrompts} variant="retainsPrompts" />
              </div>

              {infoProvider.headquarters ? (
                <div className="text-muted-foreground text-xs">
                  Headquarters:{' '}
                  <span className="text-foreground">
                    {getCountryDisplayName(infoProvider.headquarters)}
                  </span>
                </div>
              ) : null}

              {infoProvider.datacenters && infoProvider.datacenters.length > 0 ? (
                <div className="text-muted-foreground text-xs">
                  Datacenters:{' '}
                  <span className="text-foreground">
                    {infoProvider.datacenters.map(getCountryDisplayName).join(', ')}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground text-xs">
              Changes apply to these models across all providers and take effect after you save.
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canEdit || !hasModels || allModelsAllowed}
                onClick={() => onSetModelsAllowed(providerModelIds, true)}
              >
                Select all
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canEdit || !hasModels || noModelsAllowed}
                onClick={() => onSetModelsAllowed(providerModelIds, false)}
              >
                Deselect all
              </Button>
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model allowed</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>In</TableHead>
                <TableHead>Out</TableHead>
                <TableHead>Trains</TableHead>
                <TableHead>Retains prompts</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {infoProviderModels.map(model => {
                const isAllowed = allowedModelIds.has(model.modelId);
                return (
                  <TableRow key={model.modelId}>
                    <TableCell>
                      <Checkbox
                        checked={isAllowed}
                        disabled={!canEdit}
                        onCheckedChange={nextChecked => {
                          onToggleModelAllowed(model.modelId, Boolean(nextChecked));
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{model.modelName}</div>
                      <div className="text-muted-foreground mt-0.5 text-xs">{model.modelId}</div>
                    </TableCell>
                    <TableCell>
                      <DiscountedPrice
                        price={model.promptPrice}
                        originalPrice={model.originalPromptPrice}
                        formatPrice={formatPriceCompact}
                      />
                    </TableCell>
                    <TableCell>
                      <DiscountedPrice
                        price={model.completionPrice}
                        originalPrice={model.originalCompletionPrice}
                        formatPrice={formatPriceCompact}
                      />
                    </TableCell>
                    <TableCell>
                      <PolicyPill value={model.trains} variant="trains" />
                    </TableCell>
                    <TableCell>
                      <PolicyPill value={model.retainsPrompts} variant="retainsPrompts" />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
