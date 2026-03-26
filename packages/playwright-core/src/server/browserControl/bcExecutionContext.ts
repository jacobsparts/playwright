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

import * as js from '../javascript';
import * as dom from '../dom';
import { parseEvaluationResultValue } from '../../utils/isomorphic/utilityScriptSerializers';

import type { BrowserControlConnection } from './bcConnection';

const HANDLE_STORE_INIT = `
(function() {
  if (window.__pwHandles) return;
  window.__pwHandles = new Map();
  window.__pwNextId = 1;
})();
`;

export class BCExecutionContext implements js.ExecutionContextDelegate {
  private _connection: BrowserControlConnection;
  private _handleStoreInitialized = false;

  constructor(connection: BrowserControlConnection) {
    this._connection = connection;
  }

  private async _ensureHandleStore(): Promise<void> {
    if (this._handleStoreInitialized)
      return;
    await this._connection.execute(HANDLE_STORE_INIT);
    this._handleStoreInitialized = true;
  }

  resetHandleStore(): void {
    this._handleStoreInitialized = false;
  }

  private async _awaitIfAsync(result: any): Promise<any> {
    // chrome.tabs.executeScript can't await Promises, so Promises serialize as {}.
    // If we get a pending async marker, poll for the result.
    if (result && typeof result === 'object' && result.__pwAsync) {
      const asyncId = result.id;
      const maxAttempts = 600; // 30 seconds at 50ms intervals
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 50));
        const status = await this._connection.execute(
          `(function() { var r = window.__pwHandles.get(${JSON.stringify(asyncId)}); return r; })()`
        );
        if (status && status.__pwDone)
          return status.value;
        if (status && status.__pwError)
          throw new js.JavaScriptErrorInEvaluate(status.message);
      }
      throw new Error('Async evaluation timed out');
    }
    return result;
  }

  async rawEvaluateJSON(expression: string): Promise<any> {
    try {
      return await this._connection.execute(expression);
    } catch (e: any) {
      if (e.message?.includes('server error'))
        throw new js.JavaScriptErrorInEvaluate(e.message);
      throw e;
    }
  }

  async rawEvaluateHandle(context: js.ExecutionContext, expression: string): Promise<js.JSHandle> {
    await this._ensureHandleStore();
    const escapedExpr = JSON.stringify(expression);
    // Use synchronous eval to avoid Promise serialization issues.
    // If the expression returns a Promise, we store it and poll.
    const script = `
(function() {
  var __result;
  try { __result = (0, eval)(${escapedExpr}); } catch(e) { return { __pwError: true, message: e.message }; }
  if (__result && typeof __result === 'object' && typeof __result.then === 'function') {
    var __asyncId = '__pw_async_' + window.__pwNextId++;
    __result.then(
      function(r) { window.__pwHandles.set(__asyncId, { __pwDone: true, value: r }); },
      function(e) { window.__pwHandles.set(__asyncId, { __pwError: true, message: e.message }); }
    );
    return { __pwAsync: true, id: __asyncId };
  }
  var __id = '__pw_' + window.__pwNextId++;
  window.__pwHandles.set(__id, __result);
  var __isNode = __result instanceof Node;
  var __val;
  try { __val = JSON.parse(JSON.stringify(__result)); } catch(e) {}
  return { __pwHandle: true, id: __id, isNode: __isNode, type: typeof __result, value: __val };
})()
`;
    let metadata = await this._connection.execute(script);
    if (metadata && metadata.__pwError)
      throw new js.JavaScriptErrorInEvaluate(metadata.message);

    // Handle async result: poll until resolved, then store the resolved value.
    if (metadata && metadata.__pwAsync) {
      const resolved = await this._awaitIfAsync(metadata);
      const storeScript = `
(function() {
  var __asyncEntry = window.__pwHandles.get(${JSON.stringify(metadata.id)});
  var __result = __asyncEntry && __asyncEntry.value !== undefined ? __asyncEntry.value : ${JSON.stringify(resolved)};
  var __id = '__pw_' + window.__pwNextId++;
  window.__pwHandles.set(__id, __result);
  var __isNode = false;
  var __val;
  try { __val = JSON.parse(JSON.stringify(__result)); } catch(e) {}
  return { __pwHandle: true, id: __id, isNode: __isNode, type: typeof __result, value: __val };
})()
`;
      metadata = await this._connection.execute(storeScript);
    }

    if (metadata && metadata.__pwHandle)
      return this._createHandle(context, metadata);
    return new js.JSHandle(context, typeof metadata, String(metadata), undefined, metadata);
  }

  async evaluateWithArguments(expression: string, returnByValue: boolean, utilityScript: js.JSHandle, values: any[], handles: js.JSHandle[]): Promise<any> {
    await this._ensureHandleStore();
    const utilityId = utilityScript._objectId;

    // Build arguments array
    const argParts: string[] = [];
    argParts.push(`window.__pwHandles.get(${JSON.stringify(utilityId)})`);
    for (const v of values)
      argParts.push(JSON.stringify(v));
    for (const h of handles)
      argParts.push(`window.__pwHandles.get(${JSON.stringify(h._objectId)})`);

    const storeResultCode = returnByValue ? 'return __result;' : `
      var __id = '__pw_' + window.__pwNextId++;
      window.__pwHandles.set(__id, __result);
      var __isNode = __result instanceof Node;
      var __val;
      try { __val = JSON.parse(JSON.stringify(__result)); } catch(e) {}
      return { __pwHandle: true, id: __id, isNode: __isNode, type: typeof __result, value: __val };
    `;

    // Synchronous evaluation with async fallback via polling.
    const script = `
(function() {
  var __fn = ${expression};
  var __self = window.__pwHandles.get(${JSON.stringify(utilityId)});
  var __args = [${argParts.join(', ')}];
  var __result;
  try { __result = __fn.apply(__self, __args); } catch(e) { return { __pwError: true, message: e.message }; }
  if (__result && typeof __result === 'object' && typeof __result.then === 'function') {
    var __asyncId = '__pw_async_' + window.__pwNextId++;
    __result.then(
      function(r) {
        window.__pwHandles.set(__asyncId, { __pwDone: true, value: r,
          isNode: r instanceof Node, type: typeof r });
      },
      function(e) { window.__pwHandles.set(__asyncId, { __pwError: true, message: e.message }); }
    );
    return { __pwAsync: true, id: __asyncId, returnByValue: ${returnByValue} };
  }
  ${storeResultCode}
})()
`;

    try {
      let result = await this._connection.execute(script);
      if (result && result.__pwError)
        throw new js.JavaScriptErrorInEvaluate(result.message);

      // Handle async result
      if (result && result.__pwAsync) {
        const resolved = await this._awaitIfAsync(result);
        if (returnByValue)
          return parseEvaluationResultValue(resolved.value !== undefined ? resolved.value : resolved);
        // For handle results, the resolved object is stored in the handle store
        const storeScript = `
(function() {
  var __entry = window.__pwHandles.get(${JSON.stringify(result.id)});
  if (!__entry || !__entry.__pwDone) return null;
  var __val = __entry.value;
  var __id = '__pw_' + window.__pwNextId++;
  window.__pwHandles.set(__id, __val);
  var __serVal;
  try { __serVal = JSON.parse(JSON.stringify(__val)); } catch(e) {}
  return { __pwHandle: true, id: __id, isNode: __val instanceof Node, type: typeof __val, value: __serVal };
})()
`;
        result = await this._connection.execute(storeScript);
        if (result && result.__pwHandle)
          return this._createHandle(utilityScript._context, result);
        return new js.JSHandle(utilityScript._context, 'undefined', 'undefined', undefined, undefined);
      }

      if (returnByValue)
        return parseEvaluationResultValue(result);

      if (result && result.__pwHandle)
        return this._createHandle(utilityScript._context, result);

      return new js.JSHandle(utilityScript._context, typeof result, String(result), undefined, result);
    } catch (e: any) {
      if (e instanceof js.JavaScriptErrorInEvaluate)
        throw e;
      if (e.message?.includes('server error'))
        throw new js.JavaScriptErrorInEvaluate(e.message);
      throw e;
    }
  }

  async getProperties(object: js.JSHandle): Promise<Map<string, js.JSHandle>> {
    if (!object._objectId)
      return new Map();

    await this._ensureHandleStore();
    const script = `
(function() {
  var __obj = window.__pwHandles.get(${JSON.stringify(object._objectId)});
  if (!__obj || typeof __obj !== 'object') return [];
  var __result = [];
  var __keys = Object.getOwnPropertyNames(__obj);
  for (var __i = 0; __i < __keys.length; __i++) {
    var __key = __keys[__i];
    var __desc = Object.getOwnPropertyDescriptor(__obj, __key);
    if (!__desc || !__desc.enumerable) continue;
    var __val = __obj[__key];
    var __id = '__pw_' + window.__pwNextId++;
    window.__pwHandles.set(__id, __val);
    __result.push({ name: __key, id: __id, isNode: __val instanceof Node, type: typeof __val });
  }
  return __result;
})()
`;
    const entries = await this._connection.execute(script);
    const result = new Map<string, js.JSHandle>();
    if (!Array.isArray(entries))
      return result;
    for (const entry of entries)
      result.set(entry.name, this._createHandle(object._context, entry));
    return result;
  }

  async releaseHandle(handle: js.JSHandle): Promise<void> {
    if (!handle._objectId)
      return;
    try {
      await this._connection.execute(`window.__pwHandles && window.__pwHandles.delete(${JSON.stringify(handle._objectId)})`);
    } catch {
      // Ignore errors during cleanup.
    }
  }

  private _createHandle(context: js.ExecutionContext, metadata: { id: string; isNode: boolean; type: string; value?: any }): js.JSHandle {
    if (metadata.isNode)
      return new dom.ElementHandle(context as dom.FrameExecutionContext, metadata.id);
    return new js.JSHandle(context, metadata.type || 'object', undefined, metadata.id, metadata.value);
  }
}
