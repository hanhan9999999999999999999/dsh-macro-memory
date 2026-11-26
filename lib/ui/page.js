/**
 * 管理界面的那一页（PLAN §10 / P2-1）。整份 HTML 就是一个常量，不引框架、不打包、不联网。
 *
 * 为什么内嵌：界面不是必需路径（PLAN 原话）。它要么轻到「打开就能用」，要么就别进仓库；
 * 一旦引入构建链，`npm i -g macro-memory` 之后还要跑一遍 bundler，这条路径就废了。
 * 首屏体积判据是 ≤200 KB（PLAN §10），这一份连 <script> 带样式约 18 KB。
 *
 * 令牌从 URL 的 `?t=` 拿，之后每个 `/api/*` 都带 `x-mm-token` 头——刷新页面令牌还在，
 * 因为地址栏里那条带 t= 的 URL 就是凭据本身。
 */
export const PAGE_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>宏记忆 · 管理界面</title>
<style>
:root{--bg:#0b1220;--fg:#e6edf7;--dim:#8ea3bf;--card:#131c2e;--line:#22304a;--acc:#5aa9ff;--ok:#4cd39a;--warn:#f2b23f;--bad:#f2705f}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif}
header{position:sticky;top:0;z-index:5;background:#0e1728ee;border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
h1{font-size:15px;margin:0;font-weight:600;letter-spacing:.4px}
nav{display:flex;gap:6px;flex-wrap:wrap}
nav a{padding:5px 10px;border-radius:7px;color:var(--dim);text-decoration:none;border:1px solid transparent}
nav a.on{color:#fff;background:#17304f;border-color:#265486}
main{padding:16px;max-width:1180px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:12px}
.card h2{font-size:13.5px;margin:0 0 8px;font-weight:600;color:#c9d8ee}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.k{color:var(--dim);font-size:12px}
.v{font-size:19px;font-weight:600}
pre{background:#0a1120;border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;max-height:440px;white-space:pre-wrap;word-break:break-word;font-size:12.5px;margin:0}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:500}
input,select,button{background:#0a1120;color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:6px 9px;font:inherit}
button{cursor:pointer}
button:hover{border-color:var(--acc)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11.5px;border:1px solid var(--line);color:var(--dim)}
.err{color:var(--bad)}
.muted{color:var(--dim)}
.bar{height:8px;background:#0a1120;border:1px solid var(--line);border-radius:999px;overflow:hidden}
.bar>i{display:block;height:100%;background:var(--acc)}
</style>
</head>
<body>
<header>
  <h1>宏记忆 · 管理界面</h1>
  <nav id="nav"></nav>
  <span class="muted" id="mode"></span>
</header>
<main id="main"><div class="card muted">正在连本地库…</div></main>
<script>
var T = new URLSearchParams(location.search).get('t') || '';
var main = document.getElementById('main');
var nav = document.getElementById('nav');
var lastState = null;

function api(p, body) {
  var opt = { method: body ? 'POST' : 'GET', headers: { 'x-mm-token': T } };
  if (body) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
  return fetch(p, opt).then(function (r) {
    return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (j) {
      if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
      return j;
    });
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

var PAGES = [
  ['overview', '概览'],
  ['memory', '记忆'],
  ['graph', '星图'],
  ['inject', '注入预览'],
  ['agents', 'agent'],
  ['share', '共享'],
  ['ops', '运维']
];

function paintNav(active) {
  nav.innerHTML = PAGES.map(function (p) {
    return '<a href="#/' + p[0] + '" class="' + (p[0] === active ? 'on' : '') + '">' + p[1] + '</a>';
  }).join('');
}

function fail(e) {
  return '<div class="card err">出错了：' + esc(e && e.message ? e.message : e) + '</div>';
}

// ── 概览 ──────────────────────────────────────────────────────────────────────
function drawOverview() {
  return api('/api/state').then(function (s) {
    lastState = s;
    document.getElementById('mode').textContent = s.upstream.mode === 'shared'
      ? '共享（' + s.upstream.note + '）'
      : '临时服务（' + s.upstream.note + '）';
    var c = s.census || {};
    var layers = Object.keys(c.layers || {}).sort(function (a, b) { return (c.layers[b] || 0) - (c.layers[a] || 0); });
    var max = 1;
    layers.forEach(function (k) { if ((c.layers[k] || 0) > max) max = c.layers[k]; });
    var bars = layers.map(function (k) {
      var n = c.layers[k] || 0;
      return '<div style="margin:6px 0"><div class="row" style="margin:0 0 3px"><span class="tag">' + esc(k || '未标层') + '</span>' +
        '<span class="muted">' + n + ' 条</span></div><div class="bar"><i style="width:' + Math.round(100 * n / max) + '%"></i></div></div>';
    }).join('') || '<div class="muted">这个库还没有记过归属。</div>';
    var ags = (c.agents || []).map(function (a) { return a.owner + '（' + a.n + '）'; }).join(' · ') || '（无）';
    main.innerHTML =
      '<div class="card"><div class="grid">' +
        card('库里记过归属的条目', c.total || 0) +
        card('写手', c.owners || 0) +
        card('private / workspace / global', (c.scopes.private || 0) + ' / ' + (c.scopes.workspace || 0) + ' / ' + (c.scopes.global || 0)) +
        card('L0 注入体积', (s.injectChars || 0) + ' 字符') +
        card('待补交', (s.stats && s.stats.pending) || 0) +
        card('版本', s.version) +
      '</div></div>' +
      '<div class="card"><h2>七层分布</h2>' + bars + '</div>' +
      '<div class="card"><h2>写手</h2><div>' + esc(ags) + '</div></div>' +
      '<div class="card"><h2>这一页的口径</h2><div class="muted">数字来自归属账（mem_owner），只算「0.9 之后写过、并且被记了归属」的条目；' +
      '要看 meow 自己的全量账，去运维页点「统计」。库里没记过归属时这里是空账，不是错——也不会为了让界面好看而建库建表。</div></div>';
  });
}

function card(k, v) {
  return '<div><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>';
}

// ── 记忆 ──────────────────────────────────────────────────────────────────────
function drawMemory() {
  main.innerHTML =
    '<div class="card"><h2>搜索</h2>' +
      '<div class="row"><input id="q" placeholder="搜什么" style="min-width:240px" value="">' +
      '<select id="m-mode"><option value="">默认（三段召回）</option><option value="graph">星图</option><option value="bridge">补邻居</option></select>' +
      '<select id="m-k"><option value="10">10 条</option><option value="20">20 条</option><option value="40">40 条</option></select>' +
      '<button id="go">搜</button></div>' +
      '<div class="muted">点下面的 id 看全文。过滤交给查询词与工具参数；这一页不替你改库。</div>' +
    '</div><div class="card" id="out"><span class="muted">还没有结果。</span></div>';
  var go = function () {
    var q = document.getElementById('q').value;
    var mode = document.getElementById('m-mode').value;
    var k = document.getElementById('m-k').value;
    var p = '/api/search?q=' + encodeURIComponent(q) + '&k=' + encodeURIComponent(k) + (mode ? '&mode=' + encodeURIComponent(mode) : '');
    document.getElementById('out').innerHTML = '<span class="muted">查…</span>';
    api(p).then(function (out) {
      var ids = [];
      var text = out.text || '';
      var re = /\[([0-9a-z]{8})[0-9a-z-]*\]/g;
      var m;
      while ((m = re.exec(text)) !== null) { if (ids.indexOf(m[1]) < 0) ids.push(m[1]); }
      var chips = ids.map(function (id) { return '<button class="rd" data-id="' + id + '">' + id + '</button>'; }).join(' ') || '<span class="muted">（回执里没有可点的 id）</span>';
      document.getElementById('out').innerHTML =
        '<div class="row">' + chips + '</div><pre>' + esc(text) + '</pre><div class="card" id="detail" style="display:none"></div>';
      Array.prototype.forEach.call(document.querySelectorAll('.rd'), function (b) {
        b.onclick = function () {
          var d = document.getElementById('detail');
          d.style.display = 'block';
          d.innerHTML = '<span class="muted">读 ' + b.getAttribute('data-id') + '…</span>';
          api('/api/read?id=' + encodeURIComponent(b.getAttribute('data-id'))).then(function (r) {
            d.innerHTML = '<pre>' + esc(r.text || JSON.stringify(r.value, null, 2)) + '</pre>';
          }).catch(function (e) { d.innerHTML = fail(e); });
        };
      });
    }).catch(function (e) { document.getElementById('out').innerHTML = fail(e); });
  };
  document.getElementById('go').onclick = go;
  document.getElementById('q').onkeydown = function (ev) { if (ev.key === 'Enter') go(); };
}

// ── 星图 ──────────────────────────────────────────────────────────────────────
function drawGraph() {
  main.innerHTML =
    '<div class="card"><h2>星图（只读）</h2>' +
      '<div class="row"><input id="gq" placeholder="从一个词开始扩散" style="min-width:260px"><button id="ggo">扩散</button></div>' +
      '<div class="muted">星图只在 graph / bridge 模式参与检索（这条纪律从 0.8 起没变）。节点多的时候（超过 2000）界面只给文本，不画线——降级渲染是 PLAN 的要求，宁可少画，不可卡死。</div>' +
    '</div><div class="card" id="gout"><span class="muted">还没有扩散结果。</span></div>';
  document.getElementById('ggo').onclick = function () {
    var q = document.getElementById('gq').value;
    document.getElementById('gout').innerHTML = '<span class="muted">扩散…</span>';
    api('/api/search?mode=graph&k=30&q=' + encodeURIComponent(q)).then(function (out) {
      document.getElementById('gout').innerHTML = '<pre>' + esc(out.text || JSON.stringify(out.value, null, 2)) + '</pre>';
    }).catch(function (e) { document.getElementById('gout').innerHTML = fail(e); });
  };
}

// ── 注入预览 ──────────────────────────────────────────────────────────────────
function drawInject() {
  main.innerHTML =
    '<div class="card"><h2>L0 注入预览</h2>' +
      '<div class="row"><input id="cap" placeholder="字符预算（留空 = 配置值）" style="width:220px"><button id="igo">生成</button><span class="tag" id="ichars"></span></div>' +
      '<div class="muted">这是这一轮真的会被塞进上下文的那段字。改它只有一个入口：改库（记忆页 / 工具），不要指望界面替你改。</div>' +
    '</div><div class="card" id="iout"><span class="muted">点生成。</span></div>';
  document.getElementById('igo').onclick = function () {
    var cap = document.getElementById('cap').value;
    document.getElementById('iout').innerHTML = '<span class="muted">生成…</span>';
    api('/api/inject' + (cap ? '?maxChars=' + encodeURIComponent(cap) : '')).then(function (out) {
      document.getElementById('ichars').textContent = out.chars + ' 字符';
      document.getElementById('iout').innerHTML = '<pre>' + esc(out.text || '') + '</pre>';
    }).catch(function (e) { document.getElementById('iout').innerHTML = fail(e); });
  };
}

// ── agent ─────────────────────────────────────────────────────────────────────
function drawAgents() {
  return api('/api/state').then(function (s) {
    var c = s.census || {};
    var rows = (c.agents || []).map(function (a) {
      return '<tr><td>' + esc(a.owner) + '</td><td>' + a.n + '</td><td class="muted">' + esc(ago(a.first)) + '</td><td class="muted">' + esc(ago(a.last)) + '</td></tr>';
    }).join('') || '<tr><td colspan="4" class="muted">还没有 agent 写过东西。</td></tr>';
    main.innerHTML =
      '<div class="card"><h2>写过东西的 agent</h2><table><tr><th>agent</th><th>条数</th><th>第一次</th><th>最近一次</th></tr>' + rows + '</table></div>' +
      '<div class="card"><h2>当前身份</h2><div>这个界面自己报的名字：<span class="tag">' + esc(s.agent) + '</span></div>' +
      '<div class="muted" style="margin-top:6px">界面是 serve 的客户端，所有写都经 serve 落账，所以这里出现的就是它的真实身份。注册 / 吊销 / lastSeen 那三件要改的是 agent 注册表，0.9 还没做——现在 agent 是「自报名字 + 归属账」两条线，没有中心目录。</div></div>';
  });
}

function ago(ts) {
  if (!ts) return '—';
  var d = Math.floor((Date.now() - Number(ts)) / 1000);
  if (!isFinite(d) || d < 0) return '—';
  if (d < 60) return d + ' 秒前';
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
  return Math.floor(d / 86400) + ' 天前';
}

// ── 共享 ──────────────────────────────────────────────────────────────────────
function drawShare() {
  return api('/api/state').then(function (s) {
    var c = s.census || {};
    var lv = Object.keys(c.matrix || {});
    var body = lv.map(function (k) {
      var m = c.matrix[k] || {};
      return '<tr><td>' + esc(k || '未标层') + '</td><td>' + (m.private || 0) + '</td><td>' + (m.workspace || 0) + '</td><td>' + (m.global || 0) + '</td></tr>';
    }).join('') || '<tr><td colspan="4" class="muted">还没有归属记录。</td></tr>';
    var st = s.stats || {};
    main.innerHTML =
      '<div class="card"><h2>层 × scope 矩阵</h2><table><tr><th>层</th><th>private</th><th>workspace</th><th>global</th></tr>' + body + '</table></div>' +
      '<div class="card"><h2>共享状态</h2><div class="grid">' +
        card('模式', s.upstream.mode === 'shared' ? 'shared' : 'standalone（界面临时起的）') +
        card('写者 pid', s.upstream.pid) +
        card('已服务调用', (st.calls == null ? '—' : st.calls)) +
        card('待补交', (st.pending == null ? '—' : st.pending)) +
      '</div><div class="muted" style="margin-top:8px">' + esc(s.upstream.note) + '。private 只对写它的那个 agent 开放；' +
      '别人搜不到也读不到（明说「不给你看」，不是假装不存在）。redact 开关与导出/导入 0.9 还没做，这一页只报矩阵。</div></div>';
  });
}

// ── 运维 ─────────────────────────────────────────────────────────────────────
function drawOps() {
  main.innerHTML =
    '<div class="card"><h2>一键动作</h2><div class="row">' +
      '<button data-a="hygiene">体检</button>' +
      '<button data-a="stats">统计</button>' +
      '<button data-a="snapshot">快照</button>' +
      '<button data-a="dream">整理账</button>' +
      '<button data-a="dreamrun">真整理一次</button>' +
    '</div><div class="muted">前四个都是只读账；「真整理一次」会写（dream 会封存本窗口的记忆）。队列与锁状态在下面的「服务状态」里。</div></div>' +
    '<div class="card"><h2>结果</h2><pre id="oout"></pre></div>' +
    '<div class="card"><h2>服务状态</h2><pre id="ostat"></pre></div>';
  var out = document.getElementById('oout');
  Array.prototype.forEach.call(document.querySelectorAll('button[data-a]'), function (b) {
    b.onclick = function () {
      var a = b.getAttribute('data-a');
      out.textContent = '跑 ' + a + '…';
      var p = a === 'dreamrun'
        ? api('/api/call', { tool: 'memory_dream', args: {} })
        : api('/api/call', { tool: 'memory_admin', args: { action: a } });
      p.then(function (r) { out.textContent = r.text || JSON.stringify(r.value, null, 2); })
        .catch(function (e) { out.textContent = '出错了：' + (e.message || e); });
    };
  });
  api('/api/state').then(function (s) {
    document.getElementById('ostat').textContent = JSON.stringify({ upstream: s.upstream, stats: s.stats, dataDir: s.dataDir, cwd: s.cwd }, null, 2);
  }).catch(function (e) { document.getElementById('ostat').textContent = String(e && e.message || e); });
}

function route() {
  var name = (location.hash || '#/overview').replace('#/', '') || 'overview';
  var known = PAGES.map(function (p) { return p[0]; });
  if (known.indexOf(name) < 0) name = 'overview';
  paintNav(name);
  var fn = { overview: drawOverview, memory: drawMemory, graph: drawGraph, inject: drawInject, agents: drawAgents, share: drawShare, ops: drawOps }[name];
  try {
    var r = fn();
    if (r && r.catch) r.catch(function (e) { main.innerHTML = fail(e); });
  } catch (e) { main.innerHTML = fail(e); }
}

window.addEventListener('hashchange', route);
route();
</script>
</body>
</html>
`
