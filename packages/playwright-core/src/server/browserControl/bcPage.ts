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

import * as dom from '../dom';
import * as frames from '../frames';
import { Page } from '../page';
import { BCExecutionContext } from './bcExecutionContext';

import type { BrowserControlConnection } from './bcConnection';
import type { BCBrowserContext } from './bcBrowserContext';
import type * as input from '../input';
import type { InitScript, PageDelegate } from '../page';
import type { Progress } from '../progress';
import type * as types from '../types';

class BCRawKeyboard implements input.RawKeyboard {
  private _connection: BrowserControlConnection;

  constructor(connection: BrowserControlConnection) {
    this._connection = connection;
  }

  async keydown(_progress: Progress, _modifiers: Set<types.KeyboardModifier>, _keyName: string, description: input.KeyDescription, _autoRepeat: boolean): Promise<void> {
    const code = `
      document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
        key: ${JSON.stringify(description.key)},
        code: ${JSON.stringify(description.code)},
        keyCode: ${description.keyCode},
        bubbles: true,
        cancelable: true,
      }));
    `;
    await this._connection.execute(code);
  }

  async keyup(_progress: Progress, _modifiers: Set<types.KeyboardModifier>, _keyName: string, description: input.KeyDescription): Promise<void> {
    const code = `
      document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent('keyup', {
        key: ${JSON.stringify(description.key)},
        code: ${JSON.stringify(description.code)},
        keyCode: ${description.keyCode},
        bubbles: true,
        cancelable: true,
      }));
    `;
    await this._connection.execute(code);
  }

  async sendText(_progress: Progress, text: string): Promise<void> {
    const escaped = JSON.stringify(text);
    const code = `
      (function() {
        var el = document.activeElement;
        if (!el) return;
        if (el.isContentEditable) {
          document.execCommand('insertText', false, ${escaped});
        } else if ('value' in el) {
          var nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
          nativeSetter.call(el, el.value + ${escaped});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })();
    `;
    await this._connection.execute(code);
  }
}

class BCRawMouse implements input.RawMouse {
  private _connection: BrowserControlConnection;

  constructor(connection: BrowserControlConnection) {
    this._connection = connection;
  }

  async move(_progress: Progress, x: number, y: number, _button: types.MouseButton | 'none', _buttons: Set<types.MouseButton>, _modifiers: Set<types.KeyboardModifier>, _forClick: boolean): Promise<void> {
    const code = `
      var el = document.elementFromPoint(${x}, ${y});
      if (el) el.dispatchEvent(new MouseEvent('mousemove', { clientX: ${x}, clientY: ${y}, bubbles: true }));
    `;
    await this._connection.execute(code);
  }

  async down(_progress: Progress, x: number, y: number, button: types.MouseButton, _buttons: Set<types.MouseButton>, _modifiers: Set<types.KeyboardModifier>, _clickCount: number): Promise<void> {
    const buttonNum = button === 'left' ? 0 : button === 'right' ? 2 : 1;
    const code = `
      var el = document.elementFromPoint(${x}, ${y});
      if (el) el.dispatchEvent(new MouseEvent('mousedown', { clientX: ${x}, clientY: ${y}, button: ${buttonNum}, bubbles: true }));
    `;
    await this._connection.execute(code);
  }

  async up(_progress: Progress, x: number, y: number, button: types.MouseButton, _buttons: Set<types.MouseButton>, _modifiers: Set<types.KeyboardModifier>, _clickCount: number): Promise<void> {
    const buttonNum = button === 'left' ? 0 : button === 'right' ? 2 : 1;
    const code = `
      var el = document.elementFromPoint(${x}, ${y});
      if (el) {
        el.dispatchEvent(new MouseEvent('mouseup', { clientX: ${x}, clientY: ${y}, button: ${buttonNum}, bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { clientX: ${x}, clientY: ${y}, button: ${buttonNum}, bubbles: true }));
      }
    `;
    await this._connection.execute(code);
  }

  async wheel(_progress: Progress, x: number, y: number, _buttons: Set<types.MouseButton>, _modifiers: Set<types.KeyboardModifier>, deltaX: number, deltaY: number): Promise<void> {
    const code = `
      var el = document.elementFromPoint(${x}, ${y});
      if (el) el.dispatchEvent(new WheelEvent('wheel', { clientX: ${x}, clientY: ${y}, deltaX: ${deltaX}, deltaY: ${deltaY}, bubbles: true }));
    `;
    await this._connection.execute(code);
  }
}

