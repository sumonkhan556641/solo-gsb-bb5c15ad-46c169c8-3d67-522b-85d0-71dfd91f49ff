'use strict';

/**
 * analyzer.js 焦点裁剪审计（auditClip）纯函数单元测试（Node 环境，无 DOM）。
 * 重点：iframe 视口与组合祖先 client 盒的逐次求交、按轴裁剪、
 * 完整 / 部分裁剪 / 完全裁剪分类与剩余面积比例、实际缩小区域的来源记录，
 * 以及零面积 / absolute·fixed 定位 / transform / clip-path 四类「无法判定」。
 * 运行：npm test
 */

const assert = require('assert');
const { auditClip } = require('../public/analyzer.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error('  ✗ ' + name);
    console.error(err);
    process.exitCode = 1;
  }
}

const VP = { width: 800, height: 600 };

/** 构造节点（step 为 1 基 Tab 序号；self / ancestors 可覆盖） */
function node(step, rect, opts) {
  opts = opts || {};
  return {
    step,
    selector: '#n' + step,
    label: 'node' + step,
    rect,
    self: opts.self || { position: 'static', transform: 'none', clipPath: 'none' },
    ancestors: opts.ancestors || []
  };
}
function rect(left, top, width, height) {
  return { left, top, width, height };
}
/** 构造组合祖先（默认不裁剪：overflow 全 visible、无 clientBox） */
function ancestor(over) {
  return Object.assign({
    selector: 'L:html > body > div',
    label: 'div.box',
    position: 'static',
    transform: 'none',
    clipPath: 'none',
    overflowX: 'visible',
    overflowY: 'visible',
    clientBox: null
  }, over || {});
}

console.log('auditClip · 完整 / 部分裁剪 / 完全裁剪');
test('节点完整位于视口内、无裁剪祖先 → full，比例 1，无裁剪来源', () => {
  const r = auditClip([node(1, rect(10, 10, 100, 40))], { viewport: VP });
  assert.strictEqual(r.items.length, 1);
  const it = r.items[0];
  assert.strictEqual(it.status, 'full');
  assert.strictEqual(it.ratio, 1);
  assert.deepStrictEqual(it.clippers, []);
  assert.deepStrictEqual(it.visible, { left: 10, top: 10, width: 100, height: 40 });
  assert.deepStrictEqual(r.undetermined, []);
  assert.strictEqual(r.stats.full, 1);
});

test('节点部分越出视口 → partial，来源为 iframe 视口且轴向正确', () => {
  const r = auditClip([node(1, rect(700, 10, 200, 40))], { viewport: VP });
  const it = r.items[0];
  assert.strictEqual(it.status, 'partial');
  assert.strictEqual(it.ratio, 0.5); // 右侧 100px 被裁
  assert.strictEqual(it.clippers.length, 1);
  assert.strictEqual(it.clippers[0].kind, 'viewport');
  assert.strictEqual(it.clippers[0].label, 'iframe 视口');
  assert.deepStrictEqual(it.clippers[0].axes, ['x']);
  assert.deepStrictEqual(it.visible, { left: 700, top: 10, width: 100, height: 40 });
});

test('节点完全位于视口外 → clipped，比例 0', () => {
  const r = auditClip([node(1, rect(10, 700, 100, 40))], { viewport: VP });
  const it = r.items[0];
  assert.strictEqual(it.status, 'clipped');
  assert.strictEqual(it.ratio, 0);
  assert.strictEqual(it.clippers.length, 1);
  assert.deepStrictEqual(it.clippers[0].axes, ['y']);
  assert.strictEqual(it.visible.height, 0);
});

console.log('auditClip · 祖先 client 盒裁剪');
test('祖先 overflow-x:hidden 仅裁 x 轴（y 方向溢出不裁）', () => {
  const anc = ancestor({
    overflowX: 'hidden',
    clientBox: rect(0, 0, 150, 50)
  });
  // 节点 x 方向超出盒（150→200 被裁），y 方向也超出盒但 overflow-y:visible 不裁
  const r = auditClip([node(1, rect(100, 0, 100, 80), { ancestors: [anc] })], { viewport: VP });
  const it = r.items[0];
  assert.strictEqual(it.status, 'partial');
  assert.strictEqual(it.clippers.length, 1);
  assert.strictEqual(it.clippers[0].kind, 'ancestor');
  assert.strictEqual(it.clippers[0].label, 'div.box');
  assert.deepStrictEqual(it.clippers[0].axes, ['x']);
  assert.deepStrictEqual(it.visible, { left: 100, top: 0, width: 50, height: 80 });
});

