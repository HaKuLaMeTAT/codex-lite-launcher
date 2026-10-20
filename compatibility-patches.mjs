import acorn from './vendor/acorn.cjs';

function visit(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (node.type) fn(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(n => visit(n, fn));
    else if (value && typeof value === 'object') visit(value, fn);
  }
}
const parse = source => acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
function unique(found, description) {
  if (found.length !== 1) throw Error(`${description}：应唯一匹配，实际 ${found.length} 处。`);
  return found[0];
}

export function transformImageInput(source, kind) {
  const found = [];
  visit(parse(source), node => {
    if (node.type !== 'FunctionDeclaration') return;
    const properties = node.params[1]?.left?.properties;
    if (!properties?.some(p => p.key?.name === 'localPath') || !properties.some(p => p.key?.name === 'isRemoteHost')) return;
    const body = node.body.body;
    if (body[0]?.type !== 'VariableDeclaration' || body[1]?.type !== 'IfStatement' || body[2]?.type !== 'IfStatement') return;
    const text = source.slice(node.start, node.end);
    if (!text.includes('data:image') || !text.includes('type:`localImage`') || !text.includes('type:`image`')) return;
    found.push([body[1], body[2]]);
  });
  const [first, second] = unique(found, '图片输入优先级');
  const a = source.slice(first.start, first.end), b = source.slice(second.start, second.end);
  const already = a.includes('type:`image`') && b.includes('type:`localImage`');
  if (!already && !(a.includes('type:`localImage`') && b.includes('type:`image`'))) throw Error('图片输入分支结构不支持。');
  // 只交换路径与内存分支；保留远程主机判断及原文件 URL 解码行为。
  const result = already ? source : source.slice(0, first.start) + b + source.slice(first.end, second.start) + a + source.slice(second.end);
  parse(result);
  return { bytes: Buffer.from(result), edits: [{ name: 'image-data-url-first-' + kind }] };
}

export function transformScrollCleanup(source) {
  const found = [];
  visit(parse(source), node => {
    if (node.type !== 'VariableDeclarator' || !node.init) return;
    const before = source.slice(Math.max(0, node.start - 400), node.start);
    const after = source.slice(node.end, node.end + 500);
    if (!before.includes('setFooterResizeViewportPreserveDisabled(!1)') || !after.includes('scrollState:')) return;
    const value = node.init.type === 'ConditionalExpression' ? node.init.consequent : node.init;
    if (value?.type !== 'CallExpression' || value.arguments.length || value.callee.property?.name !== 'getLastScrollDistanceFromBottomPx') return;
    if (node.init.type === 'ConditionalExpression' && (node.init.test.type !== 'BinaryExpression' || node.init.test.operator !== '==' || node.init.test.right.value !== null || node.init.alternate.type !== 'CallExpression' || node.init.alternate.arguments[0]?.name !== node.init.test.left.name)) return;
    found.push({ node, value });
  });
  const { node, value } = unique(found, '会话清理滚动距离');
  // 页面清理时使用控制器缓存；其他滚动与布局计算保持原路径。
  const result = source.slice(0, node.init.start) + source.slice(value.start, value.end) + source.slice(node.init.end);
  parse(result);
  return { bytes: Buffer.from(result), edits: [{ name: 'cached-scroll-cleanup' }] };
}
