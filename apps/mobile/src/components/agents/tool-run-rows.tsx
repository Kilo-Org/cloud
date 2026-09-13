import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { useTranslation } from 'react-i18next';
import { Rows3 } from '@/components/ui/icons';

import { FixedPartRow } from './fixed-part-row';
import { useOpenPartDetail } from './open-part-detail-context';
import { useOpenToolRun } from './open-tool-run-context';
import { buildToolRunLabel, buildToolRunRows } from './session-tool-run';
import { getToolDisplay, getToolRowIcon } from './tool-card-display';

/**
 * One-line rendering of a single tool part: the same `FixedPartRow` chrome the
 * tool's own card shows. The default press opens the existing part detail sheet.
 */
export function ToolOneLineRow({
  part,
  onPress,
}: Readonly<{ part: ToolPart; onPress?: () => void }>) {
  const { t } = useTranslation();
  const openPartDetail = useOpenPartDetail();
  const display = getToolDisplay(part);
  const label = display.subtitle ?? display.title;
  const defaultPress = openPartDetail
    ? () => {
        openPartDetail(part.id);
      }
    : undefined;

  return (
    <FixedPartRow
      icon={getToolRowIcon(part.tool)}
      label={label}
      {...(display.badge !== undefined ? { badge: display.badge } : {})}
      status={part.state.status}
      accessibilityLabel={t('agentChat.toolCard.accessibilityLabel', {
        name: label,
        status: part.state.status,
      })}
      onPress={onPress ?? defaultPress}
    />
  );
}

/**
 * Condensed row for a run of tool parts: one `Rows3` row whose label reads
 * "<count> items; <last>", with the last part's status so a streaming run keeps
 * the running spinner and a failed last call shows the error icon. A one-part
 * run falls back to the unchanged single-tool row.
 */
export function CondensedToolRunRow({ parts }: Readonly<{ parts: readonly ToolPart[] }>) {
  const { t } = useTranslation();
  const openToolRun = useOpenToolRun();

  if (parts.length === 1) {
    const only = parts[0];
    return only ? <ToolOneLineRow part={only} /> : null;
  }

  const rows = buildToolRunRows(parts);
  const label = buildToolRunLabel(rows, t);
  const lastStatus = parts.at(-1)?.state.status;

  return (
    <FixedPartRow
      icon={Rows3}
      label={label}
      status={lastStatus}
      accessibilityLabel={label}
      onPress={
        openToolRun
          ? () => {
              openToolRun(parts);
            }
          : undefined
      }
    />
  );
}
