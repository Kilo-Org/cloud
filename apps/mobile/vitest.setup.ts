// React Native's own Jest preset sets this global to suppress the React 19
// react-test-renderer deprecation notice until New Architecture/legacy mode
// are gone from React Native (see @react-native/jest-preset/jest/setup.js).
// Do NOT set IS_REACT_ACT_ENVIRONMENT here: the suite configures act per test
// and turning it on globally would surface new act warnings.
(globalThis as { IS_REACT_NATIVE_TEST_ENVIRONMENT?: boolean }).IS_REACT_NATIVE_TEST_ENVIRONMENT =
  true;
