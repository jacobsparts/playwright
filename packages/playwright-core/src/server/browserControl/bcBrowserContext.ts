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

import { BrowserContext } from '../browserContext';
import { BCPage } from './bcPage';

import type { InitScript } from '../page';
import type { Page } from '../page';
import type { BCBrowser } from './bcBrowser';
import type { BrowserControlConnection } from './bcConnection';
import type * as types from '../types';
import type * as channels from '@protocol/channels';

export class BCBrowserContext extends BrowserContext {
  declare readonly _browser: BCBrowser;
  private _connection: BrowserControlConnection;
  private _pages: Page[] = [];

  constructor(browser: BCBrowser, connection: BrowserControlConnection, options: types.BrowserContextOptions) {
    super(browser, options, undefined);
    this._connection = connection;
  }

  possiblyUninitializedPages(): Page[] {
    return [...this._pages];
  }

  async doCreateNewPage(): Promise<Page> {
    const bcPage = new BCPage(this._connection, this);
    await bcPage.initialize();
    this._pages.push(bcPage._page);
    return bcPage._page;
  }

  async addCookies(_cookies: channels.SetNetworkCookie[]): Promise<void> {
    // Not supported through browser-control.
  }

  async setGeolocation(_geolocation?: types.Geolocation): Promise<void> { }
  async setUserAgent(_userAgent: string | undefined): Promise<void> { }
  async cancelDownload(_uuid: string): Promise<void> { }
  async clearCache(): Promise<void> { }

  protected async doGetCookies(_urls: string[]): Promise<channels.NetworkCookie[]> {
    return [];
  }

  protected async doClearCookies(): Promise<void> { }
  protected async doGrantPermissions(_origin: string, _permissions: string[]): Promise<void> { }
  protected async doClearPermissions(): Promise<void> { }
  protected async doSetHTTPCredentials(_httpCredentials?: types.Credentials): Promise<void> { }
  protected async doAddInitScript(_initScript: InitScript): Promise<void> { }
  protected async doRemoveInitScripts(_initScripts: InitScript[]): Promise<void> { }
  protected async doUpdateExtraHTTPHeaders(): Promise<void> { }
  protected async doUpdateOffline(): Promise<void> { }
  protected async doUpdateRequestInterception(): Promise<void> { }
  protected async doUpdateDefaultViewport(): Promise<void> { }
  protected async doUpdateDefaultEmulatedMedia(): Promise<void> { }
  protected async doExposePlaywrightBinding(): Promise<void> { }

  protected async doClose(_reason: string | undefined): Promise<void> {
    for (const page of this._pages)
      await page.close({ reason: _reason });
    this._pages = [];
  }

  protected onClosePersistent(): void { }

  _removePage(page: Page): void {
    this._pages = this._pages.filter(p => p !== page);
  }
}
