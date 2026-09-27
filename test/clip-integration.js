'use strict';

/**
 * 非 npm 套件的集成验证（依赖可选的 jsdom，仅本地/CI 可用时运行）：
 * 在真实 DOM + 计算样式下验证 analyzer.js 焦点裁剪审计的 DOM 采集与判定接线：
 * 组合祖先链（含跨 open ShadowRoot 宿主）overflow 判定、client 盒扣除边框、
 * iframe 视口求交、完整 / 部分裁剪分类与 transform 祖先「无法判定」。
 * jsdom 无布局：几何量（getBoundingClientRect / client* / 视口）以桩代替，
 * 计算样式（overflow / transform / position）由 jsdom 真实给出。
 * 运行：npm install --no-save jsdom && node test/clip-integration.js
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = `<!DOCTYPE html><html><body>
  <div id="scroller" style="overflow-x: hidden; overflow-y: auto; border: 5px solid black;">
    <button id="b1">被滚动盒纵向裁剪</button>
  </div>
  <button id="b2">视口内完整</button>
  <div id="tf" style="transform: translateX(1px);"><button id="b3">transform 祖先内</button></div>
  <x-host id="host"></x-host>
</body></html>`;

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

// 分析器内 parent.postMessage（sandbox iframe 形态）：让 parent 指向自身窗口
try { Object.defineProperty(window, 'parent', { value: window, configurable: true }); } catch (e) {}

// postMessage 采集（analyzer 经 setTimeout(0) 发消息，必须在 eval 前注册）
let routePayload = null;
window.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'route') routePayload = ev.data.payload;
  if (ev.data && ev.data.type === 'error') console.error('analyzer error:', ev.data.message);
});

// ---- open shadow root：内部 overflow 容器裁剪 shadow 内按钮 ----
const host = document.getElementById('host');
const sr = host.attachShadow({ mode: 'open' });
sr.innerHTML = '<div id="clipbox" style="overflow-y: hidden;"><button id="b4">shadow 内被裁</button></div>';

// ---- 几何桩（jsdom 无布局；视口取 jsdom 默认 1024×768） ----
function stubRect(el, left, top, width, height) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height });
}
function stubClient(el, left, top, width, height) {
  Object.defineProperty(el, 'clientLeft', { value: left, configurable: true });
  Object.defineProperty(el, 'clientTop', { value: top, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
}

const analyzerSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'analyzer.js'), 'utf8');
window.eval(analyzerSrc);

// 桩必须在 analyzer 的 setTimeout(0) 重算前同步就绪
const scroller = document.getElementById('scroller');
stubRect(scroller, 0, 0, 210, 60);
stubClient(scroller, 5, 5, 200, 50); // client 盒 = (5,5,200,50)：扣除 5px 边框
stubRect(document.getElementById('b1'), 10, 10, 100, 100); // y: 10..110 → 裁到 55
stubRect(document.getElementById('b2'), 10, 200, 100, 40); // 视口内完整
stubRect(document.getElementById('b3'), 10, 300, 100, 40); // transform 祖先 → 无法判定
const clipbox = sr.getElementById('clipbox');
stubRect(clipbox, 0, 400, 200, 40);
stubClient(clipbox, 0, 0, 200, 40); // client 盒 = (0,400,200,40)
stubRect(sr.getElementById('b4'), 10, 420, 100, 60); // y: 420..480 → 裁到 440

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
  const audit = routePayload.clipAudit;
  check('route 负载包含 clipAudit', !!audit);
  if (!audit) process.exit(1);

  console.log('视口与统计');
  check('视口尺寸来自 iframe window', audit.viewport && audit.viewport.width === 1024 && audit.viewport.height === 768,
    JSON.stringify(audit.viewport));
  check('stats：4 节点 = 1 完整 + 2 部分 + 1 无法判定',
    audit.stats.nodes === 4 && audit.stats.full === 1 && audit.stats.partial === 2 &&
    audit.stats.clipped === 0 && audit.stats.undetermined === 1, JSON.stringify(audit.stats));

  console.log('组合祖先 client 盒裁剪（扣除边框）');
  const item1 = audit.items.find(it => it.step === 1);
  check('b1 部分裁剪，剩余比例 0.45', item1 && item1.status === 'partial' && item1.ratio === 0.45,
    item1 && (item1.status + ' / ' + item1.ratio));
  check('b1 裁剪来源为 overflow 祖先（仅 y 轴）',
    item1 && item1.clippers.length === 1 && item1.clippers[0].kind === 'ancestor' &&
    item1.clippers[0].label === 'div#scroller' &&
    item1.clippers[0].axes.length === 1 && item1.clippers[0].axes[0] === 'y',
    item1 && JSON.stringify(item1.clippers));
  check('b1 剩余区域 (10,10,100,45)',
    item1 && item1.visible.left === 10 && item1.visible.top === 10 &&
    item1.visible.width === 100 && item1.visible.height === 45,
    item1 && JSON.stringify(item1.visible));
  check('b1 裁剪来源带分段选择器', item1 && /^L:/.test(item1.clippers[0].selector || ''),
    item1 && item1.clippers[0].selector);

  const item2 = audit.items.find(it => it.step === 2);
  check('b2 完整（视口内、无裁剪祖先）', item2 && item2.status === 'full' && item2.ratio === 1 &&
    item2.clippers.length === 0);

  console.log('跨 open ShadowRoot 宿主的祖先链');
  const item4 = audit.items.find(it => it.step === 4);
  check('shadow 内 b4 被 shadow 内 overflow 容器部分裁剪（比例 0.3333）',
    item4 && item4.status === 'partial' && item4.ratio === 0.3333,
    item4 && (item4.status + ' / ' + item4.ratio));
  check('b4 裁剪来源为 shadow 内 div#clipbox（仅 y 轴）',
    item4 && item4.clippers.length === 1 && item4.clippers[0].label === 'div#clipbox' &&
    item4.clippers[0].axes.length === 1 && item4.clippers[0].axes[0] === 'y',
    item4 && JSON.stringify(item4.clippers));
  check('b4 裁剪来源选择器跨边界（含 S 段）',
    item4 && / >> S:/.test(item4.clippers[0].selector || ''), item4 && item4.clippers[0].selector);

  console.log('无法判定');
  const und = audit.undetermined.find(u => u.step === 3);
  check('b3 因祖先 transform 无法判定（transformed）', und && und.reason === 'transformed',
    und && und.reason);
  check('无法判定来源记录该祖先（div#tf）', und && und.source && und.source.label === 'div#tf',
    und && JSON.stringify(und.source));
  check('无法判定条目带分段选择器（可联动高亮）', und && /^L:/.test(und.selector || ''), und && und.selector);

  console.log(failures ? '\n集成验证存在失败' : '\n集成验证全部通过');
  process.exit(failures ? 1 : 0);
}, 400);
