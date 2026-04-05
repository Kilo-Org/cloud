import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { MarkdownProse } from '@/components/security-agent/MarkdownProse';
import { PolicyPill } from '@/components/organizations/providers-and-models/PolicyPills';
import type {
  ModelRow,
  ProviderOffering,
} from '@/components/organizations/providers-and-models/providersAndModels.types';

export function ModelDetailsDialog({
  open,
  canEdit,
  infoModel,
  infoBaseModel,
  offerings,
  allowedModelIds,
  enabledProviderSlugs,
  formatPriceCompact,
  onToggleModelAllowed,
  onToggleProviderEnabled,
  onClose,
}: {
  open: boolean;
  canEdit: boolean;
  infoModel: ModelRow | null;
  infoBaseModel: {
    description: string;
    context_length: number;
    author: string;
    input_modalities: string[];
    output_modalities: string[];
  } | null;
  offerings: ReadonlyArray<ProviderOffering>;
  allowedModelIds: ReadonlySet<string>;
  enabledProviderSlugs: ReadonlySet<string>;
  formatPriceCompact: (raw: string) => string;
  onToggleModelAllowed: (modelId: string, nextAllowed: boolean) => void;
  onToggleProviderEnabled: (providerSlug: string, nextEnabled: boolean) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={nextOpen => (nextOpen ? null : onClose())}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <DialogTitle className="leading-none">
              {infoModel ? infoModel.modelName : 'Model details'}
            </DialogTitle>

            {infoModel ? (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={allowedModelIds.has(infoModel.modelId)}
                  disabled={!canEdit}
                  onCheckedChange={nextChecked => {
                    onToggleModelAllowed(infoModel.modelId, Boolean(nextChecked));
                  }}
                />
                Enabled
              </label>
            ) : null}
          </div>
          <DialogDescription>{infoModel ? infoModel.modelId : 'Model details'}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          {infoBaseModel ? (
            <div className="space-y-3">
              <MarkdownProse markdown={infoBaseModel.description} />

              <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Context length</span>
                  <span className="font-medium">
                    {infoBaseModel.context_length.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Author</span>
                  <span className="font-medium">{infoBaseModel.author}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Input</span>
                  <span className="font-medium">
                    {infoBaseModel.input_modalities.join(', ') || '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Output</span>
                  <span className="font-medium">
                    {infoBaseModel.output_modalities.join(', ') || '—'}
                  </span>
                </div>
              </div>
            </div>
          ) : null}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Enabled</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>In</TableHead>
                <TableHead>Out</TableHead>
                <TableHead>Trains</TableHead>
                <TableHead>Retains prompts</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {offerings.map(offering => {
                const isProviderEnabled = enabledProviderSlugs.has(offering.providerSlug);
                return (
                  <TableRow key={offering.providerSlug}>
                    <TableCell>
                      <Checkbox
                        checked={isProviderEnabled}
                        disabled={!canEdit}
                        onCheckedChange={nextChecked => {
                          onToggleProviderEnabled(offering.providerSlug, Boolean(nextChecked));
                        }}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <div className="h-4 w-4 shrink-0">
                          {offering.providerIconUrl ? (
                            <img
                              src={offering.providerIconUrl}
                              alt=""
                              className="h-4 w-4 object-contain"
                            />
                          ) : null}
                        </div>
                        <span>{offering.providerDisplayName}</span>
                      </div>
                    </TableCell>
                    <TableCell>{formatPriceCompact(offering.promptPrice)}</TableCell>
                    <TableCell>{formatPriceCompact(offering.completionPrice)}</TableCell>
                    <TableCell>
                      <PolicyPill value={offering.trains} variant="trains" />
                    </TableCell>
                    <TableCell>
                      <PolicyPill value={offering.retainsPrompts} variant="retainsPrompts" />
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
