// Model ids may be prefixed with a leading '~' to indicate a routing variant
// (e.g. '~anthropic/claude-sonnet-4.5' is the same underlying model as
// 'anthropic/claude-sonnet-4.5'). Any code that keys off a provider prefix
// such as 'anthropic/' or 'openai/' should treat both forms equivalently.
export function modelStartsWith(model: string, prefix: string) {
  return model.startsWith(prefix) || model.startsWith(`~${prefix}`);
}

export function stripModelTilde(model: string) {
  return model.startsWith('~') ? model.slice(1) : model;
}
