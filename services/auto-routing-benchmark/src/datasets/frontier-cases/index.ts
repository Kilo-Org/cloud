import type { DeciderCase } from '../decider-cases';
import { AGENTIC_EXECUTION_FRONTIER_CASES } from './agentic-execution';
import { DEBUGGING_FRONTIER_CASES } from './debugging';
import { IMPLEMENTATION_FRONTIER_CASES } from './implementation';
import { INVESTIGATION_FRONTIER_CASES } from './investigation';
import { PLANNING_DESIGN_FRONTIER_CASES } from './planning-design';
import { REFACTORING_FRONTIER_CASES } from './refactoring';

export const FRONTIER_V1_CASES: readonly DeciderCase[] = [
  ...IMPLEMENTATION_FRONTIER_CASES,
  ...DEBUGGING_FRONTIER_CASES,
  ...REFACTORING_FRONTIER_CASES,
  ...PLANNING_DESIGN_FRONTIER_CASES,
  ...INVESTIGATION_FRONTIER_CASES,
  ...AGENTIC_EXECUTION_FRONTIER_CASES,
];
