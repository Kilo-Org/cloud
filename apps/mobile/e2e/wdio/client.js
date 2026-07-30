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
  // The wrapper passes the port of the server it actually started (it bumps
  // past occupied blocks); fall back to the deterministic default.
  const derived = portsFor(device);
  const serverPort = Number(process.env.APPIUM_PORT || derived.server);
  const ports = { server: serverPort, wda: serverPort + 1, system: serverPort + 2 };
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
    // The first XCUITest session on a device builds WebDriverAgent (minutes);
    // later sessions reuse the cached build. Never time this out at 15s.
    connectionRetryTimeout: 300000,
    connectionRetryCount: 3,
    capabilities,
  });
}

module.exports = { BUNDLE_ID, connect, platformFor };
