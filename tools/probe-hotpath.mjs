// [macro-fusion 0.6.14] 判据：热路不许在回执对象上「先挂后摘」。
//
// 背景（`docs/INTERNAL.md` 9.213）：`search` 每条候选人建一个 hit 对象，四个「先用后摘」的临时值
// （`_vb` / `_sr` / `_lv` / `_tr`）以前直接挂在对象上，用完靠 `delete h._lv;` 收场。`delete` 会把
// 对象打进字典模式（V8 从此按哈希表存取），后面 bandize 每次读 `_raw` 都在付这笔账——行级读数
// 里 `delete h._lv;` 一行就占 791.5ms（10,000 条 / 300 问，5,492ms 总采样）。
// 0.6.14 把它们挪进与 hits 同下标的平行数组。这个探针要证明三件事：
//
//   H1 主路不再用 delete 摘临时值；回执里也没有这些临时字段（字段集合与老口径一致）
//   H2 同一份语料连跑两遍逐位相同（平行数组没有跨查询残留）
//   H3 原样补分只落在被点名的那条上（下标错位就会落到别人头上 → 这条必红）
//   H4 层级意图的乘子只落在 rules 那条上（`lvTmp` 错位同理必红）
//   H5 断言密度的乘子只落在断言条目上（`trTmp` 错位同理必红）
//   H6 自适应 idf 换尺子时缓存清账：连跑两次相同，且与「先跑一遍关掉的」相同
import { readFileSync } from 'node:fs';
import { search } from '../vendor/meow-memory/lib/index.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`PASS ${name}${detail === '' ? '' : ` · ${detail}`}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}${detail === '' ? '' : ` · ${detail}`}`);
  }
};

const ENGINE = readFileSync(new URL('../vendor/meow-memory/lib/index.js', import.meta.url), 'utf8');
const NOW = 1795470000000;
const mk = (id, level, content, importance = 2) => ({
  id,
  level,
  title: 't',
  content,
  importance,
  updated_at: '2026-01-01T00:00:00Z',
  keywords: ['alpha'],
  project: 'p',
});
const plain = [
  mk('0mzzzzzz', 'fact', 'alpha beta delta'),
  mk('0mrrrrrr', 'rules', 'alpha 一律 必须先跑 alpha', 3),
  mk('0mfffffff', 'fact', 'alpha 随便 看看 alpha', 1),
  mk('0mvvvvvv', 'fact', 'alpha 必须 先 alpha', 4),
];

// ── H1 ───────────────────────────────────────────────────────────────────
{
  const iTmp = ENGINE.indexOf('const vbTmp = [];');
  const iEnd = ENGINE.indexOf("bandize(hits, '_raw', k)");
  const hot = iTmp > 0 && iEnd > iTmp ? ENGINE.slice(iTmp, iEnd) : '';
  const noDelete = hot.length > 0 && !['_vb', '_sr', '_lv', '_tr'].some((k) => hot.includes(`delete h.${k};`));
  const r = search('该不该 alpha', plain, { k: 5, explain: false, now: NOW });
  const leaked = r.filter((h) => ['_vb', '_sr', '_lv', '_tr', '_bandTmp'].some((k) => k in h));
  ok(
    'H1 主路不再用 delete 摘临时值（平行数组收场），回执里也没有临时字段',
    noDelete && r.length > 0 && leaked.length === 0,
    `delete 零处=${noDelete} · 泄漏条目 ${leaked.length}/${r.length}`,
  );
}

// ── H2 ───────────────────────────────────────────────────────────────────
{
  const a = JSON.stringify(search('该填什么值 alpha', plain, { k: 5, explain: true, now: NOW }));
  const b = JSON.stringify(search('该填什么值 alpha', plain, { k: 5, explain: true, now: NOW }));
  ok('H2 同一份语料连跑两遍逐位相同（平行数组不跨查询残留）', a === b, `${a.length} 字符`);
}

// ── H3 ───────────────────────────────────────────────────────────────────
{
  const docs = [
    mk('0mwq5zzv', 'fact', 'alpha beta'),
    mk('0mzzzzzz', 'fact', 'alpha beta'),
    mk('0mvvvvvv', 'fact', 'alpha beta'),
    mk('0mqqqqqq', 'fact', 'alpha beta'),
  ];
  const r = search('看看 0mwq5zzv 这条 alpha', docs, { k: 5, explain: true, now: NOW });
  const named = r.find((h) => h.id === '0mwq5zzv');
  const others = r.filter((h) => h.id !== '0mwq5zzv');
  const onlyOne = named !== void 0 && named.explain !== void 0 && named.explain.identBonus > 0 &&
    others.every((h) => h.explain === void 0 || h.explain.identBonus === void 0);
  ok(
    'H3 原样补分只落在被点名的那条上（下标错位就会落到别人头上）',
    onlyOne && named.explain.band === -1,
    `named bonus=${named?.explain?.identBonus ?? 'none'} · band=${named?.explain?.band ?? 'none'} · 别人带 bonus ${others.filter((h) => h.explain?.identBonus !== void 0).length} 条`,
  );
}

// ── H4 ───────────────────────────────────────────────────────────────────
{
  const r = search('该不该 alpha', plain, { k: 5, explain: true, now: NOW });
  const rules = r.filter((h) => h.level === 'rules');
  const facts = r.filter((h) => h.level !== 'rules');
  const onlyRules = rules.length === 1 && rules.every((h) => h.explain?.levelIntent === true) &&
    facts.every((h) => h.explain?.levelIntent === void 0);
  ok(
    'H4 层级意图的乘子只落在 rules 那条上（lvTmp 错位就会落到别人头上）',
    onlyRules,
    `rules ${rules.length} 条带乘子 ${rules.filter((h) => h.explain?.levelIntent === true).length} · 别的层级带乘子 ${facts.filter((h) => h.explain?.levelIntent !== void 0).length}`,
  );
}

// ── H5 ───────────────────────────────────────────────────────────────────
{
  const r = search('该填什么值 alpha', plain, { k: 5, explain: true, now: NOW });
  // 语料里开头就下断言的是 0mrrrrrr（一律）与 0mvvvvvv（必须）；0mzzzzzz / 0mfffffff 不是。
  const marked = r.filter((h) => h.explain?.tipAssert === true).map((h) => h.id).sort();
  ok(
    'H5 断言密度的乘子只落在开头就下断言的那几条上（trTmp 错位就会落到别人头上）',
    marked.length === 2 && marked[0] === '0mrrrrrr' && marked[1] === '0mvvvvvv',
    `带乘子 ${marked.join(',') || '无'}`,
  );
}

// ── H6 ───────────────────────────────────────────────────────────────────
{
  const q = 'alpha beta';
  const twoOn = JSON.stringify(search(q, plain, { k: 5, adaptiveIdf: true, explain: true, now: NOW }));
  search(q, plain, { k: 5, adaptiveIdf: false, now: NOW });
  const onAgain = JSON.stringify(search(q, plain, { k: 5, adaptiveIdf: true, explain: true, now: NOW }));
  const onTwice = JSON.stringify(search(q, plain, { k: 5, adaptiveIdf: true, explain: true, now: NOW }));
  ok(
    'H6 自适应 idf 换尺子时缓存清账：直接开 / 先关后开 / 连开两次，三份逐位相同',
    twoOn === onAgain && onAgain === onTwice,
    `${twoOn.length} 字符`,
  );
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  probe-hotpath：${pass}/${pass + fail}`);
process.exitCode = fail === 0 ? 0 : 1;
