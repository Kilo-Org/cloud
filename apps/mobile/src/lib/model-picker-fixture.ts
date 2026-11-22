import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { type ModelPickerBridge } from '@/lib/picker-bridge';
import { modelPickerSlot } from '@/lib/route-registry';

// Development-only remote CLI catalog, on the picker fixture's own dev link.
// The same link carries `unavailable=1`, which serves the all-unavailable
// projection (one dead row, the session's current selection) instead of the
// multi-provider catalog, and `empty=1`, which serves a catalog the session's
// refetch has not filled yet. Both ride this path rather than paths of their
// own because the design gate must open the same route on the merge base,
// whose fixture only knows this path.
export function modelPickerFixtureRoute(path: string): string | null {
  if (!/(?:^|\/)dev\/model-picker-fixture\/multiple-providers\/?(?:[?#].*)?$/.test(path)) {
    return null;
  }

  const routeKey = 'model-picker-fixture';

  if (/[?&]empty=1(?:[&#]|$)/.test(path)) {
    // The composer's chip opens the picker with the catalog it holds. When that
    // catalog is empty the session can still refetch it, and the sheet offers
    // that as its one action. The fixture records the ask instead of reaching a
    // backend the picker cannot, so the action and its close are provable on a
    // device without a live catalog.
    const emptyScope: ModelPickerBridge['selectionScope'] = {
      sessionId: routeKey,
      ownerConnectionId: 'fixture-remote-cli',
      protocol: 'v1',
      catalogGenerationIdentity: {},
    };
    const emptyBridge: ModelPickerBridge = {
      options: [],
      currentValue: '',
      currentVariant: '',
      acceptsVariant: true,
      selectionScope: emptyScope,
      isSelectionCurrent: () => true,
      onSelect: () => undefined,
      retryCatalog: () => {
        // eslint-disable-next-line no-console -- dev-only fixture feedback in the Metro log
        console.info('[model-picker-fixture] catalog retry requested');
      },
    };
    modelPickerSlot.set(routeKey, emptyBridge);
    return `/(app)/agent-chat/model-picker?routeKey=${routeKey}`;
  }

  if (/[?&]unavailable=1(?:[&#]|$)/.test(path)) {
    // `buildUnavailableRemoteOptions` in `use-session-model-options` projects a
    // remote session whose CLI reports no models as this one row, carrying the
    // session's current selection with `unavailable: true`; the picker then has
    // rows but nothing selectable.
    const unavailableOption: SessionModelOption = {
      id: 'remote-unavailable-model',
      name: 'DeepSeek V4.1 Flash',
      displayId: 'deepseek/deepseek-v4.1-flash',
      variants: [],
      isPreferred: false,
      provider: { id: 'deepseek', name: 'deepseek' },
      modelRef: { providerID: 'deepseek', modelID: 'deepseek-v4.1-flash' },
      showGatewayMetadata: false,
      unavailable: true,
    };
    const allUnavailableScope: ModelPickerBridge['selectionScope'] = {
      sessionId: routeKey,
      ownerConnectionId: 'fixture-remote-cli',
      protocol: 'v1',
      catalogGenerationIdentity: {},
    };
    const allUnavailableBridge: ModelPickerBridge = {
      options: [unavailableOption],
      currentValue: unavailableOption.id,
      currentVariant: '',
      acceptsVariant: true,
      selectionScope: allUnavailableScope,
      isSelectionCurrent: () => true,
      onSelect: selection => {
        allUnavailableBridge.currentValue = selection.option.id;
        allUnavailableBridge.currentVariant = selection.variant;
      },
    };
    modelPickerSlot.set(routeKey, allUnavailableBridge);
    return `/(app)/agent-chat/model-picker?routeKey=${routeKey}`;
  }

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
  // One priced shape per cost line the picker paints, so a catalog change to
  // `agentChat.modelCost.*` renders without a live gateway: a sub-cent side
  // shows the `lessThan` label, the others show the two-decimal shape. The
  // rows carry `pricing` with `showGatewayMetadata: true` like a gateway
  // option, because a CLI-catalog row (the flag off) ships no pricing.
  const pricedOptions: SessionModelOption[] = [
    {
      id: 'fixture-priced-sub-cent',
      name: 'Fixture Priced Sub-cent',
      displayId: 'fixture/sub-cent',
      modelRef: { providerID: 'fixture', modelID: 'sub-cent' },
      provider: { id: 'fixture', name: 'Fixture' },
      variants: [],
      isPreferred: false,
      showGatewayMetadata: true,
      pricing: { prompt: '0.000000005', completion: '0.000000014' },
    },
    {
      id: 'fixture-priced-ordinary',
      name: 'Fixture Priced Ordinary',
      displayId: 'fixture/ordinary',
      modelRef: { providerID: 'fixture', modelID: 'ordinary' },
      provider: { id: 'fixture', name: 'Fixture' },
      variants: [],
      isPreferred: false,
      showGatewayMetadata: true,
      pricing: { prompt: '0.000003', completion: '0.000014' },
    },
  ];
  const options: SessionModelOption[] = [
    ...autoOptions,
    ...pricedOptions,
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
