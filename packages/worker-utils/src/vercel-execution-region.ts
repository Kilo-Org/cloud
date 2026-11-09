export type VercelExecutionRegion = 'fra1' | 'sfo1' | 'unknown';

export function getVercelExecutionRegion(): VercelExecutionRegion {
  const region = process.env.VERCEL_REGION;
  return region === 'fra1' || region === 'sfo1' ? region : 'unknown';
}
