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

import { Browser } from '../browser';
import { BrowserContext, validateBrowserContextOptions } from '../browserContext';
import { BCBrowserContext } from './bcBrowserContext';
import { BrowserControlConnection } from './bcConnection';

import type { SdkObject } from '../instrumentation';
import type { BrowserOptions } from '../browser';
import type * as types from '../types';

export class BCBrowser extends Browser {
  private _connection: BrowserControlConnection;
  private _contexts: BCBrowserContext[] = [];
  private _connected = true;

  static async connect(parent: SdkObject, serviceURL: string, options: BrowserOptions, sessionId?: string): Promise<BCBrowser> {
    const connection = new BrowserControlConnection(serviceURL);
    await connection.acquire(sessionId);

    const browser = new BCBrowser(parent, connection, options);

    // Create a default context with the acquired session.
    const persistent: types.BrowserContextOptions = { noDefaultViewport: true };
    validateBrowserContextOptions(persistent, options);
    const context = new BCBrowserContext(browser, connection, persistent);
    browser._defaultContext = context;
    browser._contexts.push(context);

    // Initialize context (sets up debugger, permissions, etc.)
    await context._initialize();

    // Create the initial page.
    await context.doCreateNewPage();

    browser.emit(Browser.Events.Context, context);
    return browser;
  }

  constructor(parent: SdkObject, connection: BrowserControlConnection, options: BrowserOptions) {
    super(parent, options);
    this._connection = connection;
  }

  async doCreateNewContext(options: types.BrowserContextOptions): Promise<BrowserContext> {
    // Each new context acquires a new session from the server.
    const connection = new BrowserControlConnection(this._connection['_serverUrl']);
    await connection.acquire();
    const context = new BCBrowserContext(this, connection, options);
    this._contexts.push(context);
    await context._initialize();
    await context.doCreateNewPage();
    return context;
  }

  contexts(): BrowserContext[] {
    return [...this._contexts];
  }

  isConnected(): boolean {
    return this._connected;
  }

  version(): string {
    return 'browser-control';
  }

  userAgent(): string {
    return 'browser-control';
  }

  async _disconnect(): Promise<void> {
    this._connected = false;
    this._connection.close();
    this.emit(Browser.Events.Disconnected);
  }
}