class BCRawTouchscreen implements input.RawTouchscreen {
  async tap(_progress: Progress, x: number, y: number, _modifiers: Set<types.KeyboardModifier>): Promise<void> {
    // Touch events are not easily dispatched from content scripts.
    // Fall back to click behavior.
  }
}

export class BCPage implements PageDelegate {
  readonly rawMouse: BCRawMouse;
  readonly rawKeyboard: BCRawKeyboard;
  readonly rawTouchscreen: BCRawTouchscreen;
  readonly _page: Page;
  readonly _connection: BrowserControlConnection;
  readonly _browserContext: BCBrowserContext;
  private _mainContext: BCExecutionContext;
  private _utilityContext: BCExecutionContext;

  constructor(connection: BrowserControlConnection, browserContext: BCBrowserContext) {
    this._connection = connection;
    this._browserContext = browserContext;
    this.rawKeyboard = new BCRawKeyboard(connection);
    this.rawMouse = new BCRawMouse(connection);
    this.rawTouchscreen = new BCRawTouchscreen();
    this._mainContext = new BCExecutionContext(connection);
    this._utilityContext = new BCExecutionContext(connection);
    this._page = new Page(this, browserContext);
  }

  async initialize(): Promise<void> {
    // Set up the main frame.
    const frameId = 'bc-main-frame';
    this._page.frameManager.frameAttached(frameId, null);
    const mainFrame = this._page.frameManager.mainFrame();

    // Set up execution contexts for the main frame.
    const mainExecContext = new dom.FrameExecutionContext(this._mainContext, mainFrame, 'main');
    const utilityExecContext = new dom.FrameExecutionContext(this._utilityContext, mainFrame, 'utility');
    mainFrame._contextCreated('main', mainExecContext);
    mainFrame._contextCreated('utility', utilityExecContext);

    // Fire initial lifecycle events.
    mainFrame._onLifecycleEvent('commit' as any);
    mainFrame._onLifecycleEvent('domcontentloaded');
    mainFrame._onLifecycleEvent('load');

    // Report page as initialized.
    await this._page.reportAsNew(undefined);
  }

  private _recreateContexts(): void {
    this._mainContext.resetHandleStore();
    this._utilityContext.resetHandleStore();
    this._mainContext = new BCExecutionContext(this._connection);
    this._utilityContext = new BCExecutionContext(this._connection);
    const mainFrame = this._page.frameManager.mainFrame();
    const mainExecContext = new dom.FrameExecutionContext(this._mainContext, mainFrame, 'main');
    const utilityExecContext = new dom.FrameExecutionContext(this._utilityContext, mainFrame, 'utility');
    mainFrame._contextCreated('main', mainExecContext);
    mainFrame._contextCreated('utility', utilityExecContext);
  }

  async navigateFrame(frame: frames.Frame, url: string, _referrer: string | undefined): Promise<frames.GotoResult> {
    const documentId = 'bc-nav-' + Date.now();
    const mainFrame = this._page.frameManager.mainFrame();

    // Signal that navigation is starting.
    this._page.frameManager.frameRequestedNavigation(frame._id, documentId);

    try {
      await this._connection.navigate(url);
    } catch (e: any) {
      throw new frames.NavigationAbortedError(documentId, e.message);
    }

    // Recreate execution contexts (old page is gone).
    this._recreateContexts();

    // Signal navigation committed.
    this._page.frameManager.frameCommittedNewDocumentNavigation(
        frame._id, url, frame.name(), documentId, false);

    // Fire lifecycle events.
    mainFrame._onLifecycleEvent('domcontentloaded');
    mainFrame._onLifecycleEvent('load');

    return { newDocumentId: documentId };
  }

  async reload(): Promise<void> {
    await this._connection.execute('location.reload()');
  }

  async goBack(): Promise<boolean> {
    await this._connection.execute('history.back()');
    return true;
  }

  async goForward(): Promise<boolean> {
    await this._connection.execute('history.forward()');
    return true;
  }

  async requestGC(): Promise<void> {
    // Not supported.
  }

  async addInitScript(_initScript: InitScript): Promise<void> {
    // Not supported through browser-control.
  }

