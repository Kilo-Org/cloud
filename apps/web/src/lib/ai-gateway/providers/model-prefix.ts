// Model ids may be prefixed with a leading '~' to indicate a routing variant
// whose concrete target can differ from the untilded id — for example,
// '~anthropic/claude-haiku-latest' may route to 'anthropic/claude-haiku-4.5'.
// Any code that keys off a provider prefix such as 'anthropic/' or 'openai/'
// should still treat both forms equivalently.
export function modelStartsWith(model: string, prefix: string) {
  return model.startsWith(prefix) || model.startsWith(`~${prefix}`);
}

export function stripModelTilde(model: string) {
  return model.startsWith('~') ? model.slice(1) : model;
}
