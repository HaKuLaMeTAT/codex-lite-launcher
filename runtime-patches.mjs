import { createRequire } from 'node:module';
// 参考 Codex++ 13d0c242 的对应变换；MCP 仅合并短时事件，不采用缓存年龄门控。
const acorn = createRequire(import.meta.url)('./vendor/acorn.cjs');
export const RUNTIME_MARKER = '/*codex-lite-runtime:v1*/';

// 空闲后的首块立即送达；高频输出按 8ms 合并，退出前必须交付尾部。
function batchPty(callbacks) {
  let pending = '', timer = null;
  const flush = () => { if (pending.length) { const chunk = pending; pending = ''; callbacks.onData(chunk); } };
  const tick = () => { timer = null; if (pending.length) { timer = setTimeout(tick, 8); flush(); } };
  return {
    onData(chunk) {
      if (typeof chunk !== 'string') { flush(); callbacks.onData(chunk); return; }
      if (timer === null) { timer = setTimeout(tick, 8); callbacks.onData(chunk); return; }
      pending += chunk;
      if (pending.length >= 65536) flush();
    },
    onExit(result) { if (timer !== null) { clearTimeout(timer); timer = null; } flush(); callbacks.onExit(result); },
  };
}

// 仅标注最新、完整回合中已存在的命令内容；其他批次沿用原失效计算。
function outputHints(conversation, deltas) {
  const history = conversation?.turnHistory;
  if (history?.kind !== 'canonical' || !Array.isArray(deltas) ||
      conversation.unconfirmedTurnSubmissions?.some(item => item.terminal === true)) return {};
  const island = history.history?.islands?.at(-1);
  if (island?.newerBoundary?.status !== 'exhausted') return {};
  const key = island.entries?.at(-1)?.value, turn = key == null ? null : history.history.entitiesByKey?.[key];
  if (!turn || !Array.isArray(turn.items)) return {};
  const ids = new Set();
  for (const delta of deltas) {
    if (delta.turnId != null && delta.turnId !== turn.turnId) return {};
    if (!turn.items.some(item => item.id === delta.itemId && item.type === 'commandExecution')) return {};
    ids.add(delta.itemId);
  }
  return ids.size ? { knownHistoryInvalidation: { type: 'entityKeys', entityKeys: [key] },
    knownChangedItems: [...ids].map(itemId => ({ entityKey: key, itemId })) } : {};
}

// 已完成淡入且没有额外装饰的普通文本合并；其余片段仍调用原渲染函数。
function settledWords(segments, keys, timeline, render) {
  const result = [];
  let text = null;
  const flush = () => { if (text !== null) { result.push(text); text = null; } };
  segments.forEach((segment, index) => {
    if (typeof segment === 'string' && keys?.[index] != null && timeline?.settledKeys.has(keys[index])) {
      text = (text ?? '') + segment;
    } else { flush(); result.push(render(segment, index)); }
  });
  flush();
  return result;
}

// 每个代码块只记住一次识别结果；文本翻倍/被替换时重识别，停流后校正最终高亮。
function cachedHighlight(state, module, code, language, set) {
  clearTimeout(state.__clAutoTimer);
  state.__clAutoTimer = null;
  if (language?.trim() || typeof code !== 'string') { state.__clAuto = null; return set(module.highlightCode(code, language)); }
  const detect = () => {
    const result = module.highlightCode(code, language);
    state.__clAuto = { code, language: result.language };
    return set(result);
  };
  const previous = state.__clAuto;
  if (!previous || !code.startsWith(previous.code) || code.length >= 2 * previous.code.length) return detect();
  const result = module.highlightCode(code, previous.language ?? 'plaintext');
  if (code !== previous.code) state.__clAutoTimer = setTimeout(() => {
    state.__clAutoTimer = null;
    if (!state.disposed && state.latestContent === code && !state.latestLanguage?.trim()) detect();
  }, 1000);
  return set({ ...result, language: previous.language });
}

