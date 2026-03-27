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

// ---------------------------------------------------------------------------
// Shared helpers injected into the page for realistic event dispatch.
// ---------------------------------------------------------------------------

// Iframe-aware element resolution: recursively finds element at page coordinates (x,y),
// piercing through iframes by translating to each iframe's local coordinate space.
// Returns {el, lx, ly, w} where lx/ly are viewport coords in the target document
// and w is the target document's window.
const RESOLVE_HELPER = `function __r(x,y){var d=document,lx=x,ly=y;for(var i=0;i<10;i++){var e=d.elementFromPoint(lx,ly);if(!e)return null;if(e.tagName==='IFRAME'||e.tagName==='FRAME'){try{var c=e.contentDocument;if(c){var r=e.getBoundingClientRect();lx-=r.left+e.clientLeft;ly-=r.top+e.clientTop;d=c;continue}}catch(x){}}return{el:e,lx:lx,ly:ly,w:e.ownerDocument.defaultView||window}}return null}`;

// MouseEvent init properties. cx/cy are JS expressions for local client coordinates
// (e.g. 't.lx'), sx/sy are numeric screen coordinates, view is a JS expression for the window.
function mouseInit(cx: string, cy: string, sx: number, sy: number, button: number, clickCount: number, view: string = 'window'): string {
  return `clientX:${cx},clientY:${cy},screenX:${sx},screenY:${sy},button:${button},buttons:${button === 0 ? 1 : button === 2 ? 2 : 4},detail:${clickCount},bubbles:true,cancelable:true,composed:true,view:${view}`;
}

// PointerEvent init (extends mouse init).
function pointerInit(cx: string, cy: string, sx: number, sy: number, button: number, clickCount: number, view: string = 'window', pointerId: number = 1): string {
  return `${mouseInit(cx, cy, sx, sy, button, clickCount, view)},pointerId:${pointerId},pointerType:'mouse',isPrimary:true,width:1,height:1,pressure:${button >= 0 ? 0.5 : 0}`;
}

