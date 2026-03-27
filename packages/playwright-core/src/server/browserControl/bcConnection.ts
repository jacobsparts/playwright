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
import crypto from 'crypto';
import type net from 'net';

export class BrowserControlConnection {
  readonly _serverUrl: string;
  private _sessionId: string | undefined;
  private _claimSocket: net.Socket | undefined;
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
    await this._claim();
    return this._sessionId!;
  }

  private async _claim(): Promise<void> {
    const url = new URL(this._serverUrl + `/browser-control/client/${this._sessionId}/claim`);
    const isHttps = url.protocol === 'https:';
    const key = crypto.randomBytes(16).toString('base64');
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    };

    return new Promise((resolve, reject) => {
      const req = (isHttps ? https : http).request(options);
      req.on('upgrade', (res, socket, head) => {
        this._claimSocket = socket;
        let buf = head;
        const onData = (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          // Look for "ready" in WebSocket text frames.
          // A text frame: 0x81, length byte, then payload.
          while (buf.length >= 2) {
            const len = buf[1] & 0x7f;
            if (buf.length < 2 + len)
              break;
            const payload = buf.subarray(2, 2 + len).toString();
            buf = buf.subarray(2 + len);
            if (payload === 'ready') {
              resolve();
              return;
            }
          }
        };
        socket.on('data', onData);
        socket.on('close', () => {
          this._claimSocket = undefined;
        });
        socket.on('error', () => {
          this._claimSocket = undefined;
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  async navigate(url: string): Promise<{ url?: string; title?: string }> {
    return await this._serialized(() =>
      this._post(`/browser-control/client/${this._sessionId}/navigate`, { url }));
  }

  async execute(script: string): Promise<any> {
    const resp = await this._serialized(() =>
      this._post(`/browser-control/client/${this._sessionId}/execute`, { script }));
    const result = resp.result;
    // The server wraps extension errors as {error: "message"}.
    if (result && typeof result === 'object' && typeof result.error === 'string')
      throw new Error(result.error);
    return result;
  }

  async screenshot(clip?: { x: number; y: number; width: number; height: number }): Promise<string> {
    const resp = await this._serialized(() =>
      this._post(`/browser-control/client/${this._sessionId}/screenshot`, clip ? { clip } : undefined));
    return resp.dataUrl;
  }

  async resize(width: number, height: number): Promise<{ width: number; height: number }> {
    return await this._serialized(() =>
      this._post(`/browser-control/client/${this._sessionId}/resize`, { width, height }));
  }

  /**
   * Execute JavaScript in the extension context (has access to chrome.* APIs).
   * Unlike execute() which runs in the tab's content script context.
   */
  async executeExtension(script: string): Promise<any> {
    const resp = await this._serialized(() =>
      this._post(`/browser-control/client/${this._sessionId}/execute-extension`, { script }));
    return resp.result;
  }

  async getCookies(urls: string[]): Promise<any[]> {
    const urlsJson = JSON.stringify(urls);
    return await this.executeExtension(`
      var allCookies = [], seen = new Set();
      var cookiesGet = function(p) { return promisify(chrome.cookies.getAll.bind(chrome.cookies), p); };
      var urls = ${urlsJson};
      if (!urls.length) return await cookiesGet({});
      for (var i = 0; i < urls.length; i++) {
        var cookies = await cookiesGet({ url: urls[i] });
        for (var j = 0; j < cookies.length; j++) {
          var c = cookies[j];
          var key = c.domain + '|' + c.path + '|' + c.name;
          if (!seen.has(key)) { seen.add(key); allCookies.push(c); }
        }
      }
      return allCookies;
    `) || [];
  }

  async setCookies(cookies: any[]): Promise<void> {
    const cookiesJson = JSON.stringify(cookies);
    await this.executeExtension(`
      var cookiesSet = function(p) { return promisify(chrome.cookies.set.bind(chrome.cookies), p); };
      var cookies = ${cookiesJson};
      for (var i = 0; i < cookies.length; i++) await cookiesSet(cookies[i]);
    `);
  }

  async clearCookies(): Promise<void> {
    await this.executeExtension(`
      var cookiesGetAll = function(p) { return promisify(chrome.cookies.getAll.bind(chrome.cookies), p); };
      var cookiesRemove = function(p) { return promisify(chrome.cookies.remove.bind(chrome.cookies), p); };
      var cookies = await cookiesGetAll({});
      for (var i = 0; i < cookies.length; i++) {
        var c = cookies[i];
        var protocol = c.secure ? 'https' : 'http';
        var url = protocol + '://' + c.domain.replace(/^\\./, '') + c.path;
        await cookiesRemove({ url: url, name: c.name });
      }
    `);
  }

  async closeSession(): Promise<void> {
    this._closeClaimSocket();
    await this._serialized(() =>
      this._request('DELETE', `/browser-control/client/${this._sessionId}`));
    this._sessionId = undefined;
  }

  close(): void {
    this._closeClaimSocket();
  }

  private _closeClaimSocket(): void {
    if (this._claimSocket) {
      this._claimSocket.destroy();
      this._claimSocket = undefined;
    }
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
