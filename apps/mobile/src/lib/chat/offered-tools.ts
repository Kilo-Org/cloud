import { type JsonSchema, type ToolDefinition } from '@kilocode/harness-sdk';
import { waitField } from '@kilocode/harness-sdk/core';

/**
 * The arguments of one tool without the harness's `wait` field.
 *
 * The field belongs to the harness and not to the tool: it is added to every
 * tool, and the model sets it to choose whether the harness waits for a call.
 * A model that runs on the device is small, and a small model reads the field
 * as an invitation and answers it false, which sends its own call to the
 * background and leaves a note where the answer should be. Whether to wait is
 * not the model's to decide here, so the field never reaches it.
 */
function withoutWaitField(parameters: JsonSchema): JsonSchema {
  const { [waitField]: _wait, ...properties } = parameters.properties;
  return { ...parameters, properties };
}

/**
 * The tools a model that runs on the device is offered: the ones the harness
 * assembled with every field the harness adds taken off again. Every on-device
 * client goes through this, so none of them can drift from the others.
 */
export function offeredTools(tools: readonly ToolDefinition[]): readonly ToolDefinition[] {
  return tools.map(tool => ({ ...tool, parameters: withoutWaitField(tool.parameters) }));
}
