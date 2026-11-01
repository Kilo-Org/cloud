'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { useTRPC } from '@/lib/trpc/utils';
import type { RootRouter } from '@/routers/root-router';
import { useModelSelectorList } from '@/lib/hooks/use-openrouter-models';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DIRECT_BYOK_PROVIDERS_META } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/direct-byok-meta';
import { cn } from '@/lib/utils';

type ByokRoutingPreview = inferRouterOutputs<RootRouter>['byok']['previewRouting'];
type RouteStep = Extract<ByokRoutingPreview, { kind: 'routes' }>['steps'][number];
type ApiKind = 'chat_completions' | 'responses' | 'messages';

const API_KIND_LABELS = {
  chat_completions: 'Chat Completions',
  responses: 'Responses',
  messages: 'Anthropic Messages',
} satisfies Record<ApiKind, string>;

const API_KINDS = Object.keys(API_KIND_LABELS) as ApiKind[];

function isApiKind(value: string): value is ApiKind {
  return value in API_KIND_LABELS;
}

const GATEWAY_NAMES = { vercel: 'Vercel AI Gateway', openrouter: 'OpenRouter' } as const;

// Provider model IDs such as `synthetic/...` route straight to their provider, not through this list.
const DIRECT_BYOK_MODEL_PREFIXES = Object.keys(DIRECT_BYOK_PROVIDERS_META).map(id => `${id}/`);

function formatApiKinds(apiKinds: readonly ApiKind[]) {
  return apiKinds.map(apiKind => API_KIND_LABELS[apiKind]).join(' and ');
}

/** Some display names already name the credential ("OpenAI API key"), so they keep one "key". */
function keyLabel(names: string[]) {
  const providers = names.map(name => name.replace(/\s+key$/i, ''));
  return `${providers.join(', ')} ${names.length === 1 ? 'key' : 'keys'}`;
}

type StepDescription = { title: string; detail: string };

export function describeRouteStep(
  step: RouteStep,
  getProviderName: (providerId: string) => string,
  isOrganization: boolean
): StepDescription {
  const description = describeStepReason(step, getProviderName, isOrganization);
  return step.outcome === 'unreached'
    ? { title: description.title, detail: 'Not tried: a route above serves this model.' }
    : description;
}

function describeStepReason(
  step: RouteStep,
  getProviderName: (providerId: string) => string,
  isOrganization: boolean
): StepDescription {
  switch (step.route) {
    case 'direct-byok': {
      const title = keyLabel([getProviderName(step.providerId)]);
      switch (step.reason) {
        case 'serves':
          return { title, detail: 'Serves this model with Kilo catalog model IDs.' };
        case 'unsupported-api-kind':
          return {
            title,
            detail: `Skipped: the provider serves this model over ${formatApiKinds(step.supportedApiKinds)} only.`,
          };
        case 'disabled':
          return { title, detail: 'Skipped: the key is disabled.' };
        case 'not-catalog-mode':
          return {
            title,
            detail:
              'Skipped: the key uses provider model IDs. Turn on Kilo catalog model IDs to use it for this model.',
          };
      }
      break;
    }
    case 'chatgpt': {
      const title = 'ChatGPT subscription';
      switch (step.reason) {
        case 'serves':
          return {
            title,
            detail: isOrganization
              ? 'Used when the member sending the request has connected ChatGPT for this organization.'
              : 'Uses your ChatGPT subscription instead of API keys or Kilo credits.',
          };
        case 'not-connected':
          return { title, detail: 'Skipped: no ChatGPT connection for your personal account.' };
        case 'disabled':
          return {
            title,
            detail: 'Skipped: your ChatGPT connection is disabled or needs reconnecting.',
          };
        case 'unsupported-api-kind':
          return {
            title,
            detail: 'Skipped: ChatGPT subscriptions support the Responses API only.',
          };
        case 'model-unavailable':
          return { title, detail: 'Skipped: this model is not available through ChatGPT.' };
        case 'unavailable':
          return { title, detail: 'Skipped: ChatGPT subscription routing is not available.' };
      }
      break;
    }
    case 'vercel-byok': {
      const title = `${keyLabel(step.providerIds.map(getProviderName))} via Vercel AI Gateway`;
      if (step.reason === 'disabled') return { title, detail: 'Skipped: the key is disabled.' };
      return {
        title,
        detail:
          step.providerIds.length > 1
            ? 'Vercel AI Gateway tries these keys in unspecified order.'
            : 'Serves this model with the key.',
      };
    }
    case 'gateway-byok': {
      const title = keyLabel([getProviderName(step.providerId)]);
      switch (step.reason) {
        case 'serves':
          return { title, detail: 'Serves this model through your gateway account.' };
        case 'disabled':
          return { title, detail: 'Skipped: the key is disabled.' };
        case 'provider-key-preferred':
          return { title, detail: 'Skipped: a provider key above serves this model.' };
        case 'model-unavailable':
          return { title, detail: 'Skipped: this gateway does not offer the model.' };
        case 'provider-settings':
          return { title, detail: 'Skipped: Vercel AI Gateway cannot serve this model.' };
      }
      break;
    }
    case 'unsupported-api-kind':
      return {
        title: 'Request fails',
        detail: `The ${keyLabel([getProviderName(step.providerId)])} serves this model over ${formatApiKinds(step.supportedApiKinds)} only. Requests for a model your keys serve never fall back to Kilo credits.`,
      };
    case 'kilo':
      return {
        title: `Kilo via ${GATEWAY_NAMES[step.gateway]}`,
        detail: 'Paid with Kilo credits.',
      };
  }
}

