import { describe, it, expect } from '@jest/globals';
import { isInstallationGoneError } from './github-apps-service';

describe('isInstallationGoneError', () => {
  it('should return true for 404 Not Found errors', () => {
    const error = { status: 404, message: 'Not Found' };
    expect(isInstallationGoneError(error)).toBe(true);
  });

  it('should return true for 401 Unauthorized errors', () => {
    const error = { status: 401, message: 'Unauthorized' };
    expect(isInstallationGoneError(error)).toBe(true);
  });

  it('should return true for 403 Forbidden errors', () => {
    const error = { status: 403, message: 'Forbidden' };
    expect(isInstallationGoneError(error)).toBe(true);
  });

  it('should return false for 500 Internal Server Error', () => {
    const error = { status: 500, message: 'Internal Server Error' };
    expect(isInstallationGoneError(error)).toBe(false);
  });

  it('should return false for 502 Bad Gateway', () => {
    const error = { status: 502, message: 'Bad Gateway' };
    expect(isInstallationGoneError(error)).toBe(false);
  });

  it('should return false for errors without status property', () => {
    const error = new Error('Some error');
    expect(isInstallationGoneError(error)).toBe(false);
  });

  it('should return false for null', () => {
    expect(isInstallationGoneError(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isInstallationGoneError(undefined)).toBe(false);
  });

  it('should return false for string errors', () => {
    expect(isInstallationGoneError('Not Found')).toBe(false);
  });

  it('should return false for number errors', () => {
    expect(isInstallationGoneError(404)).toBe(false);
  });
});
