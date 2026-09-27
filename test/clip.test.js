'use strict';

/**
 * analyzer.js 焦点裁剪审计（auditFocusClip）纯函数单元测试（Node 环境，无 DOM）。
 * 重点：矩形依次与 iframe 视口及组合祖先裁剪区域求交（仅裁对应轴）、
 * 完整 / 部分裁剪 / 完全裁剪分类与剩余面积比例、实际缩小区域的裁剪来源记录、
 * 零面积 / 定位 / transform / clip-path 四类「无法判定」。
 * 运行：npm test
 */

const assert = require('assert');
const { auditFocusClip } = require('../public/analyzer.js');

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

const VP = { left: 0, top: 0, width: 800, height: 600 };

/** 构造节点（step 为 1 基 Tab 序号；extra 覆盖 blockReason / clippers） */
function node(step, rect, extra) {
  return Object.assign({
    step,
    selector: '#n' + step,
    label: 'node' + step,
    rect,
    blockReason: null,
    clippers: []
  }, extra || {});
}
function rect(left, top, width, height) {
  return { left, top, width, height };
}
/** 构造祖先裁剪区域（axes 子集 ['x','y']，区域为 client 盒） */
function ancestor(axes, r, label) {
  return { kind: 'ancestor', axes, label: label || 'div.box', selector: 'L:html > body > div', rect: r };
}
function block(reason, message) {
  return { at: 'ancestor', reason, label: 'div.b', selector: 'L:html > body > div', message };
}

console.log('auditFocusClip · 完整（full）');
test('节点在视口内且无祖先裁剪 → 完整，比例 100%', () => {
  const r = auditFocusClip([node(1, rect(100, 100, 200, 50))], { viewport: VP });
  const it = r.items[0];
  assert.strictEqual(it.status, 'full');
  assert.deepStrictEqual(it.clippers, []);
  assert.strictEqual(it.visibleRatio, 1);
  assert.strictEqual(it.visiblePercent, 100);
  assert.deepStrictEqual(it.visibleRect, rect(100, 100, 200, 50));
  assert.strictEqual(r.stats.full, 1);
});

test('完全包含节点的祖先裁剪区域不被记录（未实际缩小区域）', () => {
  const r = auditFocusClip([
    node(1, rect(50, 50, 100, 100), { clippers: [ancestor(['x', 'y'], rect(0, 0, 800, 600))] })
  ], { viewport: VP });
  assert.strictEqual(r.items[0].status, 'full');
  assert.deepStrictEqual(r.items[0].clippers, []);
});

console.log('auditFocusClip · 部分裁剪（partial）');
test('节点被视口右缘裁掉一半 → 部分裁剪 50%，来源为 iframe 视口', () => {
  const r = auditFocusClip([node(1, rect(700, 100, 200, 100))], { viewport: VP });
  const it = r.items[0];
  assert.strictEqual(it.status, 'partial');
  assert.strictEqual(it.visiblePercent, 50);
  assert.strictEqual(it.visibleRatio, 0.5);
  assert.deepStrictEqual(it.visibleRect, rect(700, 100, 100, 100));
  assert.strictEqual(it.clippers.length, 1);
  assert.strictEqual(it.clippers[0].kind, 'viewport');
  assert.deepStrictEqual(it.clippers[0].axes, ['x', 'y']);
});

test('祖先仅裁对应轴：overflow-y 裁剪不影响 x 方向', () => {
  const r = auditFocusClip([
    node(1, rect(50, 50, 100, 100), { clippers: [ancestor(['y'], rect(0, 0, 40, 60))] })
  ], { viewport: VP });
  const it = r.items[0];
  assert.strictEqual(it.status, 'partial');
  // x 方向保持原宽度 100（尽管祖先 client 盒宽仅 40），y 方向裁到 [50,60]
  assert.deepStrictEqual(it.visibleRect, rect(50, 50, 100, 10));
  assert.strictEqual(it.visiblePercent, 10);
  assert.strictEqual(it.clippers.length, 1);
  assert.strictEqual(it.clippers[0].kind, 'ancestor');
  assert.deepStrictEqual(it.clippers[0].axes, ['y']);
});

test('依次求交：视口先裁、祖先再裁，两个来源按序记录', () => {
  const r = auditFocusClip([
    node(1, rect(700, 550, 200, 100), { clippers: [ancestor(['x', 'y'], rect(0, 0, 750, 575))] })
  ], { viewport: VP });
  const it = r.items[0];
  assert.strictEqual(it.status, 'partial');
  // 视口裁到 (700,550,100,50)，祖先再裁到 (700,550,50,25)
  assert.deepStrictEqual(it.visibleRect, rect(700, 550, 50, 25));
  assert.strictEqual(it.visibleRatio, 0.0625);
  assert.strictEqual(it.visiblePercent, 6.3);
  assert.strictEqual(it.clippers.length, 2);
  assert.strictEqual(it.clippers[0].kind, 'viewport');
  assert.strictEqual(it.clippers[1].kind, 'ancestor');
  assert.strictEqual(it.clippers[1].label, 'div.box');
});

