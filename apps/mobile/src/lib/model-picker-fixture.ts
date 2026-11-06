import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { type ModelPickerBridge } from '@/lib/picker-bridge';
import { modelPickerSlot } from '@/lib/route-registry';

// Development-only remote CLI catalog: kiloapp:///dev/model-picker-fixture/multiple-providers.
export function modelPickerFixtureRoute(path: string): string | null {
  if (!/(?:^|\/)dev\/model-picker-fixture\/multiple-providers\/?(?:[?#].*)?$/.test(path)) {
    return null;
  }

  const routeKey = 'model-picker-fixture';
  // The Kilo Auto tiers, shaped as `createGatewayOption` shapes them: the
  // catalog id is the display id and the model ref, so each row renders the
  // catalog's own tier label instead of the gateway's English name.
  const autoTiers = [
    { modelID: 'kilo-auto/frontier', name: 'Auto Frontier' },
    { modelID: 'kilo-auto/balanced', name: 'Auto Balanced' },
    { modelID: 'kilo-auto/efficient', name: 'Auto Efficient' },
    { modelID: 'kilo-auto/small', name: 'Auto Small' },
    { modelID: 'kilo-auto/free', name: 'Auto Free' },
  ];
  const autoOptions: SessionModelOption[] = autoTiers.map(({ modelID, name }) => ({
    id: modelID,
    name,
    displayId: modelID,
    modelRef: { providerID: 'kilo', modelID },
    provider: { id: 'kilo', name: 'Kilo' },
    variants: [],
    isPreferred: false,
    showGatewayMetadata: true,
  }));
  const providers = [
    { id: 'anthropic', name: 'Anthropic' },
    { id: 'openai', name: 'OpenAI' },
    { id: 'google', name: 'Google' },
  ];
  const options: SessionModelOption[] = [
    ...autoOptions,
    ...providers.flatMap(({ id: providerID, name: providerName }, providerIndex) =>
      Array.from({ length: 40 }, (_, index) => {
        const modelID = `${providerID}-model-${String(index).padStart(2, '0')}`;
        return {
          id: `remote-model-${providerIndex * 40 + index}`,
          name: `${providerName} Model ${String(index).padStart(2, '0')}`,
          displayId: modelID,
          modelRef: { providerID, modelID },
          provider: { id: providerID, name: providerName },
          variants: [],
          isPreferred: false,
          showGatewayMetadata: false,
        };
      })
    ),
  ];
  const selectionScope: ModelPickerBridge['selectionScope'] = {
    sessionId: routeKey,
    ownerConnectionId: 'fixture-remote-cli',
    protocol: 'v1',
    catalogGenerationIdentity: {},
  };
  const bridge: ModelPickerBridge = {
    options,
    currentValue: options[0]?.id ?? '',
    currentVariant: '',
    acceptsVariant: true,
    selectionScope,
    isSelectionCurrent: scope => scope === selectionScope,
    onSelect: selection => {
      bridge.currentValue = selection.option.id;
      bridge.currentVariant = selection.variant;
    },
  };
  modelPickerSlot.set(routeKey, bridge);
  return `/(app)/agent-chat/model-picker?routeKey=${routeKey}`;
}
