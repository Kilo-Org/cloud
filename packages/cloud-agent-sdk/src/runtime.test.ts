import {
  cloudAgentSdkRuntime,
  configureCloudAgentSdkRuntime,
  resetCloudAgentSdkRuntime,
} from './runtime';

afterEach(() => {
  resetCloudAgentSdkRuntime();
});

describe('cloudAgentSdkRuntime', () => {
  it('uses randomBytes override for randomUUID fallback', () => {
    configureCloudAgentSdkRuntime({
      randomBytes: byteLength =>
        new Uint8Array(Array.from({ length: byteLength }, (_, index) => index)),
    });

    expect(cloudAgentSdkRuntime.randomUUID()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });

  it('applies repeated overrides idempotently', () => {
    configureCloudAgentSdkRuntime({ randomUUID: () => 'first-id' });
    configureCloudAgentSdkRuntime({ randomUUID: () => 'second-id' });

    expect(cloudAgentSdkRuntime.randomUUID()).toBe('second-id');
  });
});