test('祖先 overflow-y:auto 裁剪，节点完全在盒下方 → clipped（来源为祖先）', () => {
  const anc = ancestor({
    overflowY: 'auto',
    clientBox: rect(0, 0, 200, 50)
  });
  const r = auditClip([node(1, rect(10, 80, 100, 30), { ancestors: [anc] })], { viewport: VP });
  const it = r.items[0];
  assert.strictEqual(it.status, 'clipped');
  assert.strictEqual(it.ratio, 0);
  assert.strictEqual(it.clippers.length, 1);
  assert.strictEqual(it.clippers[0].kind, 'ancestor');
  assert.deepStrictEqual(it.clippers[0].axes, ['y']);
});

test('overflow:clip / scroll 同样触发对应轴裁剪', () => {
  const anc = ancestor({
    overflowX: 'clip',
    overflowY: 'scroll',
    clientBox: rect(0, 0, 100, 100)
  });
  const r = auditClip([node(1, rect(50, 50, 100, 100), { ancestors: [anc] })], { viewport: VP });
  const it = r.items[0];
  assert.strictEqual(it.status, 'partial');
  assert.strictEqual(it.ratio, 0.25); // 50×50 / 100×100
  assert.deepStrictEqual(it.clippers[0].axes, ['x', 'y']);
});

test('overflow 全 visible（无 clientBox）的祖先不裁剪', () => {
  const r = auditClip([node(1, rect(10, 10, 100, 40), { ancestors: [ancestor()] })], { viewport: VP });
  assert.strictEqual(r.items[0].status, 'full');
  assert.deepStrictEqual(r.items[0].clippers, []);
});

test('client 盒已包含节点的祖先不记入裁剪来源（仅记录实际缩小区域者）', () => {
  const anc = ancestor({
    overflowX: 'hidden',
    overflowY: 'hidden',
    clientBox: rect(0, 0, 500, 500)
  });
  const r = auditClip([node(1, rect(10, 10, 100, 40), { ancestors: [anc] })], { viewport: VP });
  assert.strictEqual(r.items[0].status, 'full');
  assert.deepStrictEqual(r.items[0].clippers, []);
});

test('视口与多个祖先依次缩小区域 → 全部按序记录', () => {
  const outer = ancestor({
    label: 'div.outer',
    selector: 'L:html > body > div.outer',
    overflowX: 'hidden',
    overflowY: 'hidden',
    clientBox: rect(0, 0, 700, 500)
  });
  const inner = ancestor({
    label: 'div.inner',
    selector: 'L:html > body > div.outer > div.inner',
    overflowX: 'auto',
    overflowY: 'visible',
    clientBox: rect(0, 0, 650, 400)
  });
  // 节点 100×40 @ (600,480)：视口(800×600) 不裁；inner 裁 x（600+100>650）；
  // outer 裁 y（480+40>500）
  const r = auditClip([node(1, rect(600, 480, 100, 40), { ancestors: [inner, outer] })], { viewport: VP });
  const it = r.items[0];
  assert.strictEqual(it.status, 'partial');
  assert.strictEqual(it.clippers.length, 2);
  assert.strictEqual(it.clippers[0].label, 'div.inner'); // 就近祖先先求交
  assert.deepStrictEqual(it.clippers[0].axes, ['x']);
  assert.strictEqual(it.clippers[1].label, 'div.outer');
  assert.deepStrictEqual(it.clippers[1].axes, ['y']);
  assert.deepStrictEqual(it.visible, { left: 600, top: 480, width: 50, height: 20 });
});

console.log('auditClip · 无法判定');
test('零面积节点 → zero-size', () => {
  const r = auditClip([node(1, rect(10, 10, 0, 40)), node(2, rect(10, 10, 50, 0))], { viewport: VP });
  assert.strictEqual(r.items.length, 0);
  assert.strictEqual(r.undetermined.length, 2);
  assert.ok(r.undetermined.every(x => x.reason === 'zero-size'));
  assert.ok(r.undetermined.every(x => x.source === null));
  assert.strictEqual(r.stats.undetermined, 2);
});

test('节点自身 absolute / fixed → positioned', () => {
  const abs = auditClip([
    node(1, rect(10, 10, 100, 40), { self: { position: 'absolute', transform: 'none', clipPath: 'none' } })
  ], { viewport: VP });
  assert.strictEqual(abs.undetermined.length, 1);
  assert.strictEqual(abs.undetermined[0].reason, 'positioned');
  assert.strictEqual(abs.undetermined[0].source, null);
  assert.ok(abs.undetermined[0].message.indexOf('absolute') >= 0);

  const fix = auditClip([
    node(1, rect(10, 10, 100, 40), { self: { position: 'fixed', transform: 'none', clipPath: 'none' } })
  ], { viewport: VP });
  assert.strictEqual(fix.undetermined[0].reason, 'positioned');
});

test('祖先 fixed → positioned，source 记录该祖先', () => {
  const anc = ancestor({ position: 'fixed' });
  const r = auditClip([node(1, rect(10, 10, 100, 40), { ancestors: [anc] })], { viewport: VP });
  const u = r.undetermined[0];
  assert.strictEqual(u.reason, 'positioned');
  assert.deepStrictEqual(u.source, { label: 'div.box', selector: 'L:html > body > div' });
  assert.ok(u.message.indexOf('祖先') >= 0);
});

