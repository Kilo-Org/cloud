export type Owner = {
  type: 'user' | 'org';
  id: string;
  userId: string;
};

export type MCPServerConfig = {
  type: string;
  url: string;
  headers: Record<string, string>;
  timeout: number;
};
