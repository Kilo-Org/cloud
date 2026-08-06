import { View } from 'react-native';
import { Search } from 'lucide-react-native';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';

import { SelectableText } from '@/components/ui/selectable-text';

import { FixedPartRow } from '../fixed-part-row';
import { useOpenPartDetail } from '../open-part-detail-context';
import { getToolDisplay, toolPartHasDetails } from '../tool-card-display';
import { buildResultRowsModel } from '../tool-list-model';
import { ToolResultRows } from '../tool-result-rows';

/**
 * Sheet body for a glob tool part: one row per matched path with the `Found N`
 * summary as a muted caption (the `---` separator and truncation marker fold
 * into the model), plus the error. Renders only inside the detail sheet —
 * attachments and the pending/running status line live in `ToolPartDetailBody`.
 */
export function GlobToolCardBody({ part }: Readonly<{ part: ToolPart }>) {
  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;
  const resultModel = output ? buildResultRowsModel(output, 'glob') : undefined;

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

export function GlobToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const openPartDetail = useOpenPartDetail();
  const display = getToolDisplay(part);
  const hasDetails = toolPartHasDetails(part);

  return (
    <FixedPartRow
      icon={Search}
      label={display.subtitle ?? display.title}
      {...(display.badge ? { badge: display.badge } : {})}
      status={part.state.status}
      accessibilityLabel={`${display.subtitle ?? display.title} tool, ${part.state.status}`}
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
