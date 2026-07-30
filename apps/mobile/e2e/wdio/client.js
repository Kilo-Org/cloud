// WebdriverIO session factory for the Kilo dev build. One session per flow
// invocation; flows manage app lifecycle themselves (terminate/activate), so
// sessions never auto-launch or reset app state.
const { remote } = require('webdriverio');
const { portsFor } = require('./ports');

const BUNDLE_ID = 'com.kilocode.kiloapp';

function platformFor(device) {
  return String(device).startsWith('emulator-') ? 'android' : 'ios';
}

async function connect(device) {
  const platform = platformFor(device);
  const ports = portsFor(device);
  const capabilities =
    platform === 'ios'
      ? {
          platformName: 'iOS',
          'appium:automationName': 'XCUITest',
          'appium:udid': device,
          'appium:bundleId': BUNDLE_ID,
          'appium:noReset': true,
          'appium:autoLaunch': false,
          'appium:wdaLocalPort': ports.wda,
          // RN apps rarely go fully idle; a low idle timeout keeps element
          // queries snappy instead of stalling behind WDA quiescence waits.
          'appium:waitForIdleTimeout': 2,
          'appium:newCommandTimeout': 600,
        }
      : {
          platformName: 'Android',
          'appium:automationName': 'UiAutomator2',
          'appium:udid': device,
          'appium:appPackage': BUNDLE_ID,
          'appium:noReset': true,
          'appium:autoLaunch': false,
          'appium:systemPort': ports.system,
          'appium:newCommandTimeout': 600,
        };

  return remote({
    hostname: '127.0.0.1',
    port: ports.server,
    logLevel: 'warn',
    connectionRetryTimeout: 15000,
    capabilities,
  });
}

module.exports = { BUNDLE_ID, connect, platformFor };
