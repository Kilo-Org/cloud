import { startNativeTokenTelemetry } from './native-admission-telemetry';

/**
 * The record contract: one line per mobile request, carrying only bounded
 * header dimensions and fixed values this code names, and never an admission
 * refusal for a request whose proof verified.
 */
type Recorded = Record<string, unknown>;

function mobileRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://api.kilo.ai/api/auth/native/token', {
    method: 'POST',
    headers: {
      'x-kilo-client': 'mobile',
      'x-kilo-app-platform': 'android',
      'x-kilo-app-version': '1.0.16',
      ...headers,
    },
  });
}

describe('startNativeTokenTelemetry', () => {
  let logSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function lines(): Recorded[] {
    return logSpy.mock.calls.map(call => JSON.parse(String(call[0])) as Recorded);
  }

  test('writes nothing for a non-mobile client', () => {
    const telemetry = startNativeTokenTelemetry(
      mobileRequest({ 'x-kilo-client': 'web', 'x-kilo-app-platform': '' })
    );
    telemetry.admissionPassed('android');
    telemetry.emit(200);

    expect(lines()).toEqual([]);
  });

  test('writes nothing when the client header is absent', () => {
    const telemetry = startNativeTokenTelemetry(
      new Request('https://api.kilo.ai/api/auth/native/token', { method: 'POST' })
    );
    telemetry.requestRejected('invalid_json');
    telemetry.emit(400);

    expect(lines()).toEqual([]);
  });

  test('records an issued token with header dimensions and the verified proof platform', () => {
    const telemetry = startNativeTokenTelemetry(mobileRequest());
    telemetry.admissionPassed('android');
    telemetry.emit(200);

    expect(lines()).toEqual([
      {
        type: 'native_admission',
        route: '/api/auth/native/token',
        headerPlatform: 'android',
        headerVersion: '1.0.16',
        admission: 'passed',
        proofPlatform: 'android',
        outcome: 'token_issued',
      },
    ]);
  });

  test('keeps the header platform separate from the verified proof platform', () => {
    // A client that mislabels its own cohort cannot make the record claim a
    // verified iOS proof: the proof platform comes from the payload.
    const telemetry = startNativeTokenTelemetry(
      mobileRequest({ 'x-kilo-app-platform': 'android', 'x-kilo-app-version': '1.0.16' })
    );
    telemetry.admissionPassed('ios');
    telemetry.emit(200);

    const [line] = lines();
    expect(line).toMatchObject({ headerPlatform: 'android', proofPlatform: 'ios' });
  });

  test('records an absent admission field as missing', () => {
    const telemetry = startNativeTokenTelemetry(mobileRequest());
    telemetry.admissionMissing('absent');
    telemetry.emit(403);

    expect(lines()[0]).toMatchObject({
      admission: 'missing',
      reason: 'absent',
      outcome: 'admission_refused',
    });
  });

  test.each([
    'not_an_object',
    'platform_invalid',
    'kind_invalid',
    'challenge_missing',
    'payload_missing',
    'payload_oversized',
    'key_id_missing',
  ] as const)('records a supplied-but-malformed admission field as malformed (%s)', reason => {
    const telemetry = startNativeTokenTelemetry(mobileRequest());
    telemetry.admissionMissing(reason);
    telemetry.emit(403);

    expect(lines()[0]).toMatchObject({
      admission: 'malformed',
      reason,
      outcome: 'admission_refused',
    });
  });

  test('records an Android verifier refusal with allowlisted diagnostics', () => {
    const telemetry = startNativeTokenTelemetry(mobileRequest());
    telemetry.admissionRefused({
      reason: 'integrity_cert_digest_mismatch',
      source: 'play_integrity',
      proofPlatform: 'android',
      proofKind: 'assertion',
      android: {
        appRecognition: 'play_recognized',
        certificatePresent: false,
        deviceIntegrity: 'meets_device_integrity',
      },
    });
    telemetry.emit(403);

    expect(lines()[0]).toEqual({
      type: 'native_admission',
      route: '/api/auth/native/token',
      headerPlatform: 'android',
      headerVersion: '1.0.16',
      admission: 'refused',
      reason: 'integrity_cert_digest_mismatch',
      proofPlatform: 'android',
      admissionSource: 'play_integrity',
      proofKind: 'assertion',
      android: {
        appRecognition: 'play_recognized',
        certificatePresent: false,
        deviceIntegrity: 'meets_device_integrity',
      },
      outcome: 'admission_refused',
    });
  });

  test('records an iOS refusal without any Android block', () => {
    const telemetry = startNativeTokenTelemetry(
      mobileRequest({ 'x-kilo-app-platform': 'ios', 'x-kilo-app-version': '1.0.15' })
    );
    telemetry.admissionRefused({
      reason: 'assertion_key_unknown',
      source: 'apple',
      proofPlatform: 'ios',
      proofKind: 'assertion',
    });
    telemetry.emit(403);

    const [line] = lines();
    expect(line).toMatchObject({
      admission: 'refused',
      reason: 'assertion_key_unknown',
      admissionSource: 'apple',
      proofPlatform: 'ios',
    });
    expect(line).not.toHaveProperty('android');
  });

  test('records a provider fault as a fault, never as a refusal', () => {
    const telemetry = startNativeTokenTelemetry(mobileRequest());
    telemetry.admissionProviderFault();
    telemetry.emit(500);

    expect(lines()[0]).toMatchObject({
      admission: 'provider_fault',
      outcome: 'admission_provider_fault',
    });
  });

  test('records a refusal after admission as a later stage, not an admission refusal', () => {
    // The proof verified and the request was refused afterwards (identity,
    // settlement, rate limit, or session issuance). It must never appear in the
    // admission-refusal population.
    const telemetry = startNativeTokenTelemetry(mobileRequest());
    telemetry.admissionPassed('android');
    telemetry.emit(403);

    expect(lines()[0]).toMatchObject({
      admission: 'passed',
      proofPlatform: 'android',
      outcome: 'refused_after_admission',
    });
  });

  test('records a failure after admission separately from a refusal', () => {
    const telemetry = startNativeTokenTelemetry(mobileRequest());
    telemetry.admissionPassed('ios');
    telemetry.emit(500);

    expect(lines()[0]).toMatchObject({ admission: 'passed', outcome: 'failed_after_admission' });
  });

  test('records a pre-admission rate limit as its own outcome', () => {
    const telemetry = startNativeTokenTelemetry(mobileRequest());
    telemetry.addressRateLimited();
    telemetry.emit(429);

    expect(lines()[0]).toMatchObject({
      admission: 'not_attempted',
      reason: 'address_rate_limited',
      outcome: 'rate_limited_before_admission',
    });
  });

  test.each([
    ['invalid_json', 400],
    ['invalid_request', 400],
  ] as const)('records a rejected request body (%s) before admission', (reason, status) => {
    const telemetry = startNativeTokenTelemetry(mobileRequest());
    telemetry.requestRejected(reason);
    telemetry.emit(status);

    expect(lines()[0]).toMatchObject({
      admission: 'not_attempted',
      reason,
      outcome: 'request_rejected',
    });
  });

  test('an unrecorded stage surfaces as a wiring regression, not a refusal', () => {
    const telemetry = startNativeTokenTelemetry(mobileRequest());
    telemetry.emit(200);

    expect(lines()[0]).toMatchObject({ admission: 'not_attempted', outcome: 'incomplete' });
  });

  test('writes exactly one record when emit runs twice', () => {
    const telemetry = startNativeTokenTelemetry(mobileRequest());
    telemetry.admissionPassed('android');
    telemetry.emit(200);
    telemetry.emit(500);

    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ outcome: 'token_issued' });
  });

  test('drops an unbounded header value instead of logging it', () => {
    const telemetry = startNativeTokenTelemetry(
      mobileRequest({
        'x-kilo-app-version': '1.0.16-debug+featurebranch',
        'x-kilo-app-platform': 'android',
      })
    );
    telemetry.admissionPassed('android');
    telemetry.emit(200);

    const [line] = lines();
    expect(line).toMatchObject({ headerVersion: null, headerPlatform: 'android' });
  });

  test('records an unknown platform as the bounded `other` value', () => {
    const telemetry = startNativeTokenTelemetry(
      mobileRequest({ 'x-kilo-app-platform': 'windows' })
    );
    telemetry.admissionPassed('android');
    telemetry.emit(200);

    expect(lines()[0]).toMatchObject({ headerPlatform: 'other' });
  });

  test('carries no request id, even when the app supplied one', () => {
    const telemetry = startNativeTokenTelemetry(
      mobileRequest({ 'x-kilo-request-id': 'req-abc-123' })
    );
    telemetry.admissionPassed('android');
    telemetry.emit(200);

    expect(JSON.stringify(lines()[0])).not.toContain('req-abc-123');
  });

  test('emits no field that could carry a proof, token, address, or verdict', () => {
    const telemetry = startNativeTokenTelemetry(mobileRequest());
    telemetry.admissionRefused({
      reason: 'integrity_app_not_recognized',
      source: 'play_integrity',
      proofPlatform: 'android',
      proofKind: 'assertion',
      android: {
        appRecognition: 'unevaluated',
        certificatePresent: false,
        deviceIntegrity: 'missing',
      },
    });
    telemetry.emit(403);

    const [line] = lines();
    expect(Object.keys(line).sort()).toEqual([
      'admission',
      'admissionSource',
      'android',
      'headerPlatform',
      'headerVersion',
      'outcome',
      'proofKind',
      'proofPlatform',
      'reason',
      'route',
      'type',
    ]);
    const serialized = JSON.stringify(line);
    for (const forbidden of ['user-agent', 'Authorization', 'key1', 'challenge', 'payload']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('a throwing console never fails the request', () => {
    logSpy.mockImplementation(() => {
      throw new Error('log sink down');
    });
    const telemetry = startNativeTokenTelemetry(mobileRequest());

    expect(() => {
      telemetry.admissionPassed('android');
      telemetry.emit(200);
    }).not.toThrow();
  });
});
