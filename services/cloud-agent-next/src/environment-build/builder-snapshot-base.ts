import {
  sameVercelAccount,
  vercelSnapshotBaseImage,
} from '../byoc/vercel-snapshot-compatibility.js';
import type { CompareSnapshotBase, PublishedSnapshot, SnapshotBase } from './policy.js';
import type { BuildTargetResolution } from './target.js';

/** Compare only the captured base. The coordinator checks scope, provenance and ABI. */
const baseComparisons: Record<PublishedSnapshot['provider'], CompareSnapshotBase> = {
  'cloudflare-containers': (captured, current) => {
    if (captured.runtimeRelease === null) return 'incompatible';
    return current === null || current === captured.baseImage ? 'current' : 'previous';
  },
  vercel: (captured, current) => {
    if (current === null || !sameVercelAccount(captured.baseImage, current)) return 'incompatible';
    return current === captured.baseImage ? 'current' : 'previous';
  },
  'aws-ec2': (captured, current) => (captured.baseImage === current ? 'current' : 'incompatible'),
};

export const compareBuilderSnapshotBase: CompareSnapshotBase = (captured, current) =>
  baseComparisons[captured.provider](captured, current);

export type BuilderSnapshotBaseInput =
  | { target: BuildTargetResolution | null; sandboxId: string }
  | { previous: PublishedSnapshot | null };

/** Bind the image lookup to the pinned target. During read outages use the last saved identity. */
export async function resolveBuilderSnapshotBase(
  input: BuilderSnapshotBaseInput,
  nativeImage: (sandboxId: string) => Promise<string | null>
): Promise<SnapshotBase> {
  const base = (
    provider: PublishedSnapshot['provider'],
    baseImage: string | null
  ): SnapshotBase => ({
    provider,
    baseImage,
    compareBase: compareBuilderSnapshotBase,
  });
  if ('previous' in input) {
    return base(
      input.previous?.provider ?? 'cloudflare-containers',
      input.previous?.baseImage ?? null
    );
  }
  const { target } = input;
  if (!target?.ok) return base(target?.provider ?? 'cloudflare-containers', null);
  switch (target.target.provider) {
    case 'aws-ec2':
      return base(target.target.provider, target.target.baseImage);
    case 'vercel':
      return base(target.target.provider, vercelSnapshotBaseImage(target.target));
    case 'cloudflare-containers':
      return base(target.target.provider, await nativeImage(input.sandboxId));
  }
}
