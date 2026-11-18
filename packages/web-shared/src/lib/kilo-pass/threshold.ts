/**
 * Kilo Pass bonus credits are treated as "earned" slightly early: once usage crosses
 * (kilo_pass_threshold - $1).
 */
export { getEffectiveKiloPassThreshold } from '@kilocode/worker-utils/kilo-pass-bonus-projection';
