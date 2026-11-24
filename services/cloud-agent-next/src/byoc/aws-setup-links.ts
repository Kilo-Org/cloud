import {
  awsEcsSetupIntentSchema,
  type AwsEcsSetupIntent,
} from '@kilocode/worker-utils/aws-onboarding';
import { awsEcsSetupParameters } from './aws-stack-validation.js';

/** The signed URL is restricted to the exact immutable template selected in the persisted intent. */
export function awsQuickCreateUrl(value: AwsEcsSetupIntent, signedTemplateUrl: string): string {
  const intent = awsEcsSetupIntentSchema.parse(value);
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
  for (const [name, value] of Object.entries(awsEcsSetupParameters(intent)))
    query.set(`param_${name}`, value);
  return `https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?${query.toString()}`;
}
