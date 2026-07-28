/**
 * Cloud agent attachment reference shared by the web and mobile apps.
 *
 * R2 path structure: {bucket}/{userId}/{path}/{filename}
 */
export type CloudAgentAttachments = {
  path: string;
  files: string[];
};
