export class SalesforceAPI {
  constructor(instanceUrl, accessToken) {
    this.instanceUrl = instanceUrl.replace(/\/$/, '');
    this.accessToken = accessToken;
    this.apiVersion = 'v59.0';
  }

  async request(path, options = {}) {
    const url = path.startsWith('http') ? path : `${this.instanceUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers
      }
    });

    if (!response.ok) {
      if (response.status === 401) {
        const host = new URL(url).hostname;
        throw new Error(`Session expired for ${host}. Please reload that Salesforce tab and try again.`);
      }
      let errMsg = response.statusText;
      try {
        const err = await response.json();
        errMsg = Array.isArray(err) ? err[0]?.message : err.message || errMsg;
      } catch (_) {}
      throw new Error(`Salesforce API error (${response.status}): ${errMsg}`);
    }

    return response.json();
  }

  async query(soql) {
    return this.request(
      `/services/data/${this.apiVersion}/query/?q=${encodeURIComponent(soql)}`
    );
  }

  // Automatically follows nextRecordsUrl to get all pages
  async queryAll(soql) {
    let result = await this.query(soql);
    const records = [...result.records];
    while (!result.done && result.nextRecordsUrl) {
      result = await this.request(result.nextRecordsUrl);
      records.push(...result.records);
    }
    return { ...result, records };
  }

  async describe(sobject) {
    return this.request(
      `/services/data/${this.apiVersion}/sobjects/${sobject}/describe/`
    );
  }

  // Salesforce Tooling API — used for FlowDefinition name resolution
  async toolingQuery(soql) {
    return this.request(
      `/services/data/${this.apiVersion}/tooling/query/?q=${encodeURIComponent(soql)}`
    );
  }
}
