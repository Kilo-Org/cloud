import type { Hono } from 'hono';
import type { HonoContext } from '../hono-context.js';
import {
  WORKSPACE_ARTIFACT_MAX_FILE_BYTES,
  WORKSPACE_ARTIFACT_SHA256_HEADER,
  validateWorkspaceArtifactPath,
  workspaceArtifactContentHashSchema,
  workspaceArtifactContentType,
} from '../shared/workspace-artifacts.js';
import {
  authorizeTransfer,
  declaredLength,
  streamToBucket,
  type StreamToBucketResult,
} from './sandbox-transfer-http.js';
import { getSandboxControlStub } from './stub.js';

const BASE = '/sandbox-transfer/:sandboxId/:allocationId/:wrapperInstanceId/artifacts';

function streamFailure(result: StreamToBucketResult): Response | null {
  switch (result.status) {
    case 'stored':
      return null;
    case 'missing_length':
      return Response.json({ error: 'Content-Length required' }, { status: 411 });
    case 'invalid_length':
      return Response.json({ error: 'Invalid Content-Length' }, { status: 400 });
    case 'too_large':
      return Response.json({ error: 'File too large' }, { status: 413 });
    case 'missing_body':
      return Response.json({ error: 'Missing request body' }, { status: 400 });
    case 'hash_mismatch':
      return Response.json({ error: 'Content hash mismatch' }, { status: 422 });
    case 'storage_unavailable':
      return Response.json({ error: 'Artifact storage unavailable' }, { status: 503 });
  }
}

export function registerWorkspaceArtifactRoutes(app: Hono<HonoContext>): void {
  app.put(`${BASE}/objects`, async c => {
    const authorized = await authorizeTransfer(c, 'workspace_artifacts');
    if (authorized instanceof Response) return authorized;

    const relativePath = c.req.query('path');
    const path = relativePath === undefined ? null : validateWorkspaceArtifactPath(relativePath);
    if (path === null || !path.ok) {
      return Response.json({ error: 'Invalid artifact path' }, { status: 400 });
    }

    const length = declaredLength(c.req.header('Content-Length'));
    if (length === undefined) {
      return Response.json({ error: 'Content-Length required' }, { status: 411 });
    }
    if (length === 'invalid') {
      return Response.json({ error: 'Invalid Content-Length' }, { status: 400 });
    }
    if (length > WORKSPACE_ARTIFACT_MAX_FILE_BYTES) {
      return Response.json({ error: 'File too large' }, { status: 413 });
    }

    const contentHash = workspaceArtifactContentHashSchema.safeParse(
      c.req.header(WORKSPACE_ARTIFACT_SHA256_HEADER)
    );
    if (!contentHash.success) {
      return Response.json({ error: 'Invalid content hash' }, { status: 400 });
    }

    const identity = authorized.identity;
    const stub = getSandboxControlStub(c.env, identity.sandboxId);
    const reserved = await stub.reserveWorkspaceArtifactUpload(identity, {
      relativePath: path.relativePath,
      sizeBytes: length,
    });
    if (reserved.status === 'stale') {
      return Response.json({ status: reserved.status }, { status: 409 });
    }
    if (reserved.status === 'not_connected') {
      return Response.json({ status: reserved.status }, { status: 503 });
    }
    if (reserved.status === 'quota_exceeded') {
      return Response.json({ status: reserved.status }, { status: 413 });
    }
    if (reserved.status === 'invalid_path') {
      return Response.json({ status: reserved.status }, { status: 400 });
    }

    const contentType = workspaceArtifactContentType(path.relativePath);
    const stored = await streamToBucket(
      c.env.WORKSPACE_ARTIFACTS_BUCKET,
      reserved.objectKey,
      c.req.raw,
      {
        maxBytes: WORKSPACE_ARTIFACT_MAX_FILE_BYTES,
        sha256: contentHash.data,
        contentType,
        customMetadata: { sandboxId: identity.sandboxId, sha256: contentHash.data },
      }
    );
    const streamError = streamFailure(stored);
    if (streamError !== null) return streamError;

    const committed = await stub.commitWorkspaceArtifact(identity, {
      relativePath: path.relativePath,
      objectKey: reserved.objectKey,
      contentHash: contentHash.data,
      sizeBytes: length,
      contentType,
    });
    switch (committed.status) {
      case 'committed':
      case 'unchanged':
        return Response.json(committed, { status: 200 });
      case 'stale':
        return Response.json({ status: committed.status }, { status: 409 });
      case 'not_connected':
      case 'reservation_missing':
      case 'reservation_expired':
        return Response.json({ status: committed.status }, { status: 503 });
      case 'quota_exceeded':
        return Response.json({ status: committed.status }, { status: 413 });
      case 'invalid_path':
        return Response.json({ status: committed.status }, { status: 400 });
    }
  });

  app.delete(`${BASE}/objects`, async c => {
    const authorized = await authorizeTransfer(c, 'workspace_artifacts');
    if (authorized instanceof Response) return authorized;

    const relativePath = c.req.query('path');
    const path = relativePath === undefined ? null : validateWorkspaceArtifactPath(relativePath);
    if (path === null || !path.ok) {
      return Response.json({ error: 'Invalid artifact path' }, { status: 400 });
    }
    const expectedHash = workspaceArtifactContentHashSchema.safeParse(c.req.query('hash'));
    if (!expectedHash.success) {
      return Response.json({ error: 'Invalid content hash' }, { status: 400 });
    }

    const identity = authorized.identity;
    const stub = getSandboxControlStub(c.env, identity.sandboxId);
    const result = await stub.deleteWorkspaceArtifact(identity, {
      relativePath: path.relativePath,
      expectedHash: expectedHash.data,
    });
    if (result.status === 'stale') {
      return Response.json({ status: result.status }, { status: 409 });
    }
    if (result.status === 'not_connected') {
      return Response.json({ status: result.status }, { status: 503 });
    }
    return Response.json(result, { status: 200 });
  });
}
