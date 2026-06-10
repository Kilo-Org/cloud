export class HtmlDeployDispatcherClient {
  constructor(
    private readonly dispatcher: Fetcher,
    private readonly authToken: string,
    private readonly hostnameBase: string
  ) {}

  async setSlugMapping(workerName: string, slug: string): Promise<boolean> {
    const response = await this.dispatcher.fetch(
      new Request(
        `https://${this.hostnameBase}/api/slug-mapping/${encodeURIComponent(workerName)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${this.authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ slug }),
        }
      )
    );

    if (response.status === 409) {
      return false;
    }
    if (!response.ok) {
      throw new Error(`Failed to set slug mapping: ${response.status}`);
    }

    return true;
  }

  async deleteSlugMapping(workerName: string): Promise<void> {
    const response = await this.dispatcher.fetch(
      new Request(
        `https://${this.hostnameBase}/api/slug-mapping/${encodeURIComponent(workerName)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${this.authToken}` },
        }
      )
    );

    if (!response.ok) {
      throw new Error(`Failed to delete slug mapping: ${response.status}`);
    }
  }

  async enableBanner(workerName: string): Promise<void> {
    const response = await this.dispatcher.fetch(
      new Request(
        `https://${this.hostnameBase}/api/app-builder-banner/${encodeURIComponent(workerName)}`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${this.authToken}` },
        }
      )
    );

    if (!response.ok) {
      throw new Error(`Failed to enable app builder banner: ${response.status}`);
    }
  }

  async disableBanner(workerName: string): Promise<void> {
    const response = await this.dispatcher.fetch(
      new Request(
        `https://${this.hostnameBase}/api/app-builder-banner/${encodeURIComponent(workerName)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${this.authToken}` },
        }
      )
    );

    if (!response.ok) {
      throw new Error(`Failed to disable app builder banner: ${response.status}`);
    }
  }
}
