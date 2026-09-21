export function gateResultFromProperties(
  properties: Record<string, unknown>
): 'pass' | 'fail' | undefined {
  const gateResult = properties.gateResult;
  return gateResult === 'pass' || gateResult === 'fail' ? gateResult : undefined;
}
