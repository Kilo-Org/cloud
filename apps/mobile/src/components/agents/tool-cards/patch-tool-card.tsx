import { useMemo } from 'react';
import { View } from 'react-native';
import { FileDiff } from '@/components/ui/icons';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { useTranslation } from 'react-i18next';

import { SelectableText } from '@/components/ui/selectable-text';

import { FixedPartRow } from '../fixed-part-row';
import { useOpenPartDetail } from '../open-part-detail-context';
import { getToolDisplay, toolPartHasDetails } from '../tool-card-display';
import { buildToolPatchModel } from '../tool-patch-model';
import { ToolPatchPreview } from '../tool-patch-preview';
import { GenericToolCardBody } from './generic-tool-card';

// Bound for the generic fallback's input JSON block. A giant unparseable
// `patchText` must not hang the sheet; parseable patches are bounded by the
// patch model's file/line caps instead.
const PATCH_FALLBACK_CHARACTER_CAP = 100_000;

/**
 * Sheet body for a patch tool part: the diff preview when the model exists,
 * else the bounded generic fallback. The model is null when the tool is not
 * a patch name, `patchText` is absent, or the envelope does not parse — the
 * generic body prints the input JSON so the sheet is never empty. No status
 * gate: parseable input previews during pending/running like edit/write.
 *
 * Error state renders exactly one red line: the preview path renders it
 * here, the fallback path leaves it to `GenericToolCardBody`.
 */
export function PatchToolCardBody({ part }: Readonly<{ part: ToolPart }>) {
  const diffModel = useMemo(() => buildToolPatchModel(part), [part]);

  if (diffModel) {
    const error = part.state.status === 'error' ? part.state.error : undefined;
    return (
      <View className="gap-2">
        <ToolPatchPreview model={diffModel} partId={part.id} />
        {error ? (
          <SelectableText className="text-xs text-destructive">{error}</SelectableText>
        ) : null}
      </View>
    );
  }

  return <GenericToolCardBody part={part} inputMaxLength={PATCH_FALLBACK_CHARACTER_CAP} />;
}

export function PatchToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const openPartDetail = useOpenPartDetail();
  const { t } = useTranslation();
  const display = getToolDisplay(part);
  const hasDetails = toolPartHasDetails(part);

  return (
    <FixedPartRow
      icon={FileDiff}
      label={display.subtitle ?? display.title}
      status={part.state.status}
      accessibilityLabel={t('agentChat.toolCard.accessibilityLabel', {
        name: display.subtitle ?? display.title,
        status: part.state.status,
      })}
      onPress={
        hasDetails && openPartDetail
          ? () => {
              openPartDetail(part.id);
            }
          : undefined
      }
    />
  );
}
