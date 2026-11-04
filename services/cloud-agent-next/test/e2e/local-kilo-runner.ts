import assert from 'node:assert/strict';
import type { Harness } from './local-kilo-harness.js';
import { authScenarios } from './local-kilo-scenarios-auth.js';
import { hostedScenarios } from './local-kilo-scenarios-hosted.js';
import { optInScenarios } from './local-kilo-scenarios-optin.js';
import { questionsScenarios } from './local-kilo-scenarios-questions.js';
import { turnsScenarios } from './local-kilo-scenarios-turns.js';
import { validationScenarios } from './local-kilo-scenarios-validation.js';
import { workspaceScenarios } from './local-kilo-scenarios-workspace.js';
import { orderBySandbox, type Scenario, type SandboxKind } from './local-kilo-scenarios.js';

export const allScenarios: Scenario[] = orderBySandbox([
  ...workspaceScenarios,
  ...questionsScenarios,
  ...validationScenarios,
  ...hostedScenarios,
  ...turnsScenarios,
  ...authScenarios,
  ...optInScenarios,
]);

export function parseOnly(values: string[]): string[] {
  return values
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(value => value.length > 0);
}

export function selectScenarios(only: string[]): Scenario[] {
  if (only.length === 0) return allScenarios.filter(scenario => !scenario.optIn);
  const known = new Set(allScenarios.map(scenario => scenario.name));
  for (const name of only) {
    assert(known.has(name), `Unknown scenario for --only: ${name}`);
  }
  return allScenarios.filter(scenario => only.includes(scenario.name));
}

export async function runScenarios(harness: Harness, scenarios: Scenario[]): Promise<void> {
  let active: SandboxKind | undefined;
  for (const scenario of scenarios) {
    const kind = scenario.sandbox ?? 'none';
    if (kind !== 'none' && active !== undefined && active !== kind) {
      try {
        await harness.releaseSandboxes();
      } catch (error) {
        console.log(
          `WARN release before ${scenario.name} failed: ${harness.scrub(error instanceof Error ? error.message : String(error))}`
        );
      }
    }
    if (kind !== 'none') active = kind;

    const startedAt = Date.now();
    try {
      await scenario.run(harness);
      harness.results.push({
        name: scenario.name,
        status: 'pass',
        optIn: scenario.optIn === true,
        durationMs: Date.now() - startedAt,
      });
      console.log(`PASS ${scenario.name} (${Date.now() - startedAt}ms)`);
    } catch (error) {
      const detail = harness.scrub(error instanceof Error ? error.message : String(error));
      harness.results.push({
        name: scenario.name,
        status: 'fail',
        optIn: scenario.optIn === true,
        durationMs: Date.now() - startedAt,
        detail,
      });
      console.log(`FAIL ${scenario.name} (${Date.now() - startedAt}ms) — ${detail}`);
    }
  }
}
