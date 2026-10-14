import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { type ModelPickerBridge } from '@/lib/picker-bridge';
import { modelPickerSlot } from '@/lib/route-registry';

// Development-only remote CLI catalog: kiloapp:///dev/model-picker-fixture/multiple-providers.
export function modelPickerFixtureRoute(path: string): string | null {
  if (!/(?:^|\/)dev\/model-picker-fixture\/multiple-providers\/?(?:[?#].*)?$/.test(path)) {
    return null;
  }

  const routeKey = 'model-picker-fixture';
  const options: SessionModelOption[] = ['Anthropic', 'OpenAI', 'Google'].flatMap(
    (providerName, providerIndex) =>
      Array.from({ length: 40 }, (_, index) => {
        const providerID = providerName.toLowerCase();
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
  );
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
