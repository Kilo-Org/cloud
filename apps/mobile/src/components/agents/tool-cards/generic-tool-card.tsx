import { View } from 'react-native';
import { Plug } from '@/components/ui/icons';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { buildToolDetail } from '@kilocode/app-shared/tool-detail';
import { useTranslation } from 'react-i18next';

import { SelectableText } from '@/components/ui/selectable-text';
import { Text } from '@/components/ui/text';

import { FixedPartRow } from '../fixed-part-row';
import { MonoScrollBlock } from '../mono-scroll-block';
import { useOpenPartDetail } from '../open-part-detail-context';
import { getToolFileAttachments, getToolImageAttachments } from '../tool-card-attachments';
import { getToolDisplay, toolPartHasDetails } from '../tool-card-display';

/**
 * Sheet body for a generic tool part (including unknown tools): one labelled
 * row per projected argument (or question) field, the formatted output, and the
 * error. A terminal part with none of those — an unknown tool that took no
 * arguments and returned nothing — still shows a muted `No output.` line, so the
 * sheet never opens as an empty region under its header. A failed part shows
 * its error line in place of that empty line, even when the message is blank,
 * so a failed call never reads as a successful empty result. Renders only inside
 * the detail sheet — attachments and the pending/running status line live in
 * `ToolPartDetailBody`.
 *
 * `inputMaxLength` caps each field value; it is set by the patch card's
 * fallback so a giant unparseable `patchText` cannot hang the sheet. Every
 * other caller leaves it undefined and gets the shared default cap.
 */
export function GenericToolCardBody({
  part,
  inputMaxLength,
}: Readonly<{ part: ToolPart; inputMaxLength?: number }>) {
  const { t } = useTranslation();
  const detail = buildToolDetail(part, { valueMaxLength: inputMaxLength });
  // Attachments render above this body in the dispatcher and are themselves
  // output, so their presence keeps the `No output.` line off. Pending and
  // running parts already carry the dispatcher's status line, so only a
  // terminal part with nothing else to show needs the empty state.
  const hasAttachments =
    getToolImageAttachments(part).length + getToolFileAttachments(part).length > 0;
  // The status, not the message text, decides whether the part failed. A blank
  // error message therefore still shows a failure line (falling back to a plain
  // label) rather than the `No output.` line, which would read as a successful
  // empty result.
  let errorText: string | undefined = detail.status === 'error' ? detail.error : undefined;
  if (errorText?.trim().length === 0) {
    errorText = t('common.failed');
  }
  const showEmptyState =
    detail.fields.length === 0 &&
    detail.output === undefined &&
    errorText === undefined &&
    !hasAttachments &&
    detail.status !== 'pending' &&
    detail.status !== 'running';

  return (
    <View className="gap-2">
      {detail.fields.map((field, index) => (
        <View key={`${field.key}-${index}`} className="gap-1">
          <Text className="text-xs text-muted-foreground">{field.key}</Text>
          <SelectableText className="font-mono text-xs text-foreground">
            {field.value}
          </SelectableText>
        </View>
      ))}
      {detail.output ? (
        <MonoScrollBlock content={detail.output.text} textClassName="text-foreground" />
      ) : null}
      {errorText ? (
        <SelectableText className="text-xs text-destructive">{errorText}</SelectableText>
      ) : null}
      {showEmptyState ? (
        <SelectableText className="text-sm text-muted-foreground">
          {t('agentChat.toolCard.noOutput')}
        </SelectableText>
      ) : null}
    </View>
  );
}

export function GenericToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const openPartDetail = useOpenPartDetail();
  const { t } = useTranslation();
  const display = getToolDisplay(part);
  const hasDetails = toolPartHasDetails(part);

  return (
    <FixedPartRow
      icon={Plug}
      label={display.subtitle ?? display.title}
      translatable={display.translatable}
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
