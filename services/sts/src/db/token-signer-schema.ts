/**
 * The token signer keeps only its audit stream in SQL. Its key ring lives in KV storage
 * (`crypto/key-store.ts` explains why).
 */
export { auditEvent, auditPrune, auditWatermark } from './audit-tables';