function OutcomeBadge({ step }: { step: RouteStep }) {
  if (step.route === 'unsupported-api-kind' && step.outcome === 'used') {
    return <Badge variant="destructive">Fails</Badge>;
  }
  switch (step.outcome) {
    case 'used':
      return <Badge variant="new">Used</Badge>;
    case 'skipped':
      return <Badge variant="outline">Skipped</Badge>;
    case 'unreached':
      return <Badge variant="secondary">Not tried</Badge>;
    case 'conditional':
      return <Badge variant="beta">If connected</Badge>;
  }
}

function RouteList({
  preview,
  getProviderName,
  isOrganization,
}: {
  preview: ByokRoutingPreview;
  getProviderName: (providerId: string) => string;
  isOrganization: boolean;
}) {
  if (preview.kind === 'custom-llm') {
    return (
      <p className="text-muted-foreground text-sm">
        This is a custom model. It always uses its own configured provider, not BYOK keys.
      </p>
    );
  }
  if (preview.kind === 'not-catalog-model') {
    return (
      <p className="text-muted-foreground text-sm">
        The preview covers Kilo catalog models. Auto models pick a catalog model for each request.
      </p>
    );
  }
  return (
    <ol className="divide-y rounded-md border" aria-label="Routes in the order they are tried">
      {preview.steps.map((step, index) => {
        const { title, detail } = describeRouteStep(step, getProviderName, isOrganization);
        const muted = step.outcome === 'skipped' || step.outcome === 'unreached';
        return (
          <li key={index} className="flex items-start gap-3 px-3 py-2.5">
            <span className="text-muted-foreground w-4 pt-0.5 text-right font-mono text-xs tabular-nums">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div
                className={cn('text-sm font-medium break-words', muted && 'text-muted-foreground')}
              >
                {title}
              </div>
              <p className="text-muted-foreground text-xs">{detail}</p>
            </div>
            <OutcomeBadge step={step} />
          </li>
        );
      })}
    </ol>
  );
}

export function BYOKRoutingPreview({
  organizationId,
  getProviderName,
}: {
  organizationId?: string;
  getProviderName: (providerId: string) => string;
}) {
  const trpc = useTRPC();
  const [modelId, setModelId] = useState('');
  const [apiKind, setApiKind] = useState<ApiKind>('chat_completions');
  const {
    data: models,
    isLoading: modelsLoading,
    error: modelsError,
  } = useModelSelectorList(organizationId);

  const modelOptions = useMemo<ModelOption[]>(
    () =>
      models?.data
        .filter(model => !DIRECT_BYOK_MODEL_PREFIXES.some(prefix => model.id.startsWith(prefix)))
        .map(model => ({
          id: model.id,
          name: model.name,
          isFree: model.isFree,
          mayTrainOnYourPrompts: model.mayTrainOnYourPrompts,
          hasUserByokAvailable: model.hasUserByokAvailable,
        })) ?? [],
    [models]
  );

  const {
    data: preview,
    isFetching,
    error: previewError,
  } = useQuery({
    ...trpc.byok.previewRouting.queryOptions({
      ...(organizationId && { organizationId }),
      modelId,
      apiKind,
    }),
    enabled: modelId !== '',
  });

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle>Routing preview</CardTitle>
        <CardDescription>
          Pick a model to see which {organizationId ? 'organization ' : ''}keys and ChatGPT
          connections serve it, in the order requests try them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
          <ModelCombobox
            id="byok-routing-preview-model"
            models={modelOptions}
            value={modelId}
            onValueChange={setModelId}
            isLoading={modelsLoading}
            error={
              modelsError ? 'Models could not be loaded. Reload the page to try again.' : undefined
            }
          />
          <div className="space-y-2">
            <Label htmlFor="byok-routing-preview-api">API</Label>
            <Select
              value={apiKind}
              onValueChange={value => {
                if (isApiKind(value)) setApiKind(value);
              }}
            >
              <SelectTrigger id="byok-routing-preview-api" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {API_KINDS.map(kind => (
                  <SelectItem key={kind} value={kind}>
                    {API_KIND_LABELS[kind]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          ChatGPT subscriptions apply only to Responses API requests. Select Responses to preview
          that route.
        </p>
        {modelId === '' ? null : previewError ? (
          <p className="text-status-destructive text-sm">
            The routing preview could not be loaded. Try again in a moment.
          </p>
        ) : isFetching && !preview ? (
          <div className="space-y-2" aria-label="Loading routes">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : preview ? (
          <RouteList
            preview={preview}
            getProviderName={getProviderName}
            isOrganization={!!organizationId}
          />
        ) : null}
        <p className="text-muted-foreground text-xs">
          {organizationId
            ? 'Organization model and provider policies still apply: they can block the model or change which gateway serves it.'
            : 'Provider preferences sent with a request can change which gateway serves it.'}
        </p>
      </CardContent>
    </Card>
  );
}
