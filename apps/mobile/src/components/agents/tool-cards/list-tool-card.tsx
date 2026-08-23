import { View } from 'react-native';
import { FolderOpen } from '@/components/ui/icons';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { useTranslation } from 'react-i18next';

import { SelectableText } from '@/components/ui/selectable-text';

import { FixedPartRow } from '../fixed-part-row';
import { useOpenPartDetail } from '../open-part-detail-context';
import { getToolDisplay, toolPartHasDetails } from '../tool-card-display';
import { buildResultRowsModel } from '../tool-list-model';
import { ToolResultRows } from '../tool-result-rows';

/**
 * Sheet body for a list tool part: one plain row per output line, plus the
 * error. Renders only inside the detail sheet — attachments and the
 * pending/running status line live in `ToolPartDetailBody`.
 */
export function ListToolCardBody({ part }: Readonly<{ part: ToolPart }>) {
  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;
  const resultModel = output ? buildResultRowsModel(output, 'list') : undefined;

  return (
    <View className="gap-2">
      {resultModel ? (
        <ToolResultRows
          caption={resultModel.caption}
          rows={resultModel.rows}
          truncated={resultModel.truncated}
        />
      ) : null}
      {error ? <SelectableText className="text-xs text-destructive">{error}</SelectableText> : null}
    </View>
  );
}

export function ListToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const openPartDetail = useOpenPartDetail();
  const { t } = useTranslation();
  const display = getToolDisplay(part);
  const hasDetails = toolPartHasDetails(part);

  return (
    <FixedPartRow
      icon={FolderOpen}
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
