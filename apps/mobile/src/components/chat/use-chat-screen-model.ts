import { type Effort } from '@kilocode/harness-sdk';
import { type TFunction } from 'i18next';
import { useState } from 'react';

import { type EffortChoices, effortOfVariant, variantOfEffort } from '@/lib/chat/effort';
import { switchChatModel } from '@/lib/chat/model-switch';
import { type ModelOption } from '@/lib/hooks/use-available-models';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

/**
 * The model one open chat sends with. It starts as the one the conversation
 * is on and changes the moment the person picks another, which is what makes
 * the switch apply to the next message and not to what was already said. The
 * effort works the same way: a reopened chat shows the one it was opened with.
 */

/** What the chat screen's composer and header read from the picker. */
export type ChatScreenModel = {
  readonly model: string;
  readonly variant: string;
  readonly effort: Effort | null;
  readonly selectModel: (modelId: string, variantId: string | null) => void;
  readonly selectProviderModel: (modelId: string) => void;
};

export function useChatScreenModel(input: {
  readonly currentModel: string;
  readonly currentEffort: Effort | null;
  readonly options: readonly SessionModelOption[];
  readonly gatewayModels: readonly ModelOption[];
  readonly t: TFunction;
}): ChatScreenModel {
  const { currentModel, currentEffort, options, gatewayModels, t } = input;
  const [picked, setPicked] = useState<string | null>(null);
  const [pickedVariant, setPickedVariant] = useState<string | null>(null);
  const model = picked ?? currentModel;
  const pickedOption = options.find(option => option.id === model);
  const choices: EffortChoices = {
    variants: pickedOption?.variants ?? [],
    efforts: gatewayModels.find(option => option.id === model)?.variantEfforts,
  };
  const variant = pickedVariant ?? variantOfEffort(choices, currentEffort);
  // Until the list loads, the chat keeps the effort it was opened with rather
  // than dropping it for a model the screen cannot see yet.
  const effort = pickedOption === undefined ? currentEffort : effortOfVariant(choices, variant);

  const selectModel = (modelId: string, variantId: string | null) => {
    switchChatModel({
      currentModel: model,
      nextModel: modelId,
      nextModelName: options.find(option => option.id === modelId)?.name ?? modelId,
      t,
      accept: () => {
        setPicked(modelId);
        setPickedVariant(variantId);
      },
    });
  };

  // The provider control chooses the model this chat sends to, so the choice
  // goes through the same disclosure-protected switch the model picker uses. It
  // picks no thinking variant, so the chat's stored effort resolves the variant
  // the chosen model offers.
  const selectProviderModel = (modelId: string) => {
    selectModel(modelId, null);
  };

  return { model, variant, effort, selectModel, selectProviderModel };
}
