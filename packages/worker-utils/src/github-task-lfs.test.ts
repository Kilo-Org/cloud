import { describe, expect, it } from 'vitest';
import {
  getGitHubTaskLfsRoute,
  githubLfsDownloadUrl,
  githubLfsUploadUrl,
  githubLfsObjectSchema,
} from './github-task-lfs.js';

const batchUrl = 'https://github.com/acme/repo.git/info/lfs/objects/batch';
const object = { oid: 'a'.repeat(64), size: 17 };
const root = 'https://github.com/acme/repo.git/info/lfs';
describe('GitHub task LFS URLs', () => {
  it('round-trips a download object through its exact batch endpoint', () => {
    const value = githubLfsDownloadUrl(batchUrl, object);
    expect(getGitHubTaskLfsRoute(new URL(value))).toEqual({ kind: 'download', batchUrl, object });
  });
  it('round-trips an upload object and the fully qualified publication ref', () => {
    const ref = 'refs/heads/kilo/task';
    const value = githubLfsUploadUrl(batchUrl, object, ref);
    expect(getGitHubTaskLfsRoute(new URL(value))).toEqual({
      kind: 'upload',
      batchUrl,
      object,
      ref,
    });
  });
  it.each([
    `http://github.com/acme/repo.git/info/lfs/kilo-download/${object.oid}?size=17`,
    `https://github.com.evil.example/acme/repo.git/info/lfs/kilo-download/${object.oid}?size=17`,
    `https://user:password@github.com/acme/repo.git/info/lfs/kilo-download/${object.oid}?size=17`,
    `${root}/kilo-download/${object.oid}?size=17#fragment`,
    `${root}/kilo-download/${object.oid}`,
    `${root}/kilo-download/${object.oid}?size=-1`,
    `${root}/kilo-download/${object.oid}?size=01`,
    `${root}/kilo-download/${object.oid}?size=1e3`,
    `${root}/kilo-download/${object.oid}?size=9007199254740992`,
    `${root}/kilo-download/${object.oid}?size=17&size=17`,
    `${root}/kilo-download/${object.oid}?size=17&token=synthetic`,
    `${root}/kilo-download/not-an-object?size=17`,
    `${root}/kilo-upload/${object.oid}?size=17`,
    `${root}/kilo-upload/${object.oid}?size=17&ref=main`,
    `${root}/kilo-upload/${object.oid}?size=17&ref=refs/heads/task%20with-space`,
    `${root}/kilo-upload/${object.oid}?size=17&ref=refs/heads/task%5cother`,
    `${root}/kilo-upload/${object.oid}?size=17&ref=${'x'.repeat(1025)}`,
    `${root}/kilo-upload/${object.oid}?size=17&ref=refs/heads/task&ref=refs/heads/other`,
    `${batchUrl}?extra=1`,
    `${root}/locks/verify?extra=1`,
  ])('rejects an invalid LFS transport URL %#', value => {
    expect(getGitHubTaskLfsRoute(new URL(value))).toBeUndefined();
  });
  it.each([
    { oid: 'bad', size: 17 },
    { ...object, size: -1 },
    { ...object, size: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects an invalid object identity %j', value => {
    expect(githubLfsObjectSchema.safeParse(value).success).toBe(false);
  });
});
