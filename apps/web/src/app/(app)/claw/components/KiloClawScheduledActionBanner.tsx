'use client';

/**
 * In-workspace banner that surfaces the soonest pending scheduled
 * admin action on this user's instance. Reads from the `scheduledAction`
 * field on `kiloclaw.getStatus`. The field is null when nothing is
 * pending, so the banner self-hides.
 *
 * Cancellation does NOT render here: once an action is cancelled the
 * `scheduledAction` field returns null and the banner disappears. Users
 * learn about the cancellation via email and mobile push (the
 * `cancelled`-kind notifications), which are dispatched only when a
 * notice was previously sent.
 */

import { CalendarClock } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { KiloClawScheduledActionStatusBlock } from '@/lib/kiloclaw/types';

type Props = {
  scheduledAction: KiloClawScheduledActionStatusBlock | null;
  /**
   * The user's name for the bot, when set. Renders as "Your bot
   * **<name>**". Null = use the generic "Your bot" phrasing (matches
   * the email's behavior when no name is set).
   */
  instanceName: string | null;
};

function formatScheduledAt(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    // Append the user's timezone abbreviation (e.g., "PDT") so the
    // banner's local-rendered time is internally unambiguous. The
    // email server-renders the same instant in UTC and labels it
    // "UTC"; both surfaces are clear about which zone they're showing,
    // so a user comparing them knows they're not the same string and
    // doesn't second-guess.
    const dateStr = d.toLocaleString();
    const tzPart = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(d)
      .find(p => p.type === 'timeZoneName')?.value;
    return tzPart ? `${dateStr} ${tzPart}` : dateStr;
  } catch {
    return iso;
  }
}

export function KiloClawScheduledActionBanner({ scheduledAction, instanceName }: Props) {
  if (!scheduledAction) return null;

  // Bake the period into the timestamp span so it doesn't wrap to its
  // own line when the column narrows. Same fix as the per-instance
  // admin indicator.
  const when = `${formatScheduledAt(scheduledAction.scheduledAt)}.`;
  const isVersionChange = scheduledAction.actionType === 'version_change';
  const targetLabel =
    isVersionChange && scheduledAction.targetImageTag
      ? scheduledAction.targetOpenclawVersion
        ? `${scheduledAction.targetImageTag} (OpenClaw ${scheduledAction.targetOpenclawVersion})`
        : scheduledAction.targetImageTag
      : null;
  const namedBot = instanceName?.trim() ? (
    <>
      Your bot <strong>{instanceName.trim()}</strong>
    </>
  ) : (
    <>Your bot</>
  );

  return (
    <Alert className="border-yellow-500/30 bg-yellow-500/5">
      <CalendarClock className="h-4 w-4 text-yellow-400" />
      <AlertDescription>
        {isVersionChange ? (
          <>
            {namedBot} is scheduled to upgrade
            {targetLabel ? (
              <>
                {' '}
                to <code className="font-mono text-xs">{targetLabel}</code>
              </>
            ) : null}{' '}
            at <span className="font-mono">{when}</span> It will be briefly offline during the
            upgrade.
          </>
        ) : (
          <>
            {namedBot} is scheduled to restart at <span className="font-mono">{when}</span> It will
            be briefly offline during the restart.
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}
