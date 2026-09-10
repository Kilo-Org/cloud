import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { patchMainApplication, DSO_MESSAGE_PATTERN } = require(
  './withAndroidSentryIgnoredInstallErrors.js'
);

const KOTLIN_TARGET = 'RNSentrySDK.init(this)';
const JAVA_TARGET = 'RNSentrySDK.init(this);';

test('patches the Kotlin native-init call with the ignored-error filter', () => {
  const contents = [
    '  override fun onCreate() {',
    '    super.onCreate()',
    `    ${KOTLIN_TARGET}`,
    '    loadReactNative(this)',
    '  }',
  ].join('\n');

  const patched = patchMainApplication(contents, 'kt');

  assert.ok(patched, 'expected the Kotlin target to be replaced');
  assert.match(patched, /RNSentrySDK\.init\(this\) \{ options ->/);
  assert.ok(
    patched.includes(`options.addIgnoredError(${JSON.stringify(DSO_MESSAGE_PATTERN)})`),
    'expected the ignored-error filter to be installed'
  );
  assert.ok(patched.includes('loadReactNative(this)'), 'expected the rest of onCreate untouched');
});

test('patches the Java native-init call with the ignored-error filter', () => {
  const contents = [
    '  public void onCreate() {',
    '    super.onCreate();',
    `    ${JAVA_TARGET}`,
    '    loadReactNative(this);',
    '  }',
  ].join('\n');

  const patched = patchMainApplication(contents, 'java');

  assert.ok(patched, 'expected the Java target to be replaced');
  assert.match(patched, /RNSentrySDK\.init\(this, options -> options\.addIgnoredError\(/);
  assert.ok(patched.includes(`addIgnoredError(${JSON.stringify(DSO_MESSAGE_PATTERN)})`));
});

test('returns null when the Sentry native-init call is absent', () => {
  assert.equal(patchMainApplication('class MainApplication {}', 'kt'), null);
});

test('the ignored pattern matches the side-load SoLoader DSO message', () => {
  const regex = new RegExp(DSO_MESSAGE_PATTERN);
  const message = [
    "B: couldn't find DSO to load: libreactnative.so",
    '\texisting SO sources:',
    '\tSoSource 0: ApplicationSoSource',
  ].join('\n');

  assert.ok(regex.test(message), 'expected the multi-line DSO message to match');
});
