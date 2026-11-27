import { z } from 'zod';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';

export const snapshotProviderSchema = z.enum(['cloudflare-containers', 'vercel', 'aws-ec2']);
export type SnapshotProvider = z.infer<typeof snapshotProviderSchema>;

export const workspaceSnapshotIdentitySchema = z.object({
  sandboxId: z.string().min(1),
  workspaceId: cloudAgentWorktreeIdSchema,
  directory: z.string().min(1),
  userId: z.string().min(1),
  orgId: z.string().optional(),
});
export type WorkspaceSnapshotIdentity = z.infer<typeof workspaceSnapshotIdentitySchema>;

type SnapshotArtifact = {
  provider: SnapshotProvider;
  snapshotId: string;
  /** The base image identity recorded at capture. */
  baseImage: string;
};

/** A published artifact chosen by the control plane after scope validation. */
export type SnapshotRestoreRequest = SnapshotArtifact &
  (
    | { kind: 'environment'; buildId: string; currentBaseImage?: string }
    | {
        kind: 'workspace';
        workspace: WorkspaceSnapshotIdentity;
        sourceAllocationId: string;
        captureId?: string;
        currentBaseImage: string;
      }
  );

export type WorkspaceSnapshotCaptureRequest = {
  captureId: string;
  workspace: WorkspaceSnapshotIdentity;
  allocationId: string;
  connectionId: string;
  signal: AbortSignal;
  isCurrent(): Promise<boolean>;
};

/**
 * Why a provider could not start from a snapshot artifact. Permanent reasons
 * fail the route at once; `transient` is retried by the Sandbox DO against the
 * same artifact within the preparation deadline.
 */
export const SNAPSHOT_START_FAILURE_REASONS = [
  'transient',
  'expired',
  'missing',
  'image_mismatch',
  'provenance',
  'unsupported',
] as const;
export type SnapshotStartFailureReason = (typeof SNAPSHOT_START_FAILURE_REASONS)[number];

export type SnapshotLaunchDiagnosticContext = {
  allocationId: string;
  source: 'environment' | 'workspace' | 'image';
  attempt: number;
  startedAt: number;
};

export const snapshotStartFailureReasonSchema = z.enum(SNAPSHOT_START_FAILURE_REASONS);

export function snapshotStartFailureIsPermanent(reason: SnapshotStartFailureReason): boolean {
  return reason !== 'transient';
}

export const snapshotCaptureFailureSchema = z.enum([
  'not_running',
  'abandoned',
  'snapshot_failed',
  'uncertain',
]);

/** What a capture caller learns. `in_progress` only while this isolate still awaits it. */
export type SnapshotCaptureResult =
  | {
      status: 'stored';
      snapshotId: string;
      size?: number;
      capturedAt: number;
      baseImage: string;
      durationMs: number;
    }
  | { status: 'failed'; reason: z.infer<typeof snapshotCaptureFailureSchema> }
  | { status: 'in_progress' };
