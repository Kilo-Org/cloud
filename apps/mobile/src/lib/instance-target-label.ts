import { type ResolvedSession } from '@kilocode/cloud-agent-sdk';

import { i18n } from '@/i18n';
import { type InstancePickerInstance } from '@/lib/picker-bridge';

/**
 * The target label the new-session instance picker shows for a connected CLI
 * instance (`InstanceSelector`). Shared so the picker and the session context
 * sheet's "Run on" row can never drift.
 */
export function formatInstanceTarget(
  instance: Pick<InstancePickerInstance, 'name' | 'projectName'>
): string {
  return `${instance.name} · ${instance.projectName}`;
}

/** The picker's label for its default Cloud Agent target. */
export function cloudAgentTargetLabel(): string {
  return i18n.t('agentChat.instancePicker.cloudAgent');
}

/**
 * The target a live session runs on, labelled exactly as the new-session
 * picker labels that target: `<name> · <project>` for a connected CLI
 * instance, or the Cloud Agent label.
 *
 * `null` when the session is not live (`read-only` or not resolved yet) or a
 * live CLI target cannot be matched to a connected instance.
 */
export function resolveRunningOnLabel(input: {
  activeSessionType: ResolvedSession['type'] | null;
  ownerConnectionId: string | null;
  instances: readonly InstancePickerInstance[];
}): string | null {
  if (input.activeSessionType === 'cloud-agent') {
    return cloudAgentTargetLabel();
  }
  if (input.activeSessionType !== 'remote' || input.ownerConnectionId === null) {
    return null;
  }
  const instance = input.instances.find(
    candidate => candidate.connectionId === input.ownerConnectionId
  );
  return instance ? formatInstanceTarget(instance) : null;
}
