import {
  awsSetupIntentSchema,
  type AwsSetupProvider,
  type AwsSetupIntent,
} from '@kilocode/worker-utils/aws-onboarding';
import {
  awsEcsSetupIntentSchema,
  type AwsProviderSetupIntent,
} from '@kilocode/worker-utils/aws-ecs-onboarding';
import { awsSetupParameters, awsEcsSetupParameters } from './aws-stack-validation.js';

/** The signed URL is restricted to the exact immutable template selected in the persisted intent. */
export function awsQuickCreateUrl(value: AwsSetupIntent, signedTemplateUrl: string): string {
  return awsProviderQuickCreateUrl('aws', value, signedTemplateUrl);
}
export function awsProviderQuickCreateUrl(
  provider: AwsSetupProvider,
  value: AwsProviderSetupIntent,
  signedTemplateUrl: string
): string {
  const setup =
    provider === 'aws'
      ? {
          intent: awsSetupIntentSchema.parse(value),
          parameters: awsSetupParameters(awsSetupIntentSchema.parse(value)),
        }
      : {
          intent: awsEcsSetupIntentSchema.parse(value),
          parameters: awsEcsSetupParameters(awsEcsSetupIntentSchema.parse(value)),
        };
  const { intent } = setup;
  const template = new URL(signedTemplateUrl);
  if (
    template.protocol !== 'https:' ||
    template.username ||
    template.password ||
    template.hash ||
    template.host !== `${intent.release.template.bucket}.s3.us-east-1.amazonaws.com` ||
    template.pathname !== '/' + intent.release.template.key
  )
    throw new Error('Invalid AWS template capability');
  const query = new URLSearchParams({ templateURL: template.href, stackName: intent.stackName });
  for (const [name, value] of Object.entries(setup.parameters)) query.set(`param_${name}`, value);
  return `https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?${query.toString()}`;
}
