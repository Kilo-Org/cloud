import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { useTranslation } from 'react-i18next';
import { Rows3 } from '@/components/ui/icons';

import { useToolSummaryTranslation } from '@/lib/tool-summary-translation/use-translated-tool-summary';

import { FixedPartRow } from './fixed-part-row';
import { useOpenPartDetail } from './open-part-detail-context';
import { useOpenToolRun } from './open-tool-run-context';
import { buildToolRunCountLabel, buildToolRunLabel, buildToolRunRows } from './session-tool-run';
import { getToolDisplay } from './tool-card-display';
import { getToolRowIcon } from './tool-row-icon';
import { ToolSummaryTranslationScope } from './tool-summary-translation-scope';

/**
 * One-line rendering of a single tool part: the same `FixedPartRow` chrome the
 * tool's own card shows. The default press opens the existing part detail sheet.
 * The scope marks the row as a tool summary, so its label takes the same
 * translation path the part's card takes on the session page.
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
    <ToolSummaryTranslationScope itemId={part.id}>
      <FixedPartRow
        icon={getToolRowIcon(part.tool)}
        label={label}
        translatable={display.translatable}
        {...(display.badge !== undefined ? { badge: display.badge } : {})}
        status={part.state.status}
        accessibilityLabel={t('agentChat.toolCard.accessibilityLabel', {
          name: label,
          status: part.state.status,
        })}
        onPress={onPress ?? defaultPress}
      />
    </ToolSummaryTranslationScope>
  );
}

/**
 * Condensed row for a run of tool parts: one `Rows3` row whose label reads
 * "<count> items; <last>", with the last part's status so a streaming run keeps
 * the running spinner and a failed last call shows the error icon. A one-part
 * run falls back to the unchanged single-tool row.
 *
 * The last summary is translated on its own, like the part's own card, and the
 * count keeps the localized `condensedLabel` copy. While that translation is on
 * its way the label carries the count alone: the raw English summary inside an
 * otherwise translated sentence reads as a glitch, so the row waits for the
 * summary the app would show. A failed request does not end that wait:
 * `useToolSummaryTranslation` re-asks while the row stays mounted, so the label
 * resolves once the gateway answers again.
 */
export function CondensedToolRunRow({ parts }: Readonly<{ parts: readonly ToolPart[] }>) {
  const { t } = useTranslation();
  const openToolRun = useOpenToolRun();
  const rows = buildToolRunRows(parts);
  const last = rows.at(-1);
  // A one-part run never reaches this component from a transcript, so the
  // translation request is skipped there rather than made for a row that its
  // own single-part path renders.
  const translation = useToolSummaryTranslation(
    last?.label ?? '',
    parts.length > 1 && last?.translatable === true
  );

  if (parts.length === 1) {
    const only = parts[0];
    return only ? <ToolOneLineRow part={only} /> : null;
  }

  // `pending` is not final: the hook keeps re-asking while this row is mounted,
  // so the count-only label resolves as soon as the translation lands.
  const label = translation.pending
    ? buildToolRunCountLabel(rows, t)
    : buildToolRunLabel(rows, t, translation.text);

  return (
    <FixedPartRow
      icon={Rows3}
      label={label}
      // The label is final: its count is localized copy and its summary already
      // took the translation path above, so the shared row must not send the
      // assembled sentence to the gateway.
      translatable={false}
      status={last?.status}
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
