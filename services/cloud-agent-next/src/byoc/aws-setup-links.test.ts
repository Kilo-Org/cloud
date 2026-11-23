import { URL as FileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { awsSetupIntentSchema } from '@kilocode/worker-utils/aws-onboarding';
import { awsQuickCreateUrl } from './aws-setup-links.js';
const hash = 'a'.repeat(64);
function intent() {
  return awsSetupIntentSchema.parse({
    format: 1,
    accountId: '999999999999',
    stackName: 'kilo-' + 'b'.repeat(32),
    externalId: 'c'.repeat(64),
    kiloRoleArn: 'arn:aws:iam::123456789012:role/kilo',
    controlPlaneUrl: 'https://worker.example.com',
    release: {
      format: 1,
      templateVersion: 2,
      proxyProtocolVersion: 1,
      template: { bucket: 'kilo-releases', key: `aws/${hash}/template.json`, sha256: hash },
      runtime: {
        bucket: 'kilo-releases',
        key: `aws/${hash}/runtime.zip`,
        sha256: hash,
        repositoryArn: 'arn:aws:ecr:us-east-1:123456789012:repository/runtime',
      },
      proxy: {
        imageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/proxy@sha256:${hash}`,
        repositoryArn: 'arn:aws:ecr:us-east-1:123456789012:repository/proxy',
      },
      customerAccounts: ['999999999999'],
    },
  });
}
describe('AWS quick-create instructions', () => {
  it('preserves signed URL encoding and prefills every real template parameter', () => {
    const value = intent();
    const signed = `https://kilo-releases.s3.us-east-1.amazonaws.com/${value.release.template.key}?X-Amz-Credential=ASIATEST%2Fdate%2Fregion%2Fs3&X-Amz-Signature=synthetic`;
    const url = new URL(awsQuickCreateUrl(value, signed));
    const query = new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1));
    expect(url.origin).toBe('https://us-east-1.console.aws.amazon.com');
    expect(query.get('templateURL')).toBe(signed);
    expect(query.get('stackName')).toBe(value.stackName);
    expect(query.get('param_ExternalId')).toBe(value.externalId);
    const template = JSON.parse(
      readFileSync(new FileURL('../../deploy/aws/template.json', import.meta.url), 'utf8')
    );
    const keys = [...query.keys()].filter(key => key.startsWith('param_')).map(key => key.slice(6));
    expect(keys.sort()).toEqual(Object.keys(template.Parameters).sort());
    // AWS ignores quick-create parameters with NoEcho:true.
    for (const key of keys) expect(template.Parameters[key].NoEcho).not.toBe(true);
  });
  it.each(['foreign-host', 'foreign-key'])('refuses %s before building a browser link', change => {
    const value = intent();
    const url = new URL(
      `https://kilo-releases.s3.us-east-1.amazonaws.com/${value.release.template.key}`
    );
    if (change === 'foreign-host') url.hostname = 'foreign.s3.us-east-1.amazonaws.com';
    else url.pathname = '/foreign-template.json';
    expect(() => awsQuickCreateUrl(value, url.href)).toThrow('Invalid AWS template capability');
  });
});
