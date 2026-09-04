'use client';

import { useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Github,
  LockKeyhole,
  Pencil,
  RotateCcw,
  Search,
} from 'lucide-react';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
export type PreviewReviewMode = 'on' | 'off' | 'manual';

const reviewModes: { value: PreviewReviewMode; label: string }[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
  { value: 'manual', label: 'Manual (@mention)' },
];

function reviewModeName(value: PreviewReviewMode) {
  return reviewModes.find(mode => mode.value === value)?.label ?? value;
}

export type PreviewRepository = {
  id: string;
  name: string;
  private: boolean;
  model: string | null;
  prReviews: PreviewReviewMode | null;
};

export type PreviewInstallation = {
  id: string;
  account: string;
  access: 'all' | 'selected';
  defaultModel: string;
  defaultPrReviews: PreviewReviewMode;
  repositories: PreviewRepository[];
};

function modelName(models: ModelOption[], id: string) {
  return models.find(model => model.id === id)?.name ?? id;
}

function repositoryCustomizationSummary(
  models: ModelOption[],
  repository: PreviewRepository
): string[] {
  const summary: string[] = [];
  if (repository.model !== null) summary.push(`Model: ${modelName(models, repository.model)}`);
  if (repository.prReviews !== null)
    summary.push(`PR reviews: ${reviewModeName(repository.prReviews)}`);
  return summary;
}

const PAGE_SIZE = 10;

type PreviewProps = {
  scope: 'personal' | 'organization';
  organizationName: string;
  installations: PreviewInstallation[];
  models: ModelOption[];
};

export function GitHubRepositoryCustomizationsPreview({
  scope,
  organizationName,
  installations,
  models,
}: PreviewProps) {
  const [revision, setRevision] = useState(0);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="border-b border-border bg-muted/30">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-8">
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <Badge variant="outline">UI preview</Badge>
            <span>Mock data only. Changes reset when you reload.</span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setRevision(value => value + 1)}>
            <RotateCcw className="size-4" aria-hidden="true" />
            Reset preview
          </Button>
        </div>
      </div>
      <main className="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:px-8">
        <header className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {scope === 'organization' ? organizationName : 'Personal account'}
            <span className="px-2" aria-hidden="true">
              /
            </span>
            Integrations
            <span className="px-2" aria-hidden="true">
              /
            </span>
            <span className="text-foreground">GitHub</span>
          </p>
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">GitHub integration</h1>
            <p className="text-sm text-muted-foreground">
              {scope === 'organization'
                ? 'Manage connected GitHub organizations and how Kilo responds in their repositories.'
                : 'Manage your connected GitHub account and how Kilo responds in your repositories.'}
            </p>
          </div>
        </header>
        <div key={`${scope}-${revision}`} className="space-y-5">
          {installations
            .slice(0, scope === 'personal' ? 1 : undefined)
            .map((installation, index) => (
              <InstallationCustomizations
                key={installation.id}
                installation={installation}
                models={models}
                initiallyOpen={index === 0}
              />
            ))}
        </div>
      </main>
    </div>
  );
}

