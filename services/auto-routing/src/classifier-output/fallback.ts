import type { NormalizedClassifierInput } from '../classifier-input';
import type { ClassifierOutput } from './index';

type IntentRule = {
  taskType: ClassifierOutput['taskType'];
  subtaskType: ClassifierOutput['subtaskType'];
  keywords: string[];
};

const intentRules: IntentRule[] = [
  {
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    keywords: ['bug', 'broken', 'debug', 'error', 'fail', 'fix', 'regression'],
  },
  {
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    keywords: ['cleanup', 'maintainability', 'refactor', 'simplify'],
  },
  {
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    keywords: ['architecture', 'brainstorm', 'design', 'plan'],
  },
  {
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    keywords: ['find', 'inspect', 'investigate', 'look up', 'search', 'verify'],
  },
  {
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    keywords: ['commit', 'deploy', 'pr', 'push', 'run', 'test'],
  },
];

export function fallbackClassifierOutput(input: NormalizedClassifierInput): ClassifierOutput {
  const text = [input.latestUserPromptPrefix ?? input.userPromptPrefix, input.systemPromptPrefix]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  const intent = intentRules.find(rule =>
    rule.keywords.some(keyword => text.includes(keyword))
  ) ?? {
    taskType: 'implementation',
    subtaskType: 'feature_development',
  };

  const executionMode = input.hasTools ? 'multi_step_project' : 'answer_only';

  return {
    taskType: intent.taskType,
    subtaskType: intent.subtaskType,
    contextComplexity: 'medium',
    reasoningComplexity: 'medium',
    riskLevel: 'low',
    executionMode,
    requiresTools: input.hasTools,
    confidence: 0,
  };
}
