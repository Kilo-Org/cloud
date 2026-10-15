import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import {
  RUNTIME_ARTIFACT_GRANT_SECONDS,
  mintRuntimeArtifactGrant,
  runtimeArtifactGrantAllows,
  validateRuntimeArtifactGrant,
} from './runtime-artifact-grant.js';
import { decodeCloudflareProviderRef, encodeCloudflareProviderRef } from './cloudflare-provider.js';

const SECRET = 'test-secret';
const HASHES: [string, string] = ['a'.repeat(64), 'b'.repeat(64)];

describe('runtime artifact read grant', () => {
  it('authorizes exactly the two signed hashes', () => {
    const token = mintRuntimeArtifactGrant({ hashes: HASHES, allocationId: 'alloc-1' }, SECRET);
    const grant = validateRuntimeArtifactGrant(`Bearer ${token}`, SECRET);
    expect(grant).toEqual({ hashes: HASHES, allocationId: 'alloc-1' });
    expect(runtimeArtifactGrantAllows(grant!, HASHES[0])).toBe(true);
    expect(runtimeArtifactGrantAllows(grant!, HASHES[1])).toBe(true);
    expect(runtimeArtifactGrantAllows(grant!, 'c'.repeat(64))).toBe(false);
  });

  it('rejects a different audience, including a log-upload token', () => {
    const otherAudience = jwt.sign({ type: 'runtime_artifact_read', hashes: HASHES }, SECRET, {
      algorithm: 'HS256',
      audience: 'cloud-agent-control-log-upload',
      expiresIn: 60,
    });
    expect(validateRuntimeArtifactGrant(`Bearer ${otherAudience}`, SECRET)).toBeUndefined();

    const logGrant = jwt.sign({ type: 'control_log_upload' }, SECRET, {
      algorithm: 'HS256',
      audience: 'cloud-agent-control-log-upload',
      expiresIn: 60,
    });
    expect(validateRuntimeArtifactGrant(`Bearer ${logGrant}`, SECRET)).toBeUndefined();
  });

  it('rejects an expired or over-long-lived token', () => {
    const expired = jwt.sign({ type: 'runtime_artifact_read', hashes: HASHES }, SECRET, {
      algorithm: 'HS256',
      audience: 'cloud-agent-runtime-artifact-read',
      expiresIn: -10,
    });
    expect(validateRuntimeArtifactGrant(`Bearer ${expired}`, SECRET)).toBeUndefined();

    const tooLong = jwt.sign({ type: 'runtime_artifact_read', hashes: HASHES }, SECRET, {
      algorithm: 'HS256',
      audience: 'cloud-agent-runtime-artifact-read',
      expiresIn: RUNTIME_ARTIFACT_GRANT_SECONDS + 1,
    });
    expect(validateRuntimeArtifactGrant(`Bearer ${tooLong}`, SECRET)).toBeUndefined();
  });

  it('mints with the decoded allocation identity, not the >128-byte encoded provider ref', () => {
    // D measured the real encoded ref at 184 bytes; the grant schema caps
    // `allocationId` at 128, so the raw ref makes every real GET 401.
    const encoded = encodeCloudflareProviderRef({
      sandboxId: 'sbx__workspace_11111111-1111-1111-1111-111111111111',
      containment: true,
      instanceId: '22222222-2222-2222-2222-222222222222',
    });
    expect(encoded.length).toBeGreaterThan(128);
    const decoded = decodeCloudflareProviderRef(encoded);
    expect(decoded?.instanceId).toBe('22222222-2222-2222-2222-222222222222');

    const good = mintRuntimeArtifactGrant(
      { hashes: HASHES, allocationId: decoded!.instanceId },
      SECRET
    );
    expect(validateRuntimeArtifactGrant(`Bearer ${good}`, SECRET)).toEqual({
      hashes: HASHES,
      allocationId: decoded!.instanceId,
    });

    const bad = mintRuntimeArtifactGrant({ hashes: HASHES, allocationId: encoded }, SECRET);
    expect(validateRuntimeArtifactGrant(`Bearer ${bad}`, SECRET)).toBeUndefined();
  });
});
