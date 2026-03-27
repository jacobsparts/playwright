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
import type { Progress } from '../progress';
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

  async addCookies(cookies: channels.SetNetworkCookie[]): Promise<void> {
    // Map Playwright SetNetworkCookie to chrome.cookies.set() format.
    const chromeCookies = cookies.map(c => {
      const result: any = {
        name: c.name,
        value: c.value,
      };
      // chrome.cookies.set requires a url OR domain+path.
      if (c.url) {
        result.url = c.url;
      } else {
        const domain = c.domain || '';
        const secure = c.secure ?? domain.startsWith('.');
        result.url = (secure ? 'https://' : 'http://') + domain.replace(/^\./, '') + (c.path || '/');
      }
      if (c.domain) result.domain = c.domain;
      if (c.path) result.path = c.path;
      if (c.expires !== undefined && c.expires !== -1) result.expirationDate = c.expires;
      if (c.httpOnly !== undefined) result.httpOnly = c.httpOnly;
      if (c.secure !== undefined) result.secure = c.secure;
      if (c.sameSite) {
        const map: Record<string, string> = { 'Strict': 'strict', 'Lax': 'lax', 'None': 'no_restriction' };
        result.sameSite = map[c.sameSite] || 'unspecified';
        // Chrome requires SameSite=None cookies to be Secure.
        if (result.sameSite === 'no_restriction' && !result.secure) {
          result.secure = true;
          // Fix URL scheme to match.
          if (result.url?.startsWith('http:'))
            result.url = 'https:' + result.url.slice(5);
        }
      }
      return result;
    });
    await this._connection.setCookies(chromeCookies);
  }

  async setGeolocation(_geolocation?: types.Geolocation): Promise<void> { }
  async setUserAgent(_userAgent: string | undefined): Promise<void> { }
  async cancelDownload(_uuid: string): Promise<void> { }
  async clearCache(): Promise<void> { }

  protected async doGetCookies(urls: string[]): Promise<channels.NetworkCookie[]> {
    // Use chrome.cookies API via the extension.
    const chromeCookies = await this._connection.getCookies(urls);
    // Map chrome.cookies format to Playwright NetworkCookie.
    return chromeCookies.map((c: any) => {
      const sameSiteMap: Record<string, 'Strict' | 'Lax' | 'None'> = {
        'strict': 'Strict', 'lax': 'Lax', 'no_restriction': 'None',
      };
      return {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expirationDate ?? -1,
        httpOnly: c.httpOnly ?? false,
        secure: c.secure ?? false,
        sameSite: sameSiteMap[c.sameSite] || 'None',
      };
    });
  }

  protected async doClearCookies(): Promise<void> {
    await this._connection.clearCookies();
  }
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

  // Override storageState to use simple page.evaluate() instead of the utility
  // script which doesn't work on the browser-control backend.
  override async storageState(_progress: Progress, _indexedDB = false): Promise<channels.BrowserContextStorageStateResult> {
    const cookies = await this.cookies();
    const origins: channels.OriginStorage[] = [];

    for (const page of this.pages()) {
      const origin = page.mainFrame().origin();
      if (!origin)
        continue;
      try {
        const localStorage: { name: string; value: string }[] = await page.mainFrame().evaluateExpression(
            `(() => Object.entries(localStorage).map(([name, value]) => ({ name, value })))()`,
            { returnByValue: true });
        if (localStorage.length)
          origins.push({ origin, localStorage });
      } catch {
      }
    }

    return { cookies, origins };
  }

  override async setStorageState(progress: Progress, state: channels.BrowserNewContextParams['storageState'], _mode: 'initial' | 'resetForReuse' | 'api') {
    if (state?.cookies)
      await progress.race(this.addCookies(state.cookies));

    if (state?.origins?.length) {
      const page = this.pages()[0];
      if (!page)
        return;
      for (const { origin, localStorage } of state.origins) {
        if (!localStorage?.length)
          continue;
        try {
          await page.mainFrame().evaluateExpression(
              `((entries) => { for (const {name, value} of entries) localStorage.setItem(name, value); })(${JSON.stringify(localStorage)})`,
              { returnByValue: true });
        } catch {
        }
      }
    }
  }

  protected async doClose(_reason: string | undefined): Promise<void> {
    for (const page of this._pages)
      await page.close({ reason: _reason });
    this._pages = [];
    // Close the connection's session on the server so the tab is released.
    await this._connection.closeSession().catch(() => {});
    this._browser._removeContext(this);
  }

  protected onClosePersistent(): void { }

  _removePage(page: Page): void {
    this._pages = this._pages.filter(p => p !== page);
  }
}
