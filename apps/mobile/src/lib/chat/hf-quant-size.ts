/**
 * Bytes per weight of each quantization family, read from the sizes of real
 * repositories: a file far below it cannot hold the parameters the repository
 * states, so it is not a complete quantization of that model.
 */
const BYTES_PER_PARAMETER = {
  q1: 0.23,
  iq1: 0.23,
  iq2: 0.34,
  q2: 0.34,
  tq1: 0.22,
  tq2: 0.3,
  iq3: 0.48,
  q3: 0.48,
  iq4: 0.6,
  q4: 0.6,
  q5: 0.71,
  q6: 0.82,
  iq8: 1.06,
  q8: 1.06,
  mxfp4: 0.6,
  bf16: 2,
  f16: 2,
  fp16: 2,
  f32: 4,
  fp32: 4,
} satisfies Record<string, number>;

/** The longest family that prefixes the label: `iq4_xs` reads as `iq4`, not `q4`. */
const FAMILIES = Object.keys(BYTES_PER_PARAMETER).sort((a, b) => b.length - a.length);

export function bytesPerParameterOf(quant: string): number | undefined {
  const normalized = quant.toLowerCase().replace(/^ud-/, '');
  const family = FAMILIES.find(candidate => normalized.startsWith(candidate));
  return family === undefined
    ? undefined
    : BYTES_PER_PARAMETER[family as keyof typeof BYTES_PER_PARAMETER];
}
