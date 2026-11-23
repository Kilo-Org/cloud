import type { ControlPlaneSetupCommandKind } from '../../shared/control-plane-protocol.js';
import type { PreparationStepSnapshot } from '../../shared/protocol.js';

const SETUP_COMMAND_LABELS: Record<ControlPlaneSetupCommandKind, string> = {
  build: 'Build command',
  session_setup: 'Session setup command',
  start: 'Start command',
};
const COMMAND_SEPARATOR = ' · `';

export function setupCommandLabel(
  kind: ControlPlaneSetupCommandKind | undefined,
  command: number,
  commandText: string | undefined
): string {
  const name = kind === undefined ? 'Setup command' : SETUP_COMMAND_LABELS[kind];
  return commandText === undefined
    ? `${name} ${command}`
    : `${name} ${command}${COMMAND_SEPARATOR}${commandText}\``;
}

export function labelWithoutCommand(step: PreparationStepSnapshot): string {
  if (step.kind !== 'setup_command') return step.label;
  const separator = step.label.indexOf(COMMAND_SEPARATOR);
  return separator === -1 ? step.label : step.label.slice(0, separator);
}