function keyInit(description: input.KeyDescription): string {
  return `key:${JSON.stringify(description.key)},code:${JSON.stringify(description.code)},keyCode:${description.keyCode},which:${description.keyCode},bubbles:true,cancelable:true,composed:true,view:window`;
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

class BCRawKeyboard implements input.RawKeyboard {
  private _connection: BrowserControlConnection;
  private _onPotentialNavigation: ((url: string) => Promise<void>) | undefined;

  constructor(connection: BrowserControlConnection) {
    this._connection = connection;
  }

  setNavigationCallback(callback: (url: string) => Promise<void>) {
    this._onPotentialNavigation = callback;
  }

  async keydown(_progress: Progress, modifiers: Set<types.KeyboardModifier>, _keyName: string, description: input.KeyDescription, autoRepeat: boolean): Promise<void> {
    const ki = keyInit(description);
    const isPrintable = description.key.length === 1;
    const charEsc = JSON.stringify(description.key);
    const key = description.key;
    const hasShift = modifiers.has('Shift');

    // Navigation keys: manually adjust cursor since untrusted events don't move it.
    const isNavKey = ['Home', 'End', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key);
    const isDelete = key === 'Delete' || key === 'Backspace';
    const isSelectAll = key === 'a' && modifiers.has('Control') || key === 'a' && modifiers.has('Meta');

    // Full sequence: keydown → (for printable chars: keypress → insert text + InputEvent)
    const code = `
(function(){
  var el = document.activeElement;
  while (el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME')) { try { el = el.contentDocument.activeElement; } catch(e) { break; } }
  if (!el) return;
  el.dispatchEvent(new KeyboardEvent('keydown', {${ki},repeat:${autoRepeat}}));
  ${isNavKey ? `
  if ('selectionStart' in el) {
    var start = el.selectionStart || 0;
    var end = el.selectionEnd || 0;
    var len = (el.value || '').length;
    var hasSelection = start !== end;
    var key = ${JSON.stringify(key)};
    var shift = ${hasShift};
    var anchor = shift ? start : null;
    var pos;
    if (key === 'Home' || key === 'ArrowUp') pos = 0;
    else if (key === 'End' || key === 'ArrowDown') pos = len;
    else if (key === 'ArrowLeft') pos = (hasSelection && !shift) ? Math.min(start, end) : Math.max(0, start - 1);
    else if (key === 'ArrowRight') pos = (hasSelection && !shift) ? Math.max(start, end) : Math.min(len, end + 1);
    if (shift) {
      el.selectionStart = Math.min(anchor !== null ? anchor : start, pos);
      el.selectionEnd = Math.max(anchor !== null ? anchor : start, pos);
    } else {
      el.selectionStart = el.selectionEnd = pos;
    }
  } else if (el.isContentEditable) {
    var sel = window.getSelection();
    if (sel && sel.rangeCount) {
      var key = ${JSON.stringify(key)};
      if (key === 'Home' || key === 'ArrowUp') sel.modify(${hasShift} ? 'extend' : 'move', 'backward', key === 'Home' || key === 'ArrowUp' ? 'lineboundary' : 'character');
      else if (key === 'End' || key === 'ArrowDown') sel.modify(${hasShift} ? 'extend' : 'move', 'forward', key === 'End' || key === 'ArrowDown' ? 'lineboundary' : 'character');
      else if (key === 'ArrowLeft') sel.modify(${hasShift} ? 'extend' : 'move', 'backward', 'character');
      else if (key === 'ArrowRight') sel.modify(${hasShift} ? 'extend' : 'move', 'forward', 'character');
    }
  }
  ` : isSelectAll ? `
  if ('selectionStart' in el) {
    el.selectionStart = 0;
    el.selectionEnd = (el.value || '').length;
  } else if (el.isContentEditable) {
    var sel = window.getSelection();
    if (sel) { sel.selectAllChildren(el); }
  }
  ` : isDelete ? `
  if ('value' in el) {
    var start = el.selectionStart || 0;
    var end = el.selectionEnd || 0;
    var val = el.value;
    var setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    var next, newPos;
    if (start !== end) {
      next = val.slice(0, start) + val.slice(end);
      newPos = start;
    } else if (${JSON.stringify(key)} === 'Backspace' && start > 0) {
      next = val.slice(0, start - 1) + val.slice(start);
      newPos = start - 1;
    } else if (${JSON.stringify(key)} === 'Delete' && start < val.length) {
      next = val.slice(0, start) + val.slice(start + 1);
      newPos = start;
    } else { next = val; newPos = start; }
    if (setter && setter.set) setter.set.call(el, next); else el.value = next;
    el.selectionStart = el.selectionEnd = newPos;
    el.dispatchEvent(new InputEvent('input', {bubbles:true,cancelable:false,inputType:${JSON.stringify(key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward')}}));
  } else if (el.isContentEditable) {
    document.execCommand(${JSON.stringify(key === 'Backspace' ? 'delete' : 'forwardDelete')});
  }
  ` : isPrintable ? `
  el.dispatchEvent(new KeyboardEvent('keypress', {${ki},charCode:${JSON.stringify(description.key)}.charCodeAt(0)}));
  if (el.isContentEditable) {
    document.execCommand('insertText', false, ${charEsc});
  } else if ('value' in el) {
    var start = el.selectionStart || 0;
    var end = el.selectionEnd || 0;
    var val = el.value;
    var setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    var next = val.slice(0, start) + ${charEsc} + val.slice(end);
    if (setter && setter.set) setter.set.call(el, next); else el.value = next;
    el.selectionStart = el.selectionEnd = start + 1;
    el.dispatchEvent(new InputEvent('input', {bubbles:true,cancelable:false,inputType:'insertText',data:${charEsc}}));
  }
  ` : ''}
})();
`;
    await this._connection.execute(code);
  }

  async keyup(_progress: Progress, _modifiers: Set<types.KeyboardModifier>, _keyName: string, description: input.KeyDescription): Promise<void> {
    const ki = keyInit(description);
    const key = description.key;
    // For Enter (form submit), check if navigation happened after the key event.
    const checkNav = key === 'Enter';
    const code = `
(function(){
  var el = document.activeElement;
  if (el) el.dispatchEvent(new KeyboardEvent('keyup', {${ki}}));
  ${checkNav ? `return { urlAfter: location.href };` : ''}
})();
`;
    const result = await this._connection.execute(code);
    if (checkNav && result && this._onPotentialNavigation) {
      // Wait briefly for navigation to start, then check.
      await new Promise(r => setTimeout(r, 200));
      try {
        const status = await this._connection.execute('({ href: location.href })');
        if (status && status.href !== result.urlAfter)
          await this._onPotentialNavigation(status.href);
      } catch {
        // Page is mid-navigation — will be detected on next operation.
      }
    }
  }

  async sendText(_progress: Progress, text: string): Promise<void> {
    const escaped = JSON.stringify(text);
    const code = `
(function(){
  var el = document.activeElement;
  while (el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME')) { try { el = el.contentDocument.activeElement; } catch(e) { break; } }
  if (!el) return;
  if (el.isContentEditable) {
    document.execCommand('insertText', false, ${escaped});
  } else if ('value' in el) {
    var start = el.selectionStart || 0;
    var end = el.selectionEnd || 0;
    var val = el.value;
    var setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    var next = val.slice(0, start) + ${escaped} + val.slice(end);
    if (setter && setter.set) setter.set.call(el, next); else el.value = next;
    el.selectionStart = el.selectionEnd = start + ${escaped}.length;
    el.dispatchEvent(new InputEvent('input', {bubbles:true,cancelable:false,inputType:'insertText',data:${escaped}}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
  }
})();
`;
    await this._connection.execute(code);
  }
}

// ---------------------------------------------------------------------------
// Mouse — full pointer + mouse event sequence matching real browser behavior.
//
// Real browser sequence for a click at (x, y):
//   pointerover → mouseover → pointerenter → mouseenter →
//   pointermove → mousemove →
//   pointerdown → mousedown → (focus) →
//   pointerup   → mouseup  → click
// ---------------------------------------------------------------------------

class BCRawMouse implements input.RawMouse {
  private _connection: BrowserControlConnection;
  private _lastX: number = 0;
  private _lastY: number = 0;
  private _onPotentialNavigation: ((url: string) => Promise<void>) | undefined;

  constructor(connection: BrowserControlConnection) {
    this._connection = connection;
  }

  setNavigationCallback(callback: (url: string) => Promise<void>) {
    this._onPotentialNavigation = callback;
  }

  async move(_progress: Progress, x: number, y: number, _button: types.MouseButton | 'none', _buttons: Set<types.MouseButton>, _modifiers: Set<types.KeyboardModifier>, _forClick: boolean): Promise<void> {
    const prevX = this._lastX;
    const prevY = this._lastY;
    this._lastX = x;
    this._lastY = y;
    const code = `
(function(){
  ${RESOLVE_HELPER}
  var p = __r(${prevX}, ${prevY});
  var c = __r(${x}, ${y});
  if (!c) return;
  var el = c.el;
  var prev = p ? p.el : null;
  if (el !== prev) {
    if (prev) {
      prev.dispatchEvent(new PointerEvent('pointerout', {${pointerInit('p.lx', 'p.ly', x, y, -1, 0, 'p.w')}}));
      prev.dispatchEvent(new MouseEvent('mouseout', {${mouseInit('p.lx', 'p.ly', x, y, 0, 0, 'p.w')},relatedTarget:el}));
      prev.dispatchEvent(new PointerEvent('pointerleave', {${pointerInit('p.lx', 'p.ly', x, y, -1, 0, 'p.w')},bubbles:false}));
      prev.dispatchEvent(new MouseEvent('mouseleave', {${mouseInit('p.lx', 'p.ly', x, y, 0, 0, 'p.w')},relatedTarget:el,bubbles:false}));
    }
    el.dispatchEvent(new PointerEvent('pointerover', {${pointerInit('c.lx', 'c.ly', x, y, -1, 0, 'c.w')}}));
    el.dispatchEvent(new MouseEvent('mouseover', {${mouseInit('c.lx', 'c.ly', x, y, 0, 0, 'c.w')},relatedTarget:prev}));
    el.dispatchEvent(new PointerEvent('pointerenter', {${pointerInit('c.lx', 'c.ly', x, y, -1, 0, 'c.w')},bubbles:false}));
    el.dispatchEvent(new MouseEvent('mouseenter', {${mouseInit('c.lx', 'c.ly', x, y, 0, 0, 'c.w')},relatedTarget:prev,bubbles:false}));
  }
  el.dispatchEvent(new PointerEvent('pointermove', {${pointerInit('c.lx', 'c.ly', x, y, -1, 0, 'c.w')}}));
  el.dispatchEvent(new MouseEvent('mousemove', {${mouseInit('c.lx', 'c.ly', x, y, 0, 0, 'c.w')}}));
})();
`;
    await this._connection.execute(code);
  }

  async down(_progress: Progress, x: number, y: number, button: types.MouseButton, _buttons: Set<types.MouseButton>, modifiers: Set<types.KeyboardModifier>, clickCount: number): Promise<void> {
    const buttonNum = button === 'left' ? 0 : button === 'right' ? 2 : 1;
    const hasShift = modifiers.has('Shift');
    this._lastX = x;
    this._lastY = y;
    const code = `
(function(){
  ${RESOLVE_HELPER}
  var t = __r(${x}, ${y});
  if (!t) return;
  var el = t.el;
  var doc = el.ownerDocument || document;
  el.dispatchEvent(new PointerEvent('pointerdown', {${pointerInit('t.lx', 't.ly', x, y, buttonNum, clickCount, 't.w')}}));
  el.dispatchEvent(new MouseEvent('mousedown', {${mouseInit('t.lx', 't.ly', x, y, buttonNum, clickCount, 't.w')}}));
  if (el.focus && el !== doc.body && el !== doc.documentElement) el.focus();
  // Position text cursor at click point for input/textarea elements.
  if ('selectionStart' in el && ('value' in el)) {
    var rect = el.getBoundingClientRect();
    var style = t.w.getComputedStyle(el);
    var padL = parseFloat(style.paddingLeft) || 0;
    var clickX = t.lx - rect.left - padL + (el.scrollLeft || 0);
    var val = el.value || '';
    var canvas = doc.createElement('canvas');
    var ctx = canvas.getContext('2d');
    ctx.font = style.font;
    var best = 0;
    var bestDist = Infinity;
    for (var i = 0; i <= val.length; i++) {
      var w = ctx.measureText(val.slice(0, i)).width;
      var d = Math.abs(w - clickX);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    if (${hasShift}) {
      var anchor = el.selectionStart || 0;
      el.selectionStart = Math.min(anchor, best);
      el.selectionEnd = Math.max(anchor, best);
    } else if (${clickCount} >= 2) {
      var wordStart = best, wordEnd = best;
      while (wordStart > 0 && /\\w/.test(val[wordStart - 1])) wordStart--;
      while (wordEnd < val.length && /\\w/.test(val[wordEnd])) wordEnd++;
      el.selectionStart = wordStart;
      el.selectionEnd = wordEnd;
    } else {
      el.selectionStart = el.selectionEnd = best;
    }
  } else if (el.isContentEditable) {
    var range = doc.caretRangeFromPoint(t.lx, t.ly);
    if (range) {
      var sel = t.w.getSelection();
      if (${hasShift} && sel.rangeCount) {
        sel.extend(range.startContainer, range.startOffset);
      } else {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }
})();
`;
    await this._connection.execute(code);
  }

  async up(_progress: Progress, x: number, y: number, button: types.MouseButton, _buttons: Set<types.MouseButton>, _modifiers: Set<types.KeyboardModifier>, clickCount: number): Promise<void> {
    const buttonNum = button === 'left' ? 0 : button === 'right' ? 2 : 1;
    this._lastX = x;
    this._lastY = y;
    const code = `
(function(){
  ${RESOLVE_HELPER}
  var t = __r(${x}, ${y});
  if (!t) return Promise.resolve({});
  var el = t.el;
  el.dispatchEvent(new PointerEvent('pointerup', {${pointerInit('t.lx', 't.ly', x, y, buttonNum, clickCount, 't.w')}}));
  el.dispatchEvent(new MouseEvent('mouseup', {${mouseInit('t.lx', 't.ly', x, y, buttonNum, clickCount, 't.w')}}));
  var urlBefore = location.href;
  // el.click() triggers default actions (navigation, submit) from content scripts
  // unlike dispatchEvent(new MouseEvent('click')) which creates untrusted events.
  el.click();
  // Only detect navigation for clicks in the main document (not inside iframes).
  var isMainDoc = t.w === window;
  var link = isMainDoc && el.closest ? el.closest('a[href]') : null;
  var linkHref = link && link.href && link.href !== urlBefore ? link.href : null;
  var formAction = null;
  if (isMainDoc && !linkHref && el.closest) {
    var form = el.closest('form');
    if (form) {
      var tag = el.tagName;
      var type = (el.type || '').toLowerCase();
      var isSubmit = (tag === 'BUTTON' && type !== 'button' && type !== 'reset')
                  || (tag === 'INPUT' && (type === 'submit' || type === 'image'));
      if (isSubmit) formAction = form.action || urlBefore;
    }
  }
  // Check URL synchronously first, then after a microtask to catch
  // JS-driven navigation (onclick setting location.href) which is
  // scheduled but not yet processed.
  var urlAfter = location.href;
  if (urlAfter !== urlBefore || linkHref || formAction)
    return { urlAfter: urlAfter, linkHref: linkHref, formAction: formAction, navigated: urlBefore !== urlAfter };
  return Promise.resolve().then(function() {
    return { urlAfter: location.href, linkHref: null, formAction: null, navigated: location.href !== urlBefore };
  });
})();
`;
    const result = await this._connection.execute(code);
    // Detect navigation: URL changed synchronously, link clicked, or form submitted.
    if (result && this._onPotentialNavigation) {
      if (result.navigated)
        await this._onPotentialNavigation(result.urlAfter);
      else if (result.linkHref)
        await this._onPotentialNavigation(result.linkHref);
      else if (result.formAction)
        await this._onPotentialNavigation(result.formAction);
    }
  }

  async wheel(_progress: Progress, x: number, y: number, _buttons: Set<types.MouseButton>, _modifiers: Set<types.KeyboardModifier>, deltaX: number, deltaY: number): Promise<void> {
    const code = `
(function(){
  ${RESOLVE_HELPER}
  var t = __r(${x}, ${y});
  if (t && t.el) t.el.dispatchEvent(new WheelEvent('wheel', {clientX:t.lx,clientY:t.ly,deltaX:${deltaX},deltaY:${deltaY},deltaMode:0,bubbles:true,cancelable:true,composed:true,view:t.w}));
})();
`;
    await this._connection.execute(code);
  }
}

class BCRawTouchscreen implements input.RawTouchscreen {
  async tap(_progress: Progress, _x: number, _y: number, _modifiers: Set<types.KeyboardModifier>): Promise<void> {
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
    this.rawKeyboard.setNavigationCallback(url => this._onImplicitNavigation(url));
    this.rawMouse = new BCRawMouse(connection);
    this.rawTouchscreen = new BCRawTouchscreen();
    this._mainContext = new BCExecutionContext(connection);
    this._utilityContext = new BCExecutionContext(connection);
    this._page = new Page(this, browserContext);
    this.rawMouse.setNavigationCallback(url => this._onImplicitNavigation(url));
  }

  private async _onImplicitNavigation(url: string): Promise<void> {
    const mainFrame = this._page.frameManager.mainFrame();
    if (url === mainFrame._url)
      return;
    const documentId = 'bc-implicit-nav-' + Date.now();
    // Signal pending navigation — this aborts any stalled raceAgainstEvaluationStallingEvents.
    this._page.frameManager.frameRequestedNavigation(mainFrame._id, documentId);

    // Wait for the new page to actually load. After el.click() triggers navigation,
    // chrome.tabs.executeScript will queue scripts until the new page is ready.
    // Poll until we confirm the URL changed and the document finished loading.
    const originalUrl = mainFrame._url;
    let finalUrl = url;
    for (let i = 0; i < 100; i++) { // Up to ~10 seconds
      try {
        const result = await this._connection.execute(
          '({ href: location.href, ready: document.readyState })'
        );
        if (result && result.href !== originalUrl) {
          finalUrl = result.href;
          if (result.ready === 'complete')
            break;
        }
      } catch {
        // Page may be mid-navigation — retry.
      }
      await new Promise(r => setTimeout(r, 100));
    }

    // Recreate execution contexts (old page handles are invalid).
    this._recreateContexts();
    // Commit the navigation with the actual final URL.
    this._page.frameManager.frameCommittedNewDocumentNavigation(
        mainFrame._id, finalUrl, mainFrame.name(), documentId, false);
    mainFrame._onLifecycleEvent('domcontentloaded');
    mainFrame._onLifecycleEvent('load');
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
    const mainFrame = this._page.frameManager.mainFrame();
    const originalUrl = mainFrame._url;
    const documentId = 'bc-reload-' + Date.now();
    this._page.frameManager.frameRequestedNavigation(mainFrame._id, documentId);
    await this._connection.execute('location.reload()');
    await this._waitForNavigation(originalUrl, documentId, true /* sameUrlExpected */);
  }

  async goBack(): Promise<boolean> {
    return await this._historyNavigation('history.back()');
  }

  async goForward(): Promise<boolean> {
    return await this._historyNavigation('history.forward()');
  }

  private async _historyNavigation(script: string): Promise<boolean> {
    const mainFrame = this._page.frameManager.mainFrame();
    const originalUrl = mainFrame._url;
    const documentId = 'bc-history-' + Date.now();
    this._page.frameManager.frameRequestedNavigation(mainFrame._id, documentId);
    await this._connection.execute(script);
    // Wait briefly for the navigation to start, then detect the new URL.
    await new Promise(r => setTimeout(r, 200));
    await this._waitForNavigation(originalUrl, documentId, false /* sameUrlExpected */);
    return true;
  }

  private async _waitForNavigation(originalUrl: string, documentId: string, sameUrlExpected: boolean): Promise<void> {
    const mainFrame = this._page.frameManager.mainFrame();
    let finalUrl = originalUrl;
    for (let i = 0; i < 100; i++) { // Up to ~10 seconds
      try {
        const result = await this._connection.execute(
          '({ href: location.href, ready: document.readyState })'
        );
        if (result) {
          finalUrl = result.href;
          if ((sameUrlExpected || result.href !== originalUrl) && result.ready === 'complete')
            break;
        }
      } catch {
        // Page may be mid-navigation — retry.
      }
      await new Promise(r => setTimeout(r, 100));
    }
    this._recreateContexts();
    this._page.frameManager.frameCommittedNewDocumentNavigation(
        mainFrame._id, finalUrl, mainFrame.name(), documentId, false);
    mainFrame._onLifecycleEvent('domcontentloaded');
    mainFrame._onLifecycleEvent('load');
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
    await this._connection.closeSession().catch(() => {});
    this._page._didClose();
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

  async takeScreenshot(_progress: Progress, format: string, documentRect: types.Rect | undefined, viewportRect: types.Rect | undefined, quality: number | undefined, _fitsViewport: boolean, _scale: 'css' | 'device'): Promise<Buffer> {
    const clip = viewportRect || documentRect;
    const dataUrl = await this._connection.screenshot(clip);
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
  async inputActionEpilogue(): Promise<void> {
    // Catch-all: detect navigation caused by any input action (form submit,
    // JS-driven location changes, etc.) that wasn't caught by the click handler.
    // Check twice with a delay because navigation triggered by JS event handlers
    // (e.g., onclick setting location.href) is async — the browser processes
    // it after the current JS task completes.
    try {
      const mainFrame = this._page.frameManager.mainFrame();
      const originalUrl = mainFrame._url;
      let result = await this._connection.execute(
        '({ href: location.href, ready: document.readyState })'
      );
      if (!result || result.href === originalUrl) {
        // URL hasn't changed yet — wait briefly and recheck in case
        // navigation was triggered but hasn't been processed yet.
        await new Promise(r => setTimeout(r, 100));
        try {
          result = await this._connection.execute(
            '({ href: location.href, ready: document.readyState })'
          );
        } catch {
          // Page is mid-navigation — treat as navigated.
          return;
        }
      }
      if (result && result.href !== originalUrl) {
        // URL changed — wait for the page to finish loading.
        let finalUrl = result.href;
        if (result.ready !== 'complete') {
          for (let i = 0; i < 100; i++) {
            try {
              const status = await this._connection.execute(
                '({ href: location.href, ready: document.readyState })'
              );
              if (status) {
                finalUrl = status.href;
                if (status.ready === 'complete')
                  break;
              }
            } catch {
              // Page may be mid-navigation — retry.
            }
            await new Promise(r => setTimeout(r, 100));
          }
        }
        const documentId = 'bc-epilogue-nav-' + Date.now();
        this._recreateContexts();
        this._page.frameManager.frameCommittedNewDocumentNavigation(
            mainFrame._id, finalUrl, mainFrame.name(), documentId, false);
        mainFrame._onLifecycleEvent('domcontentloaded');
        mainFrame._onLifecycleEvent('load');
      }
    } catch {
      // Page may be mid-navigation or unloaded — ignore.
    }
  }
  async resetForReuse(_progress: Progress): Promise<void> { }
  shouldToggleStyleSheetToSyncAnimations(): boolean { return false; }
  async setDockTile(_image: Buffer): Promise<void> { }
}
