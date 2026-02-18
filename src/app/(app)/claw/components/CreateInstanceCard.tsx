'use client';

import { useMemo, useState } from 'react';
import { Eye, EyeOff, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { useOpenRouterModels } from '@/app/api/openrouter/hooks';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

export function CreateInstanceCard({ mutations }: { mutations: ClawMutations }) {
  const { data: modelsData, isLoading: isLoadingModels } = useOpenRouterModels();
  const [selectedModel, setSelectedModel] = useState('');
  const [telegramBotToken, setTelegramBotToken] = useState('');
  const [showToken, setShowToken] = useState(false);

  const modelOptions = useMemo<ModelOption[]>(
    () => (modelsData?.data || []).map(model => ({ id: model.id, name: model.name })),
    [modelsData]
  );

  function handleCreate() {
    if (isLoadingModels) {
      toast.error('Models are still loading; try again in a moment.');
      return;
    }

    const modelsPayload = modelOptions.map(({ id, name }) => ({ id, name }));
    const trimmedToken = telegramBotToken.trim();
    mutations.provision.mutate(
      {
        kilocodeDefaultModel: selectedModel ? `kilocode/${selectedModel}` : null,
        kilocodeModels: modelsPayload.length > 0 ? modelsPayload : null,
        channels: trimmedToken ? { telegramBotToken: trimmedToken } : undefined,
      },
      {
        onSuccess: () => toast.success('Instance created'),
        onError: err => toast.error(`Failed to create: ${err.message}`),
      }
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create Instance</CardTitle>
        <CardDescription>
          Choose a default model to provision your first KiloClaw instance.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ModelCombobox
          label=""
          models={modelOptions}
          value={selectedModel}
          onValueChange={setSelectedModel}
          isLoading={isLoadingModels}
          disabled={mutations.provision.isPending || isLoadingModels}
        />
        <div className="space-y-2">
          <Label htmlFor="telegram-bot-token">Telegram Bot Token (optional)</Label>
          <div className="relative">
            <Input
              id="telegram-bot-token"
              type="text"
              placeholder="123456:ABC-DEF..."
              value={telegramBotToken}
              onChange={e => setTelegramBotToken(e.target.value)}
              disabled={mutations.provision.isPending}
              data-1p-ignore
              autoComplete="off"
              className="pr-9"
              style={
                showToken ? undefined : ({ WebkitTextSecurity: 'disc' } as React.CSSProperties)
              }
            />
            <button
              type="button"
              onClick={() => setShowToken(v => !v)}
              className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
              tabIndex={-1}
            >
              {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <p className="text-muted-foreground text-xs">
            Get a token from{' '}
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              @BotFather
            </a>{' '}
            on Telegram. You can also add this later.
          </p>
        </div>
        <div className="flex justify-end">
          <Button onClick={handleCreate} disabled={mutations.provision.isPending}>
            <Plus className="mr-2 h-4 w-4" />
            {mutations.provision.isPending ? 'Creating...' : 'Create & Provision'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
