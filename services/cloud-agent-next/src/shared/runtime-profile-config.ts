import type { RuntimeAgentInput, RuntimeKiloCommandInput } from './runtime-profile.js';
import { normalizeKilocodeModel } from './model-utils.js';

export function buildAgentEntryFromRuntimeAgent(agent: RuntimeAgentInput): Record<string, unknown> {
  const { config } = agent;
  const entry: Record<string, unknown> = {
    mode: config.mode ?? 'primary',
  };
  if (config.prompt !== undefined) entry.prompt = config.prompt;
  if (config.description !== undefined) entry.description = config.description;
  if (config.model != null) entry.model = normalizeKilocodeModel(config.model);
  if (config.variant !== undefined) entry.variant = config.variant;
  if (config.temperature !== undefined) entry.temperature = config.temperature;
  if (config.top_p !== undefined) entry.top_p = config.top_p;
  if (config.steps !== undefined) entry.steps = config.steps;
  if (config.hidden !== undefined) entry.hidden = config.hidden;
  if (config.disable !== undefined) entry.disable = config.disable;
  if (config.color !== undefined) entry.color = config.color;
  if (config.permission !== undefined) entry.permission = config.permission;
  if (config.options !== undefined) entry.options = config.options;
  return entry;
}

export function buildKiloCommandsConfiguration(commands: readonly RuntimeKiloCommandInput[]) {
  return Object.fromEntries(
    commands.map(command => [
      command.name,
      {
        template: command.template,
        ...(command.description && { description: command.description }),
        ...(command.agent && { agent: command.agent }),
        ...(command.model && { model: normalizeKilocodeModel(command.model) }),
        subtask: command.subtask ?? false,
      },
    ])
  );
}
