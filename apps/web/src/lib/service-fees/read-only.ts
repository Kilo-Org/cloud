const MUTATING_FLAGS = new Set(['--execute', '--run-actually', '--write', '--mutate']);

export function assertServiceFeeAuditReadOnly(args: readonly string[]): void {
  const mutating = args.filter(arg => MUTATING_FLAGS.has(arg));
  if (mutating.length > 0) {
    throw new Error(`service_fee_audit_is_read_only rejected ${mutating.join(' ')}`);
  }
}
