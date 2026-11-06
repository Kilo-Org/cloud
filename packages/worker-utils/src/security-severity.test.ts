import { describe, expect, it } from 'vitest';
import { SecuritySeverity } from '@kilocode/db/schema-types';
import {
  getSecuritySeverityRank,
  getSecuritySeverityThresholdRank,
  isSecuritySeverity,
} from './security-severity.js';

describe('security severity rank', () => {
  it.each([
    [SecuritySeverity.CRITICAL, 0],
    [SecuritySeverity.HIGH, 1],
    [SecuritySeverity.MEDIUM, 2],
    [SecuritySeverity.LOW, 3],
  ] as const)('maps %s to rank %i', (severity, rank) => {
    expect(getSecuritySeverityRank(severity)).toBe(rank);
  });

  it.each([null, '', 'unknown', 'toString', 'constructor'] as const)(
    'returns null for non-severity %s',
    severity => {
      expect(getSecuritySeverityRank(severity)).toBeNull();
      expect(isSecuritySeverity(severity ?? '')).toBe(false);
    }
  );

  it.each([
    [SecuritySeverity.CRITICAL, 0],
    [SecuritySeverity.HIGH, 1],
    [SecuritySeverity.MEDIUM, 2],
    [SecuritySeverity.LOW, 3],
    ['all', 3],
  ] as const)('maps threshold %s to rank %i', (threshold, rank) => {
    expect(getSecuritySeverityThresholdRank(threshold)).toBe(rank);
  });
});
