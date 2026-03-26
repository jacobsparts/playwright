/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import http from 'http';
import https from 'https';

export class BrowserControlConnection {
  readonly _serverUrl: string;
  private _sessionId: string | undefined;
  // Serialize all session commands — the server only handles one at a time.
  private _commandQueue: Promise<any> = Promise.resolve();

  constructor(serverUrl: string) {
    this._serverUrl = serverUrl.replace(/\/$/, '');
  }

  sessionId(): string {
    return this._sessionId!;
  }

  async acquire(sessionId?: string): Promise<string> {
    const data: any = {};
    if (sessionId)
      data.sessionId = sessionId;
    const result = await this._post('/browser-control/client/acquire', data);
    this._sessionId = result.sessionId;
    return this._sessionId!;
  }

  async navigate(url: string): Promise<{ url?: string; title?: string }> {
    return await this._serialized(() =>
      this._post(`/browser-control/client/${this._sessionId}/navigate`, { url }));
  }

  async execute(script: string): Promise<any> {
    const resp = await this._serialized(() =>
      this._post(`/browser-control/client/${this._sessionId}/execute`, { script }));
    return resp.result;
  }

  async screenshot(): Promise<string> {
    const resp = await this._serialized(() =>
      this._post(`/browser-control/client/${this._sessionId}/screenshot`));
    return resp.dataUrl;
  }

  async resize(width: number, height: number): Promise<{ width: number; height: number }> {
    return await this._serialized(() =>
      this._post(`/browser-control/client/${this._sessionId}/resize`, { width, height }));
  }

  async closeSession(): Promise<void> {
    await this._serialized(() =>
      this._request('DELETE', `/browser-control/client/${this._sessionId}`));
    this._sessionId = undefined;
  }

  close(): void {
    // No-op for HTTP connections.
  }

  private _serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = this._commandQueue.then(fn, fn);
    this._commandQueue = result.catch(() => {});
    return result;
  }

  private _post(path: string, data?: any): Promise<any> {
    return this._request('POST', path, data);
  }

  private _request(method: string, path: string, data?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = new URL(this._serverUrl + path);
      const isHttps = url.protocol === 'https:';
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: { 'Content-Type': 'application/json' },
      };

      const req = (isHttps ? https : http).request(options, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Browser control server error ${res.statusCode}: ${body}`));
            return;
          }
          try {
            resolve(body ? JSON.parse(body) : {});
          } catch {
            resolve(body);
          }
        });
      });

      req.on('error', reject);

      if (data !== undefined)
        req.write(JSON.stringify(data));

      req.end();
    });
  }
}