// 不按缓存年龄跳过通知：首个立即执行，重复 ready 在固定窗口末尾补一次。
// 按 QueryClient 与查询键隔离合并窗口；固定为 200ms，连续事件不会无限推迟刷新。
function makeInventoryCoalescer() {
  const clients = new WeakMap();
  return (client, key, run) => {
    let pending = clients.get(client);
    if (!pending) { pending = new Map(); clients.set(client, pending); }
    const id = JSON.stringify(key), existing = pending.get(id);
    if (existing) { existing.run = run; return; }
    const entry = { run: null };
    pending.set(id, entry);
    setTimeout(() => { pending.delete(id); if (entry.run) entry.run(); }, 200);
    return run();
  };
}

function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node, ancestors);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(item => walk(item, visit, [...ancestors, node]));
    else if (value && typeof value === 'object') walk(value, visit, [...ancestors, node]);
  }
}
const member = (node, name) => node?.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.name === name;
const label = node => node?.type === 'Literal' ? node.value : node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : null;

export function transformRuntime(source, kind) {
  if (source.includes(RUNTIME_MARKER)) throw new Error('已包含运行时优化补丁。');
  const type = kind === 'main' ? 'script' : 'module';
  const tree = acorn.parse(source, { ecmaVersion: 'latest', sourceType: type }), matches = new Map();
  const text = node => source.slice(node.start, node.end);
  const add = (name, edit) => { if (!matches.has(name)) matches.set(name, []); matches.get(name).push({ name, ...edit }); };
  walk(tree, (node, ancestors) => {
    if (kind === 'main' && node.type === 'ObjectExpression' && node.properties.length === 2) {
      const data = node.properties.find(p => p.key?.name === 'onData')?.value, exit = node.properties.find(p => p.key?.name === 'onExit')?.value;
      if (data?.type === 'ArrowFunctionExpression' && exit?.type === 'ArrowFunctionExpression' &&
          text(data).includes('this.appendOutput(') && text(data).includes('.slice(-16e3)') && text(exit).includes('this.destroySession(')) {
        add('batched-pty-output', { start: node.start, end: node.end, text: `${RUNTIME_MARKER}(${batchPty})(${text(node)})` });
      }
    }
    if (kind === 'initial' && node.type === 'FunctionDeclaration' && node.params[0]?.type === 'ObjectPattern') {
      const fields = Object.fromEntries(node.params[0].properties.filter(p => p.key?.type === 'Identifier' && p.value?.type === 'Identifier').map(p => [p.key.name, p.value.name]));
      const expression = node.body.body.length === 1 && node.body.body[0].type === 'ReturnStatement' ? node.body.body[0].argument : null;
      if (fields.fadeText && fields.fadeSegmentStartIndex && fields.fadeSegmentTimeline && fields.keys && fields.segments &&
          expression?.type === 'ConditionalExpression' && expression.test.name === fields.fadeText && member(expression.consequent, 'map') &&
          expression.consequent.callee.object.name === fields.segments && expression.consequent.arguments.length === 1) {
        const each = expression.consequent.arguments[0];
        if (each.type === 'ArrowFunctionExpression' && each.params.length === 2 && text(each).includes('`span`'))
          add('settled-stream-text', { start: expression.consequent.start, end: expression.consequent.end,
            text: `${RUNTIME_MARKER}(${settledWords})(${fields.segments},${fields.keys},${fields.fadeSegmentTimeline},${text(each)})` });
      }
    }
    if (kind === 'initial' && member(node, 'subscribe') && node.arguments[0]?.type === 'ObjectExpression') {
      const listener = node.arguments[0].properties.find(p => p.key?.name === 'listener')?.value;
      if (!listener || !text(listener).includes(`${text(node.callee.object)}.getConversationCwd(`)) return;
      walk(listener, branch => {
        if (branch.type !== 'SwitchCase' || label(branch.test) !== 'mcpServer/startupStatus/updated') return;
        walk(branch, call => {
          const options = call.type === 'CallExpression' && call.arguments[1]?.type === 'ObjectExpression' ? call.arguments[1] : null;
          const key = options?.properties.find(p => p.key?.name === 'queryKey')?.value;
          if (key?.type !== 'ArrayExpression' || label(key.elements.at(-1)) !== 'toolsAndAuthOnly' || call.arguments[0]?.property?.name !== 'queryClient') return;
          add('coalesced-mcp-inventory', { start: call.start, end: call.end,
            text: `${RUNTIME_MARKER}(globalThis.__codexLiteInventoryV1??=(${makeInventoryCoalescer})())(${text(call.arguments[0])},${text(key)},()=>${text(call)})` });
        });
      });
    }
    if (kind === 'shared' && member(node, 'updateConversationState') && node.arguments.length === 3) {
      const [id, update, options] = node.arguments;
      const method = [...ancestors].reverse().find(a => a.type === 'MethodDefinition');
      if (method?.key.name !== 'applyOutputDeltas' || update.type !== 'ArrowFunctionExpression' || options.type !== 'ObjectExpression' || options.properties.length !== 2) return;
      const names = options.properties.map(p => p.key?.name);
      if (!names.includes('broadcastPatchesToFollowers') || !names.includes('acceptedTranscriptText') || !text(update).includes('`commandExecution`') || !text(update).includes('aggregatedOutput')) return;
      const loop = [...ancestors].reverse().find(a => a.type === 'ForOfStatement');
      const parts = loop?.left.declarations?.[0]?.id;
      const first = loop?.body.body?.[0]?.declarations?.[0];
      if (parts?.type !== 'ArrayPattern' || parts.elements[0]?.name !== id.name || !parts.elements[1]?.name ||
          first?.id.type !== 'Identifier' || !member(first.init, 'get') || first.init.callee.object.property?.name !== 'conversations') return;
      add('command-output-items', { start: options.end - 1, end: options.end - 1,
        text: `,${RUNTIME_MARKER}...(${outputHints})(${first.id.name},${parts.elements[1].name})` });
    }
    if (kind === 'shared' && node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.arguments.length === 1 && member(node.arguments[0], 'highlightCode')) {
      const call = node.arguments[0];
      if (call.arguments.length !== 2 || !call.arguments.every(a => a.type === 'Identifier') || call.callee.object.type !== 'Identifier') return;
      const [code, language] = call.arguments;
      const owner = [...ancestors].reverse().find(a => a.type === 'ArrowFunctionExpression' && a.body.type === 'BlockStatement' &&
        text(a).includes('.latestContent') && text(a).includes('.latestLanguage'));
      if (!owner) return;
      let state;
      walk(owner, variable => {
        if (variable.type === 'VariableDeclarator' && variable.id.name === code.name && variable.init?.type === 'MemberExpression' && variable.init.property.name === 'latestContent') state = variable.init.object.name;
      });
      if (!state) return;
      add('cached-highlight-language', { start: node.start, end: node.end,
        text: `${RUNTIME_MARKER}(${cachedHighlight})(${state},${text(call.callee.object)},${code.name},${language.name},${node.callee.name})` });
    }
    if (kind === 'shared' && node.type === 'ArrowFunctionExpression' && node.body.type === 'BlockStatement') {
      // 与原高亮任务一同清理，防止卸载后仍保留一秒定时器和文本引用。
      const body = text(node.body);
      const found = /^\{([\w$]+)\.disposed=!0,\1\.timeoutHandle!=null&&/.exec(body);
      if (found && body.includes('.timeoutHandle=null)')) add('highlight-timer-cleanup', {
        start: node.body.start + 1, end: node.body.start + 1,
        text: `${RUNTIME_MARKER}clearTimeout(${found[1]}.__clAutoTimer);${found[1]}.__clAuto=null;`,
      });
    }
  });
  const required = { main: ['batched-pty-output'], initial: ['settled-stream-text', 'coalesced-mcp-inventory'],
    shared: ['command-output-items', 'cached-highlight-language', 'highlight-timer-cleanup'] }[kind];
  if (!required) throw new Error(`未知模块类型：${kind}`);
  const edits = required.map(name => {
    const found = matches.get(name) ?? [];
    if (found.length !== 1) throw new Error(`${name}：应唯一匹配，实际匹配 ${found.length} 处。此包暂不支持。`);
    return found[0];
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < edits.length; i++) if (edits[i].start < edits[i - 1].end) throw new Error('运行时优化修改范围重叠。');
  let result = source;
  for (const edit of [...edits].reverse()) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  acorn.parse(result, { ecmaVersion: 'latest', sourceType: type });
  return { bytes: Buffer.from(result), edits };
}
