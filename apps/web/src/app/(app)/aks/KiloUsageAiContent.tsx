'use client';

import { useMutation } from '@tanstack/react-query';
import { BarChart3, Clock3, ShieldCheck, type LucideIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SetPageTitle } from '@/components/SetPageTitle';
import { CloudAgentProvider } from '@/components/cloud-agent-next/CloudAgentProvider';
import { CloudChatPage } from '@/components/cloud-agent-next/CloudChatPage';
import { useOrganizationModels } from '@/components/cloud-agent-next/hooks/useOrganizationModels';
import { ModelCombobox } from '@/components/shared/ModelCombobox';
import { VariantCombobox } from '@/components/shared/VariantCombobox';
import { useTRPC } from '@/lib/trpc/utils';

const KILO_USAGE_AI_DEFAULT_MODEL = 'kilo-auto/balanced';

function ScopeItem({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="flex gap-3 rounded-lg border bg-muted/20 p-3">
      <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground text-sm">{text}</p>
      </div>
    </div>
  );
}

export function KiloUsageAiContent() {
  const trpc = useTRPC();
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('sessionId');
  const startMutation = useMutation(trpc.admin.kiloUsageAi.start.mutationOptions());
  const { modelOptions, isLoadingModels, defaultModel } = useOrganizationModels();
  const [selectedModel, setSelectedModel] = useState(KILO_USAGE_AI_DEFAULT_MODEL);
  const [selectedVariant, setSelectedVariant] = useState<string | undefined>();
  const [isModelUserSelected, setIsModelUserSelected] = useState(false);

  const selectedModelOption = useMemo(
    () => modelOptions.find(model => model.id === selectedModel),
    [modelOptions, selectedModel]
  );
  const availableVariants = useMemo(
    () => selectedModelOption?.variants ?? [],
    [selectedModelOption]
  );

  useEffect(() => {
    if (modelOptions.length === 0) return;
    if (isModelUserSelected && modelOptions.some(model => model.id === selectedModel)) return;

    const defaultModelOption = defaultModel
      ? modelOptions.find(model => model.id === defaultModel)
      : undefined;
    const balancedModelOption = modelOptions.find(
      model => model.id === KILO_USAGE_AI_DEFAULT_MODEL
    );
    const nextModel = defaultModelOption?.id ?? balancedModelOption?.id ?? modelOptions[0]?.id;
    if (!nextModel) return;

    setSelectedModel(nextModel);
  }, [defaultModel, isModelUserSelected, modelOptions, selectedModel]);

  useEffect(() => {
    if (availableVariants.length === 0) {
      if (selectedVariant !== undefined) setSelectedVariant(undefined);
      return;
    }
    if (selectedVariant && availableVariants.includes(selectedVariant)) return;
    setSelectedVariant(availableVariants[0]);
  }, [availableVariants, selectedVariant]);

  function handleModelChange(model: string) {
    setIsModelUserSelected(true);
    setSelectedModel(model);
    const variants = modelOptions.find(option => option.id === model)?.variants ?? [];
    setSelectedVariant(variants[0]);
  }

  async function startAnalysis() {
    try {
      const result = await startMutation.mutateAsync({
        model: selectedModel,
        variant: selectedVariant,
      });
      router.replace(`/ask?sessionId=${encodeURIComponent(result.kiloSessionId)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Try again in a minute.';
      toast.error("Couldn't start analysis", { description: message });
    }
  }

  if (sessionId) {
    return (
      <div className="flex h-[calc(100dvh-3.5rem)] min-h-[560px] flex-col overflow-hidden">
        <SetPageTitle title="Ask Usage" />
        <div className="flex shrink-0 flex-col gap-3 border-b px-4 py-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0 space-y-1">
            <h1 className="truncate text-lg font-semibold">Ask Usage</h1>
            <p className="text-muted-foreground text-sm">
              Personal Kilo activity for up to 60 days. Start a new analysis if the MCP token
              expires.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void startAnalysis()}
            disabled={startMutation.isPending}
            className="w-full md:w-auto"
          >
            {startMutation.isPending ? 'Starting analysis...' : 'New analysis'}
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <CloudAgentProvider>
            <CloudChatPage surface="usage-analyst" />
          </CloudAgentProvider>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] items-center justify-center px-4 py-8">
      <SetPageTitle title="Ask Usage" />
      <Card className="w-full max-w-3xl">
        <CardHeader className="gap-1.5">
          <CardTitle className="flex items-center gap-2 text-lg">
            <BarChart3 className="size-5" />
            Ask Usage
          </CardTitle>
          <CardDescription>
            Start a purpose-built Cloud Agent that answers questions about your own Kilo activity.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-3 md:grid-cols-3">
            <ScopeItem
              icon={ShieldCheck}
              title="Admin-only"
              text="Only eligible Kilo organization admins can start an analysis."
            />
            <ScopeItem
              icon={Clock3}
              title="60-day scope"
              text="Queries are limited to your own aggregate and timeseries activity."
            />
            <ScopeItem
              icon={BarChart3}
              title="Native results"
              text="Validated tool output renders as cards, charts, or compact tables."
            />
          </div>

          <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">Model</p>
              <p className="text-muted-foreground text-sm">
                Choose the model that will answer usage questions for this session.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <ModelCombobox
                models={modelOptions}
                value={selectedModel}
                onValueChange={handleModelChange}
                isLoading={isLoadingModels}
                variant="compact"
                disabled={startMutation.isPending}
                className="w-full sm:w-72"
              />
              {availableVariants.length > 0 && (
                <VariantCombobox
                  variants={availableVariants}
                  value={selectedVariant}
                  onValueChange={setSelectedVariant}
                  disabled={startMutation.isPending}
                  className="w-full sm:w-48"
                />
              )}
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-muted-foreground text-sm">
              A normal billable Cloud Agent session starts only after you click the button.
            </p>
            <Button
              type="button"
              variant="brand"
              onClick={() => void startAnalysis()}
              disabled={startMutation.isPending || !selectedModel}
              className="w-full sm:w-auto"
            >
              {startMutation.isPending ? 'Starting analysis...' : 'Start analysis'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
