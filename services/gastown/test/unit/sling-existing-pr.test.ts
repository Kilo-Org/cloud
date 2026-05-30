import {
  registerCheckPRStatusTests,
  registerRepoValidationTests,
  registerStateValidationTests,
  registerForcePushAllowedTests,
  registerMetadataShapeTests,
} from './babysit-pr-helpers';

registerCheckPRStatusTests();
registerRepoValidationTests();
registerStateValidationTests();
registerForcePushAllowedTests();
registerMetadataShapeTests();
