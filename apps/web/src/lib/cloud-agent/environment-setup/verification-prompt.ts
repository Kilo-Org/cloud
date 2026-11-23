export type VerificationCheck = {
  name: string;
  command: string;
  expect: string;
};

export type VerificationPromptInput = {
  checks: VerificationCheck[];
  workingDirectory: string;
};

export function buildVerificationPrompt(input: VerificationPromptInput): string {
  const checkBlocks = input.checks
    .map(
      (check, index) =>
        `${index + 1}. ${check.name}\n   Command: ${check.command}\n   Expected: ${check.expect}`
    )
    .join('\n');

  return `You are a verification session for a Cloud Agent environment. The environment's setup already ran before this message.

Run each check below from ${input.workingDirectory}. Do not change files, install extra tools, or fix problems. Report what happened.

Checks:
${checkBlocks}

Reply with only a JSON object on the last line, in this exact shape:
{"results":[{"name":"<check name>","passed":true|false,"evidence":"<at most 500 characters of relevant output>"}]}
Never include secret values in evidence.
`;
}
