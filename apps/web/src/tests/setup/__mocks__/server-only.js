// Mock for server-only package in tests
// This package normally throws an error when imported in client-side code,
// but in tests we want to allow it to be imported without issues.
module.exports = {};