test('自身或祖先 transform 非 none → transformed', () => {
  const selfTf = auditClip([
    node(1, rect(10, 10, 100, 40), { self: { position: 'static', transform: 'translateX(5px)', clipPath: 'none' } })
  ], { viewport: VP });
  assert.strictEqual(selfTf.undetermined[0].reason, 'transformed');

  const ancTf = auditClip([
    node(1, rect(10, 10, 100, 40), { ancestors: [ancestor({ transform: 'matrix(1,0,0,1,10,0)' })] })
  ], { viewport: VP });
  assert.strictEqual(ancTf.undetermined[0].reason, 'transformed');
  assert.strictEqual(ancTf.items.length, 0);
});

test('自身或祖先 clip-path 非 none → clip-path', () => {
  const selfCp = auditClip([
    node(1, rect(10, 10, 100, 40), { self: { position: 'static', transform: 'none', clipPath: 'inset(0)' } })
  ], { viewport: VP });
  assert.strictEqual(selfCp.undetermined[0].reason, 'clip-path');

  const ancCp = auditClip([
    node(1, rect(10, 10, 100, 40), { ancestors: [ancestor({ clipPath: 'circle(50%)' })] })
  ], { viewport: VP });
  assert.strictEqual(ancCp.undetermined[0].reason, 'clip-path');
});

test('无法判定优先级：零面积优先；自身优先于祖先；就近祖先优先', () => {
  // 零面积 + transform 同时存在 → zero-size
  const zero = auditClip([
    node(1, rect(0, 0, 0, 0), { self: { position: 'static', transform: 'scale(2)', clipPath: 'none' } })
  ], { viewport: VP });
  assert.strictEqual(zero.undetermined[0].reason, 'zero-size');

  // 近祖先 transform、远祖先 fixed → 就近命中 transformed
  const near = ancestor({ label: 'div.near', transform: 'scale(1.2)' });
  const far = ancestor({ label: 'div.far', position: 'fixed' });
  const r = auditClip([node(1, rect(10, 10, 100, 40), { ancestors: [near, far] })], { viewport: VP });
  assert.strictEqual(r.undetermined[0].reason, 'transformed');
  assert.strictEqual(r.undetermined[0].source.label, 'div.near');
});

console.log('auditClip · 统计与输出形状');
test('stats 汇总正确，无法判定不计入裁剪统计', () => {
  const r = auditClip([
    node(1, rect(10, 10, 100, 40)),                                        // full
    node(2, rect(700, 10, 200, 40)),                                       // partial（视口）
    node(3, rect(10, 700, 100, 40)),                                       // clipped（视口）
    node(4, rect(10, 10, 100, 40), { self: { position: 'absolute', transform: 'none', clipPath: 'none' } }), // positioned
    node(5, rect(0, 0, 0, 0))                                              // zero-size
  ], { viewport: VP });
  assert.strictEqual(r.stats.nodes, 5);
  assert.strictEqual(r.stats.judged, 3);
  assert.strictEqual(r.stats.full, 1);
  assert.strictEqual(r.stats.partial, 1);
  assert.strictEqual(r.stats.clipped, 1);
  assert.strictEqual(r.stats.undetermined, 2);
  assert.strictEqual(r.items.length + r.undetermined.length, 5);
});

test('判定与无法判定条目包含联动高亮与导出所需字段', () => {
  const r = auditClip([
    node(1, rect(700, 10, 200, 40)),
    node(2, rect(0, 0, 0, 0))
  ], { viewport: VP });
  const it = r.items[0];
  assert.ok(it.selector && it.label && typeof it.status === 'string');
  assert.ok(typeof it.ratio === 'number');
  assert.ok(it.rect && it.visible);
  assert.ok(Array.isArray(it.clippers));
  const u = r.undetermined[0];
  assert.ok(u.selector && u.label && u.reason && typeof u.message === 'string');
  assert.strictEqual(r.viewport, VP);
});

test('空输入 / null / 无视口安全', () => {
  const empty = auditClip([], { viewport: VP });
  assert.strictEqual(empty.stats.nodes, 0);
  assert.deepStrictEqual(empty.items, []);
  assert.deepStrictEqual(empty.undetermined, []);

  assert.strictEqual(auditClip(null).stats.nodes, 0);
  assert.strictEqual(auditClip(undefined, null).stats.nodes, 0);

  // 无视口：仅按祖先裁剪
  const noVp = auditClip([node(1, rect(-50, 10, 100, 40))], {});
  assert.strictEqual(noVp.items[0].status, 'full');
});

console.log('\n' + passed + ' 个断言组通过' + (process.exitCode ? '（存在失败）' : ''));