console.log('auditFocusClip · 完全裁剪（clipped）');
test('节点完全在视口外 → 完全裁剪，剩余面积 0', () => {
  const r = auditFocusClip([node(1, rect(900, 100, 100, 100))], { viewport: VP });
  const it = r.items[0];
  assert.strictEqual(it.status, 'clipped');
  assert.strictEqual(it.visiblePercent, 0);
  assert.strictEqual(it.clippers.length, 1);
  assert.strictEqual(it.clippers[0].kind, 'viewport');
});

test('节点在视口内但被祖先单轴完全裁掉 → 完全裁剪，来源为该祖先', () => {
  const r = auditFocusClip([
    node(1, rect(100, 100, 100, 100), { clippers: [ancestor(['x'], rect(300, 0, 100, 600))] })
  ], { viewport: VP });
  const it = r.items[0];
  assert.strictEqual(it.status, 'clipped');
  assert.strictEqual(it.clippers.length, 1);
  assert.strictEqual(it.clippers[0].kind, 'ancestor');
  assert.deepStrictEqual(it.clippers[0].axes, ['x']);
});

console.log('auditFocusClip · 无法判定（undetermined）');
test('零面积节点 → zero-area（优先于阻断因素，不求交）', () => {
  const r = auditFocusClip([
    node(1, rect(10, 10, 0, 50), { blockReason: block('positioned', '不应到达') })
  ], { viewport: VP });
  const it = r.items[0];
  assert.strictEqual(it.status, 'undetermined');
  assert.strictEqual(it.reason, 'zero-area');
  assert.strictEqual(it.block, null);
  assert.ok(it.message.indexOf('零面积') >= 0);
  assert.deepStrictEqual(it.clippers, []);
  assert.strictEqual(r.stats.undetermined, 1);
});

test('absolute/fixed 定位阻断 → 无法判定（reason / message 透传）', () => {
  const r = auditFocusClip([
    node(1, rect(100, 100, 50, 50), {
      blockReason: block('positioned', '祖先 div.b 为 fixed 定位，矩形裁剪关系无法判定')
    })
  ], { viewport: VP });
  const it = r.items[0];
  assert.strictEqual(it.status, 'undetermined');
  assert.strictEqual(it.reason, 'positioned');
  assert.strictEqual(it.block.label, 'div.b');
  assert.strictEqual(it.message, '祖先 div.b 为 fixed 定位，矩形裁剪关系无法判定');
  assert.deepStrictEqual(it.clippers, []);
});

test('非 none 的 transform / clip-path 阻断 → 无法判定', () => {
  const r = auditFocusClip([
    node(1, rect(100, 100, 50, 50), { blockReason: block('transformed', 't') }),
    node(2, rect(100, 200, 50, 50), { blockReason: block('clip-path', 'c') })
  ], { viewport: VP });
  assert.strictEqual(r.items[0].reason, 'transformed');
  assert.strictEqual(r.items[1].reason, 'clip-path');
  assert.strictEqual(r.stats.undetermined, 2);
});

console.log('auditFocusClip · 统计与输出形状');
test('stats 汇总正确', () => {
  const r = auditFocusClip([
    node(1, rect(100, 100, 100, 100)),                                        // full
    node(2, rect(700, 100, 200, 100)),                                        // partial（视口）
    node(3, rect(900, 100, 100, 100)),                                        // clipped（视口）
    node(4, rect(0, 0, 0, 0))                                                 // zero-area
  ], { viewport: VP });
  assert.strictEqual(r.stats.total, 4);
  assert.strictEqual(r.stats.full, 1);
  assert.strictEqual(r.stats.partial, 1);
  assert.strictEqual(r.stats.clipped, 1);
  assert.strictEqual(r.stats.undetermined, 1);
  assert.strictEqual(r.items.length, 4);
  assert.deepStrictEqual(r.viewport, VP);
});

test('条目包含联动高亮与导出所需字段', () => {
  const r = auditFocusClip([
    node(1, rect(700, 100, 200, 100), { clippers: [ancestor(['y'], rect(0, 0, 800, 120), 'div.sc')] })
  ], { viewport: VP });
  const it = r.items[0];
  assert.strictEqual(it.step, 1);
  assert.ok(it.selector && it.label && typeof it.message === 'string');
  assert.ok(it.rect && it.visibleRect && typeof it.visibleRatio === 'number');
  const c = it.clippers[1];
  assert.strictEqual(c.kind, 'ancestor');
  assert.ok(c.label && c.selector && c.rect && Array.isArray(c.axes));
});

test('空输入 / null 输入安全', () => {
  const empty = auditFocusClip([], { viewport: VP });
  assert.deepStrictEqual(empty.items, []);
  assert.strictEqual(empty.stats.total, 0);
  assert.strictEqual(auditFocusClip(null).stats.total, 0);
  assert.strictEqual(auditFocusClip(undefined, null).items.length, 0);
});

console.log('\n' + passed + ' 个断言组通过' + (process.exitCode ? '（存在失败）' : ''));