function InstallationCustomizations({
  installation,
  models,
  initiallyOpen,
}: {
  installation: PreviewInstallation;
  models: ModelOption[];
  initiallyOpen: boolean;
}) {
  const [defaultModel, setDefaultModel] = useState(installation.defaultModel);
  const [defaultPrReviews, setDefaultPrReviews] = useState(installation.defaultPrReviews);
  const [repositories, setRepositories] = useState(installation.repositories);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editingRepository, setEditingRepository] = useState<PreviewRepository | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const editTrigger = useRef<HTMLButtonElement | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);

  const customizedCount = repositories.filter(
    repository => repositoryCustomizationSummary(models, repository).length > 0
  ).length;
  const searchTerms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filteredRepositories = repositories.filter(repository => {
    const effectiveModel = repository.model ?? defaultModel;
    const effectiveReviews = reviewModeName(repository.prReviews ?? defaultPrReviews);
    const searchableText =
      `${repository.name} ${effectiveModel} ${modelName(models, effectiveModel)} PR reviews: ${effectiveReviews}`.toLowerCase();
    return searchTerms.every(term => searchableText.includes(term));
  });
  const pageCount = Math.max(1, Math.ceil(filteredRepositories.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * PAGE_SIZE;
  const visibleRepositories = filteredRepositories.slice(start, start + PAGE_SIZE);
  function clearSearch() {
    setSearch('');
    setPage(1);
  }

  return (
    <Card className="overflow-hidden">
      <Collapsible defaultOpen={initiallyOpen}>
        <div className="flex items-center justify-between gap-3 p-5 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/30">
              <Github className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-semibold">{installation.account}</h2>
                <Badge variant="outline">Connected</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {installation.access === 'all'
                  ? 'All repositories'
                  : `${repositories.length} selected repositories`}
                <span className="px-2" aria-hidden="true">
                  ·
                </span>
                {customizedCount} customized
              </p>
            </div>
          </div>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="group min-h-11"
              aria-label={`Toggle settings for ${installation.account}`}
            >
              <span className="hidden sm:inline">Settings</span>
              <ChevronDown
                className="size-4 transition-transform group-data-[state=open]:rotate-180"
                aria-hidden="true"
              />
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div className="space-y-6 border-t border-border px-5 py-6 sm:px-6">
            <div className="grid gap-4 md:grid-cols-[1fr_20rem] md:items-start">
              <div className="space-y-1.5">
                <h3 className="text-sm font-medium">Default AI model</h3>
                <p className="max-w-lg text-sm text-muted-foreground">
                  Used for GitHub bot mentions in repositories without a custom model. Changing the
                  default won’t affect custom models.
                </p>
              </div>
              <ModelCombobox
                id={`${installation.id}-default-model`}
                label=""
                triggerAriaLabel={`Default AI model for ${installation.account}`}
                models={models}
                value={defaultModel}
                onValueChange={model => {
                  setDefaultModel(model);
                  setPage(1);
                  setAnnouncement(
                    `Default updated to ${modelName(models, model)} in this preview. Custom models are unchanged.`
                  );
                }}
              />
            </div>
            <div className="grid gap-4 md:grid-cols-[1fr_20rem] md:items-start">
              <div className="space-y-1.5">
                <Label htmlFor={`${installation.id}-default-reviews`}>
                  Default pull request reviews
                </Label>
                <p className="max-w-lg text-sm text-muted-foreground">
                  Review pull requests automatically, only when @mentioned, or not at all.
                  Repository overrides are unaffected.
                </p>
              </div>
              <ReviewModeSelect
                id={`${installation.id}-default-reviews`}
                value={defaultPrReviews}
                onValueChange={mode => {
                  if (mode === null) return;
                  setDefaultPrReviews(mode);
                  setPage(1);
                  setAnnouncement(
                    `Default PR reviews updated to ${reviewModeName(mode)} in this preview.`
                  );
                }}
              />
            </div>
          </div>
          <section
            className="border-t border-border"
            aria-labelledby={`${installation.id}-customizations`}
          >
            <div className="space-y-5 px-5 py-5 sm:px-6">
              <div className="space-y-1.5">
                <h3 id={`${installation.id}-customizations`} className="font-semibold">
                  Repository Customizations
                </h3>
                <p className="text-sm text-muted-foreground">
                  See what’s different from the integration defaults. Edit a repository to customize
                  its settings.
                </p>
              </div>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                <div className="min-w-0 flex-1 space-y-2">
                  <Label htmlFor={`${installation.id}-search`}>Search repositories</Label>
                  <div className="relative">
                    <Search
                      className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Input
                      id={`${installation.id}-search`}
                      ref={searchInput}
                      type="search"
                      placeholder="Search repositories or settings…"
                      className="pl-9"
                      value={search}
                      onChange={event => {
                        setSearch(event.target.value);
                        setPage(1);
                      }}
                    />
                  </div>
                </div>
              </div>
              <div className="flex min-h-8 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <p aria-live="polite">
                  {filteredRepositories.length} of {repositories.length} repositories ·{' '}
                  {customizedCount} customized
                </p>
                {search !== '' && (
                  <Button variant="ghost" size="sm" onClick={clearSearch}>
                    Clear search
                  </Button>
                )}
              </div>
            </div>
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5 sm:w-[34%] sm:pl-6">Repository</TableHead>
                  <TableHead className="hidden sm:table-cell">Customizations</TableHead>
                  <TableHead className="w-20 pr-5 text-right sm:pr-6">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRepositories.map(repository => (
                  <TableRow key={repository.id}>
                    <TableCell className="pl-5 sm:pl-6">
                      <div className="space-y-1.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="truncate font-mono text-xs sm:text-sm"
                            title={repository.name}
                          >
                            {repository.name}
                          </span>
                          {repository.private && (
                            <LockKeyhole
                              className="size-3 shrink-0 text-muted-foreground"
                              aria-label="Private repository"
                            />
                          )}
                        </div>
                        <div className="sm:hidden">
                          <CustomizationSummary repository={repository} models={models} />
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <CustomizationSummary repository={repository} models={models} />
                    </TableCell>
                    <TableCell className="pr-5 text-right sm:pr-6">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="min-h-11 px-2 sm:min-h-8"
                        aria-label={`Edit ${repository.name}`}
                        onClick={event => {
                          editTrigger.current = event.currentTarget;
                          setEditingRepository(repository);
                        }}
                      >
                        <Pencil className="hidden size-3.5 sm:block" aria-hidden="true" />
                        Edit
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {filteredRepositories.length === 0 && (
              <div className="space-y-2 px-6 py-12 text-center">
                <Search className="mx-auto mb-3 size-5 text-muted-foreground" aria-hidden="true" />
                <p className="text-sm font-medium">No repositories match your search</p>
                <p className="text-sm text-muted-foreground">
                  Try a different repository or setting, or clear your search.
                </p>
                <Button variant="outline" size="sm" onClick={clearSearch}>
                  Clear search
                </Button>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-4 sm:px-6">
              <p className="text-xs text-muted-foreground">
                {filteredRepositories.length === 0
                  ? '0 repositories'
                  : `${start + 1}–${Math.min(start + PAGE_SIZE, filteredRepositories.length)} of ${filteredRepositories.length} repositories`}
              </p>
              {pageCount > 1 && (
                <nav
                  className="flex items-center gap-2"
                  aria-label={`Repository pages for ${installation.account}`}
                >
                  <Button
                    variant="outline"
                    size="icon-sm"
                    disabled={currentPage === 1}
                    aria-label="Previous page"
                    onClick={() => setPage(currentPage - 1)}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <span className="px-1 text-xs text-muted-foreground">
                    {currentPage} / {pageCount}
                  </span>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    disabled={currentPage === pageCount}
                    aria-label="Next page"
                    onClick={() => setPage(currentPage + 1)}
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </nav>
              )}
            </div>
          </section>
          <p
            className={
              announcement
                ? 'border-t border-border px-6 py-3 text-xs text-muted-foreground'
                : 'sr-only'
            }
            role="status"
          >
            {announcement}
          </p>
        </CollapsibleContent>
      </Collapsible>
      <Sheet
        open={editingRepository !== null}
        onOpenChange={open => {
          if (!open) setEditingRepository(null);
        }}
      >
        <SheetContent
          className="w-full gap-0 sm:max-w-lg"
          onCloseAutoFocus={event => {
            event.preventDefault();
            if (editTrigger.current?.isConnected) {
              editTrigger.current.focus();
            } else {
              searchInput.current?.focus();
            }
          }}
        >
          {editingRepository && (
            <RepositorySettingsEditor
              key={editingRepository.id}
              repository={editingRepository}
              models={models}
              defaultModel={defaultModel}
              defaultPrReviews={defaultPrReviews}
              account={installation.account}
              onCancel={() => setEditingRepository(null)}
              onSave={settings => {
                setRepositories(current =>
                  current.map(repository =>
                    repository.id === editingRepository.id
                      ? { ...repository, ...settings }
                      : repository
                  )
                );
                setAnnouncement(`${editingRepository.name} updated in this preview.`);
                setEditingRepository(null);
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </Card>
  );
}

function CustomizationSummary({
  repository,
  models,
}: {
  repository: PreviewRepository;
  models: ModelOption[];
}) {
  const summary = repositoryCustomizationSummary(models, repository);
  if (summary.length === 0) {
    return <span className="text-xs text-muted-foreground">Using integration defaults</span>;
  }

  return (
    <p className="text-xs leading-relaxed sm:text-sm">
      {summary.slice(0, 2).join(' · ')}
      {summary.length > 2 && (
        <span className="text-muted-foreground"> · +{summary.length - 2} more</span>
      )}
    </p>
  );
}

function ReviewModeSelect({
  id,
  value,
  defaultMode,
  onValueChange,
}: {
  id: string;
  value: PreviewReviewMode | null;
  defaultMode?: PreviewReviewMode;
  onValueChange: (value: PreviewReviewMode | null) => void;
}) {
  return (
    <Select
      value={value ?? 'default'}
      onValueChange={selected => {
        if (selected === 'default') {
          onValueChange(null);
          return;
        }
        const mode = reviewModes.find(option => option.value === selected);
        if (mode) onValueChange(mode.value);
      }}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {defaultMode !== undefined && (
          <SelectItem value="default">
            Use integration default — {reviewModeName(defaultMode)}
          </SelectItem>
        )}
        {reviewModes.map(mode => (
          <SelectItem key={mode.value} value={mode.value}>
            {mode.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function RepositorySettingsEditor({
  repository,
  models,
  defaultModel,
  defaultPrReviews,
  account,
  onSave,
  onCancel,
}: {
  repository: PreviewRepository;
  models: ModelOption[];
  defaultModel: string;
  defaultPrReviews: PreviewReviewMode;
  account: string;
  onSave: (settings: Pick<PreviewRepository, 'model' | 'prReviews'>) => void;
  onCancel: () => void;
}) {
  const [model, setModel] = useState(repository.model);
  const [prReviews, setPrReviews] = useState(repository.prReviews);
  const isInherited = model === null;

  return (
    <>
      <SheetHeader className="border-b border-border pb-5 pr-14">
        <p className="text-xs text-muted-foreground">Repository Customizations</p>
        <SheetTitle className="break-all font-mono text-base">{repository.name}</SheetTitle>
        <SheetDescription>
          Override individual settings for this repository. Everything else follows the integration
          defaults.
        </SheetDescription>
      </SheetHeader>
      <div className="flex-1 space-y-6 overflow-y-auto p-6">
        <fieldset className="space-y-3">
          <legend className="mb-3 text-sm font-medium">AI model</legend>
          <label
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border p-4 focus-within:ring-2 focus-within:ring-ring',
              isInherited ? 'border-primary bg-muted/30' : 'border-border'
            )}
          >
            <input
              type="radio"
              name={`${repository.id}-model-source`}
              checked={isInherited}
              onChange={() => setModel(null)}
              className="mt-1 size-4 shrink-0 accent-primary"
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium">Use integration default</span>
              <span className="block text-sm text-muted-foreground">
                {modelName(models, defaultModel)}
              </span>
              <span className="block text-xs leading-relaxed text-muted-foreground">
                Follows the default for {account}, including future changes.
              </span>
            </span>
          </label>
          <div
            className={cn(
              'rounded-lg border p-4',
              !isInherited ? 'border-primary bg-muted/30' : 'border-border'
            )}
          >
            <label className="flex cursor-pointer items-start gap-3 rounded focus-within:ring-2 focus-within:ring-ring">
              <input
                type="radio"
                name={`${repository.id}-model-source`}
                checked={!isInherited}
                onChange={() => setModel(defaultModel)}
                className="mt-1 size-4 shrink-0 accent-primary"
              />
              <span className="space-y-1">
                <span className="block text-sm font-medium">Use a specific model</span>
                <span className="block text-xs leading-relaxed text-muted-foreground">
                  Stays pinned even when the integration default changes.
                </span>
              </span>
            </label>
            {!isInherited && (
              <div className="mt-4">
                <ModelCombobox
                  id={`${repository.id}-custom-model`}
                  label="Custom AI model"
                  models={models}
                  value={model}
                  onValueChange={setModel}
                  modal
                />
              </div>
            )}
          </div>
        </fieldset>
        <div className="space-y-3 border-t border-border pt-6">
          <Label htmlFor={`${repository.id}-reviews`}>Pull request reviews</Label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            On reviews pull requests automatically. Manual requires an @mention. Off disables
            reviews.
          </p>
          <ReviewModeSelect
            id={`${repository.id}-reviews`}
            value={prReviews}
            defaultMode={defaultPrReviews}
            onValueChange={setPrReviews}
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            {prReviews === null
              ? `Follows the default for ${account}, including future changes.`
              : prReviews === defaultPrReviews
                ? 'This matches today’s default, but remains an explicit override.'
                : 'Applies only to this repository, even when the integration default changes.'}
          </p>
        </div>
        <div className="space-y-3 rounded-lg bg-muted/40 p-4">
          <p className="text-xs text-muted-foreground">Effective settings</p>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">AI model</dt>
              <dd className="mt-1">
                {modelName(models, model ?? defaultModel)}{' '}
                <span className="text-xs text-muted-foreground">
                  · {isInherited ? 'Default' : 'Custom'}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">PR reviews</dt>
              <dd className="mt-1">
                {reviewModeName(prReviews ?? defaultPrReviews)}{' '}
                <span className="text-xs text-muted-foreground">
                  · {prReviews === null ? 'Default' : 'Custom'}
                </span>
              </dd>
            </div>
          </dl>
          {!isInherited && model === defaultModel && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              The custom model matches today’s default, but remains pinned.
            </p>
          )}
        </div>
      </div>
      <SheetFooter className="border-t border-border pt-4">
        <p className="mb-2 text-xs text-muted-foreground">
          Preview only. No live settings will be changed.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={model === repository.model && prReviews === repository.prReviews}
            onClick={() => onSave({ model, prReviews })}
          >
            Save changes
          </Button>
        </div>
      </SheetFooter>
    </>
  );
}
