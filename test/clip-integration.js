'use strict';

/**
 * 焦点裁剪审计集成验证（依赖可选的 jsdom，仅本地/CI 可用时运行）：
 * jsdom 不做布局，这里用 __rect / __client 模拟 getBoundingClientRect 与
 * client 盒（clientLeft/Top + clientWidth/Height），验证 analyzer.js 的
 * DOM 采集逻辑——组合祖先链（slot / open ShadowRoot 宿主）上溯、
 * overflow-x/y 仅裁对应轴、client 盒（扣除边框 / 滚动条）求交、
 * absolute|fixed / transform / clip-path 阻断与零面积无法判定。
 * 运行：npm install --no-save jsdom && node test/clip-integration.js
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// 注意：jsdom 不展开 overflow  shorthand，测试一律使用 overflow-x / overflow-y 长写
const html = `<!DOCTYPE html><html><body>
  <button id="b-plain">完整</button>
  <div id="sc-x" style="overflow-x: hidden"><button id="b-scx">x 轴裁剪</button></div>
  <div id="sc-y" style="overflow-y: auto"><button id="b-scy">y 轴裁剪</button></div>
  <div id="fx" style="position: fixed"><button id="b-fixed">fixed 祖先</button></div>
  <div id="tf" style="transform: scale(1)"><button id="b-tf">transform 祖先</button></div>
  <div id="cp" style="clip-path: inset(0)"><button id="b-cp">clip-path 祖先</button></div>
  <button id="b-self-abs" style="position: absolute">自身 absolute</button>
  <button id="b-zero">零面积</button>
  <x-host id="xh"><button id="b-slot" slot="s">slotted</button></x-host>
</body></html>`;

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

// ---- 模拟布局：getBoundingClientRect 与 client 盒（jsdom 全零）----
window.HTMLElement.prototype.getBoundingClientRect = function () {
  const r = this.__rect || { left: 0, top: 0, width: 0, height: 0 };
  return {
    left: r.left, top: r.top, width: r.width, height: r.height,
    right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top,
    toJSON() { return {}; }
  };
};
['clientLeft', 'clientTop', 'clientWidth', 'clientHeight'].forEach((prop) => {
  const key = prop.replace('client', '').toLowerCase(); // left/top/width/height
  Object.defineProperty(window.HTMLElement.prototype, prop, {
    configurable: true,
    get() { return (this.__client && this.__client[key]) || 0; }
  });
});
function layout(id, rect, client) {
  const el = document.getElementById(id) || window.document.querySelector('#' + id);
  el.__rect = rect;
  if (client) el.__client = client;
  return el;
}

// 分析器内 parent.postMessage（sandbox iframe 形态）：让 parent 指向自身窗口
try { Object.defineProperty(window, 'parent', { value: window, configurable: true }); } catch (e) {}

// postMessage 采集（analyzer 经 setTimeout(0) 发消息，必须在 eval 前注册）
let routePayload = null;
window.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'route') routePayload = ev.data.payload;
  if (ev.data && ev.data.type === 'error') console.error('analyzer error:', ev.data.message);
});

// ---- shadow 宿主：shadow 内 overflow 容器 + 具名 slot（slotted 节点沿组合祖先被裁剪）----
document.getElementById('xh').attachShadow({ mode: 'open' }).innerHTML =
  '<div id="sd" style="overflow-x: hidden; overflow-y: hidden"><slot name="s"></slot></div>';

// ---- 布局数据（视口 1024×768，pretendToBeVisual）----
layout('b-plain', { left: 10, top: 10, width: 100, height: 40 });
// sc-x：border 盒 (10,100,200,100)，client 盒 = (20,110,180,80)（左边框 10、上边框 10、滚动条 20）
layout('sc-x', { left: 10, top: 100, width: 200, height: 100 }, { left: 10, top: 10, width: 180, height: 80 });
layout('b-scx', { left: 150, top: 110, width: 100, height: 40 }); // x [150,250] ∩ client [20,200] → 宽 50
// sc-y：border 盒 (10,300,200,100)，client 盒 = (10,300,200,60)
layout('sc-y', { left: 10, top: 300, width: 200, height: 100 }, { left: 0, top: 0, width: 200, height: 60 });
layout('b-scy', { left: 20, top: 330, width: 100, height: 60 }); // y [330,390] ∩ client [300,360] → 高 30
layout('b-fixed', { left: 10, top: 500, width: 100, height: 40 });
layout('b-tf', { left: 10, top: 550, width: 100, height: 40 });
layout('b-cp', { left: 10, top: 600, width: 100, height: 40 });
layout('b-self-abs', { left: 10, top: 650, width: 100, height: 40 });
// b-zero 不给矩形 → 零面积
// shadow 内裁剪容器 sd：client 盒 = (495,5,110,20)
const sd = document.getElementById('xh').shadowRoot.getElementById('sd');
sd.__rect = { left: 490, top: 0, width: 120, height: 30 };
sd.__client = { left: 5, top: 5, width: 110, height: 20 };
layout('b-slot', { left: 500, top: 10, width: 100, height: 40 }); // y [10,50] ∩ [5,25] → 高 15

const analyzerSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'analyzer.js'), 'utf8');
window.eval(analyzerSrc);

setTimeout(() => {
  let failures = 0;
  function check(name, cond, extra) {
    if (cond) { console.log('  ✓ ' + name); }
    else { failures++; console.error('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
  }

  if (!routePayload) {
    console.error('未收到 route 消息');
    process.exit(1);
  }
  const audit = routePayload.focusClipAudit;
  if (!audit) {
    console.error('路线负载缺少 focusClipAudit');
    process.exit(1);
  }
  const items = audit.items || [];
  const byId = (id) => items.find((it) => it.label && it.label.indexOf('#' + id) >= 0);

  console.log('视口与完整节点');
  check('导出 iframe 视口矩形（1024×768）',
    audit.viewport && audit.viewport.width === 1024 && audit.viewport.height === 768,
    JSON.stringify(audit.viewport));
  const plain = byId('b-plain');
  check('视口内无裁剪祖先 → 完整（full），无裁剪来源',
    plain && plain.status === 'full' && plain.clippers.length === 0 && plain.visiblePercent === 100,
    plain && plain.status + ' ' + plain.visiblePercent);

  console.log('祖先 overflow 仅裁对应轴（client 盒）');
  const scx = byId('b-scx');
  check('overflow-x:hidden 仅裁 x 轴 → 部分裁剪 50%（client 盒含左边框偏移）',
    scx && scx.status === 'partial' && scx.visiblePercent === 50 &&
    scx.visibleRect.width === 50 && scx.visibleRect.height === 40,
    scx && scx.status + ' ' + scx.visiblePercent + ' ' + JSON.stringify(scx.visibleRect));
  check('裁剪来源为该祖先且 axes 仅含 x',
    scx && scx.clippers.length === 1 && scx.clippers[0].kind === 'ancestor' &&
    scx.clippers[0].label.indexOf('#sc-x') >= 0 &&
    scx.clippers[0].axes.length === 1 && scx.clippers[0].axes[0] === 'x',
    scx && JSON.stringify(scx.clippers));
  const scy = byId('b-scy');
  check('overflow-y:auto 仅裁 y 轴 → 部分裁剪 50%，axes 仅含 y',
    scy && scy.status === 'partial' && scy.visiblePercent === 50 &&
    scy.visibleRect.height === 30 && scy.visibleRect.width === 100 &&
    scy.clippers.length === 1 && scy.clippers[0].axes[0] === 'y',
    scy && scy.status + ' ' + scy.visiblePercent + ' ' + JSON.stringify(scy.clippers));

  console.log('组合祖先链：slot / open ShadowRoot 宿主上溯');
  const slot = byId('b-slot');
  check('slotted 节点被 shadow 内 overflow 容器裁剪 → 部分裁剪 37.5%',
    slot && slot.status === 'partial' && slot.visiblePercent === 37.5 &&
    slot.visibleRect.height === 15,
    slot && slot.status + ' ' + slot.visiblePercent + ' ' + JSON.stringify(slot.visibleRect));
  check('裁剪来源为 shadow 内祖先 #sd（axes 含 x 与 y）',
    slot && slot.clippers.length === 1 && slot.clippers[0].label.indexOf('#sd') >= 0 &&
    slot.clippers[0].axes.length === 2,
    slot && JSON.stringify(slot.clippers));

  console.log('无法判定');
  const fixed = byId('b-fixed');
  check('祖先 fixed 定位 → 无法判定（positioned，at=ancestor，记录祖先标签）',
    fixed && fixed.status === 'undetermined' && fixed.reason === 'positioned' &&
    fixed.block && fixed.block.at === 'ancestor' && fixed.block.label.indexOf('#fx') >= 0,
    fixed && fixed.reason + ' ' + JSON.stringify(fixed.block));
  const tf = byId('b-tf');
  check('祖先非 none transform → 无法判定（transformed）',
    tf && tf.status === 'undetermined' && tf.reason === 'transformed', tf && tf.reason);
  const cp = byId('b-cp');
  check('祖先非 none clip-path → 无法判定（clip-path）',
    cp && cp.status === 'undetermined' && cp.reason === 'clip-path', cp && cp.reason);
  const selfAbs = byId('b-self-abs');
  check('节点自身 absolute → 无法判定（positioned，at=self）',
    selfAbs && selfAbs.status === 'undetermined' && selfAbs.reason === 'positioned' &&
    selfAbs.block && selfAbs.block.at === 'self',
    selfAbs && selfAbs.reason + ' ' + JSON.stringify(selfAbs.block));
  const zero = byId('b-zero');
  check('零面积节点 → 无法判定（zero-area）',
    zero && zero.status === 'undetermined' && zero.reason === 'zero-area', zero && zero.reason);

  console.log('统计');
  const st = audit.stats || {};
  check('stats 计数与条目一致',
    st.total === items.length &&
    st.full === items.filter((i) => i.status === 'full').length &&
    st.partial === items.filter((i) => i.status === 'partial').length &&
    st.clipped === items.filter((i) => i.status === 'clipped').length &&
    st.undetermined === items.filter((i) => i.status === 'undetermined').length,
    JSON.stringify(st));
  check('本例统计：完整 1 · 部分裁剪 3 · 完全裁剪 0 · 无法判定 5',
    st.full === 1 && st.partial === 3 && st.clipped === 0 && st.undetermined === 5,
    JSON.stringify(st));
  check('条目带 Tab 序号与分段选择器（可联动高亮 / 导出）',
    items.every((i) => typeof i.step === 'number' && typeof i.selector === 'string' && i.selector.length > 0));

  if (failures) { console.error('\n集成验证存在 ' + failures + ' 个失败'); process.exit(1); }
  console.log('\n集成验证全部通过');
}, 2000); // jsdom 的 getComputedStyle 很慢且进程间波动大，留足等待余量（真实浏览器为毫秒级）
