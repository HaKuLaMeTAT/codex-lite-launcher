import { createRequire } from 'node:module';
const acorn = createRequire(import.meta.url)('./vendor/acorn.cjs');

// 同仓库的临时索引快照串行执行；同一代的并发请求共享在途结果，不缓存完成结果。
export function createSnapshotScheduler() {
  const repositories = new WeakMap();
  return (repository, snapshot, run) => {
    let state = repositories.get(repository);
    if (!state) { state = { tail: null, pending: new Map() }; repositories.set(repository, state); }
    if (state.pending.has(snapshot)) return state.pending.get(snapshot);
    const start = () => { snapshot.assertCurrent(); return run(); };
    // 前一代失败不阻塞新一代；原请求仍收到自己的错误，过期任务在启动 Git 前退出。
    const result = (state.tail ? state.tail.catch(() => {}) : Promise.resolve()).then(start);
    state.tail = result; state.pending.set(snapshot, result);
    const finish = () => {
      state.pending.delete(snapshot);
      if (state.tail === result) state.tail = null;
      if (state.pending.size === 0) repositories.delete(repository);
    };
    result.then(finish, finish);
    return result;
  };
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(item => walk(item, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}
const literal = node => node?.type === 'Literal' ? node.value : node?.type === 'TemplateLiteral' && !node.expressions.length ? node.quasis[0].value.cooked : null;
function prepend(source, tree, code) {
  let position = 0;
  for (const statement of tree.body) {
    if (!statement.directive) break;
    position = statement.end;
  }
  // 保留模块的 use strict 指令，并在其他模块初始化之前设置开关或调度器。
  return source.slice(0, position) + '\n' + code + '\n' + source.slice(position);
}

export function transformGitSnapshotScheduling(source) {
  const marker = '/*codex-lite-git-snapshot:v1*/';
  if (source.includes(marker) || source.includes('__clScheduleGitSnapshot')) throw new Error('已包含 Git 快照调度补丁或调度器名称冲突。');
  const tree = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' }), matches = [];
  walk(tree, fn => {
    if (fn.type !== 'FunctionDeclaration' || fn.params.length !== 1 || fn.params[0].type !== 'Identifier' || fn.body.body.length !== 2) return;
    const [binding, statement] = fn.body.body;
    const snapshot = binding.type === 'VariableDeclaration' && binding.declarations.length === 1 ? binding.declarations[0] : null;
    if (snapshot?.id.type !== 'Identifier' || snapshot.init?.type !== 'MemberExpression' || snapshot.init.object.name !== fn.params[0].name || snapshot.init.property.name !== 'reviewSnapshot') return;
    const call = statement.type === 'ReturnStatement' ? statement.argument : null;
    if (call?.type !== 'CallExpression' || call.callee.property?.name !== 'fetchQuery' || call.callee.object?.property?.name !== 'queryClient' ||
        call.callee.object?.object?.name !== fn.params[0].name || call.arguments.length !== 1 || call.arguments[0].type !== 'ObjectExpression') return;
    const fields = call.arguments[0].properties, gc = fields.find(p => p.key?.name === 'gcTime'), stale = fields.find(p => p.key?.name === 'staleTime');
    const key = fields.find(p => p.key?.name === 'queryKey')?.value, query = fields.find(p => p.key?.name === 'queryFn')?.value;
    if (literal(gc?.value) !== 250 || literal(stale?.value) !== 0 || !key?.arguments?.some(n => literal(n) === 'turn-diff-snapshot-tree') ||
        query?.type !== 'ArrowFunctionExpression' || query.body?.callee?.object?.name !== snapshot.id.name || query.body?.callee?.property?.name !== 'read') return;
    matches.push({ call, repository: fn.params[0].name, snapshot: snapshot.id.name });
  });
  if (matches.length !== 1) throw new Error(`Git 回合快照入口应唯一匹配，实际 ${matches.length} 处。`);
  const { call, repository, snapshot } = matches[0];
  const code = createSnapshotScheduler.toString().replace(/\r\n?/g, '\n');
  const wrapped = source.slice(0, call.start) + `__clScheduleGitSnapshot(${repository},${snapshot},()=>${source.slice(call.start, call.end)})` + source.slice(call.end);
  const result = prepend(wrapped, tree, `${marker}\nvar __clScheduleGitSnapshot=(${code})();`);
  acorn.parse(result, { ecmaVersion: 'latest', sourceType: 'script' });
  return { bytes: Buffer.from(result), edits: [{ name: 'serialized-git-snapshots' }] };
}

export function transformReducedMotion(source) {
  const marker = '/*codex-lite-reduced-motion:v1*/';
  if (source.includes(marker) || source.includes('force-prefers-reduced-motion')) throw new Error('已包含减少动画设置。');
  const tree = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' }), electron = [];
  walk(tree, node => {
    if (node.type === 'CallExpression' && node.callee.name === 'require' && node.arguments.length === 1 && literal(node.arguments[0]) === 'electron') electron.push(node);
  });
  if (electron.length !== 1) throw new Error(`减少动画：Electron 主模块应唯一匹配，实际 ${electron.length} 处。`);
  // 在主模块加载其他应用模块前启用 Chromium 已有的媒体偏好，不覆盖用户内容或 CSS。
  const result = prepend(source, tree, `${marker}\nrequire("electron").app.commandLine.appendSwitch("force-prefers-reduced-motion");`);
  acorn.parse(result, { ecmaVersion: 'latest', sourceType: 'script' });
  return { bytes: Buffer.from(result), edits: [{ name: 'reduced-motion' }] };
}