  async removeInitScripts(_initScripts: InitScript[]): Promise<void> {
    // Not supported.
  }

  async closePage(_runBeforeUnload: boolean): Promise<void> {
    await this._connection.closeSession();
  }

  async updateExtraHTTPHeaders(): Promise<void> { }
  async updateEmulateMedia(): Promise<void> { }
  async updateRequestInterception(): Promise<void> { }
  async updateFileChooserInterception(): Promise<void> { }

  async updateEmulatedViewportSize(_preserveWindowBoundaries?: boolean): Promise<void> {
    const size = this._page.emulatedSize();
    if (!size)
      return;
    await this._connection.resize(size.viewport.width, size.viewport.height);
  }

  async bringToFront(): Promise<void> { }

  async setBackgroundColor(_color?: { r: number; g: number; b: number; a: number }): Promise<void> { }

  async takeScreenshot(_progress: Progress, format: string, _documentRect: types.Rect | undefined, _viewportRect: types.Rect | undefined, quality: number | undefined, _fitsViewport: boolean, _scale: 'css' | 'device'): Promise<Buffer> {
    const dataUrl = await this._connection.screenshot();
    // dataUrl is like "data:image/png;base64,..."
    const base64Data = dataUrl.split(',')[1];
    return Buffer.from(base64Data, 'base64');
  }

  async adoptElementHandle<T extends Node>(handle: dom.ElementHandle<T>, to: dom.FrameExecutionContext): Promise<dom.ElementHandle<T>> {
    // Since we only have one frame, adoption is a no-op - just return a new handle in the target context.
    const script = `
(function() {
  var __obj = window.__pwHandles.get(${JSON.stringify(handle._objectId)});
  var __id = '__pw_' + window.__pwNextId++;
  window.__pwHandles.set(__id, __obj);
  return { __pwHandle: true, id: __id, isNode: true, type: 'object' };
})()
`;
    const metadata = await this._connection.execute(script);
    return new dom.ElementHandle<T>(to, metadata.id);
  }

  async getContentFrame(_handle: dom.ElementHandle): Promise<frames.Frame | null> {
    return null;
  }

  async getOwnerFrame(_handle: dom.ElementHandle): Promise<string | null> {
    return this._page.frameManager.mainFrame()._id;
  }

  async getContentQuads(handle: dom.ElementHandle): Promise<types.Quad[] | null | 'error:notconnected'> {
    const script = `
(function() {
  var el = window.__pwHandles.get(${JSON.stringify(handle._objectId)});
  if (!el || !el.getClientRects) return null;
  var rect = el.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return [[
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom }
  ]];
})()
`;
    return await this._connection.execute(script);
  }

  async setInputFilePaths(_handle: dom.ElementHandle<HTMLInputElement>, _files: string[]): Promise<void> {
    throw new Error('File upload is not supported with browser-control backend');
  }

  async getBoundingBox(handle: dom.ElementHandle): Promise<types.Rect | null> {
    const script = `
(function() {
  var el = window.__pwHandles.get(${JSON.stringify(handle._objectId)});
  if (!el || !el.getBoundingClientRect) return null;
  var rect = el.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
})()
`;
    return await this._connection.execute(script);
  }

  async getFrameElement(_frame: frames.Frame): Promise<dom.ElementHandle> {
    throw new Error('getFrameElement is not supported with browser-control backend');
  }

  async scrollRectIntoViewIfNeeded(handle: dom.ElementHandle, _rect?: types.Rect): Promise<'error:notvisible' | 'error:notconnected' | 'done'> {
    const script = `
(function() {
  var el = window.__pwHandles.get(${JSON.stringify(handle._objectId)});
  if (!el) return 'error:notconnected';
  el.scrollIntoView({ block: 'center', inline: 'center' });
  return 'done';
})()
`;
    return await this._connection.execute(script);
  }

  async startScreencast(_options: { width: number; height: number; quality: number }): Promise<void> { }
  async stopScreencast(): Promise<void> { }

  rafCountForStablePosition(): number { return 1; }
  async inputActionEpilogue(): Promise<void> { }
  async resetForReuse(_progress: Progress): Promise<void> { }
  shouldToggleStyleSheetToSyncAnimations(): boolean { return false; }
  async setDockTile(_image: Buffer): Promise<void> { }
}
