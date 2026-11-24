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

// ── H7 ───────────────────────────────────────────────────────────────────
// [macro-fusion 0.6.28] 覆盖度的幂默认是 1，而 `Math.pow(x, 1)` 与 `x` 逐位相同，却要付一次通用幂。
{
  const powOne = ENGINE.includes('const COORD_POW_ONE = COORD_POW === 1;');
  const sites = (ENGINE.match(/cvr = COORD_POW_ONE \? coverOf\[di\] : Math\.pow\(coverOf\[di\], COORD_POW\);/g) || []).length;
  const bare = (ENGINE.match(/cvr = Math\.pow\(coverOf\[di\], COORD_POW\);/g) || []).length;
  const a = JSON.stringify(search('alpha beta', plain, { k: 5, explain: true, now: NOW }));
  const b = JSON.stringify(search('alpha beta', plain, { k: 5, coordPow: 1, explain: true, now: NOW }));
  const c = JSON.stringify(search('alpha beta', plain, { k: 5, coordPow: 2, explain: true, now: NOW }));
  ok(
    'H7 覆盖度幂的恒等快路：pow=1 时两处都走三元（无裸求幂），结果与显式 pow=1 逐位相同、与 pow=2 不同',
    powOne && sites === 2 && bare === 0 && a === b && c !== a,
    `形状=${powOne} 两处=${sites} 裸写=${bare} pow2 变=${c !== a}`,
  );
}

// ── H8 ───────────────────────────────────────────────────────────────────
// 档号是 raw 的纯函数：同分只该二分一次。错位（抄了别人的档号）就会串档，所以逐对验。
{
  const same = [];
  for (let i = 0; i < 6; i++) same.push(mk(`0msame0${i}`, 'fact', 'alpha beta delta'));
  same.push(mk('0mlong01', 'fact', 'alpha beta delta gamma epsilon zeta alpha beta'));
  same.push(mk('0mshort1', 'fact', 'alpha'));
  const hs = search('alpha beta', same, { k: 20, keepBand: true, now: NOW }).filter((h) => h._band !== void 0);
  let pairBad = 0;
  for (let i = 0; i < hs.length; i++) {
    for (let j = 0; j < hs.length; j++) {
      const x = hs[i];
      const y = hs[j];
      if (x._raw === y._raw && x._band !== y._band) pairBad += 1;
      if (x._raw > y._raw && x._band > y._band) pairBad += 1;
    }
  }
  const shape = ENGINE.includes('let lastV = -1;') && ENGINE.includes('if (v === lastV) {') &&
    ENGINE.includes('lastV = v;') && ENGINE.includes('lastBand = m - 1 - lo;');
  ok(
    'H8 档号同分批量：同分同档、异分不串档（逐对）',
    shape && hs.length > 3 && pairBad === 0,
    `形状=${shape} ${hs.length} 条逐对 · 违例=${pairBad}`,
  );
}

// ── H9 ───────────────────────────────────────────────────────────────────
// [macro-fusion 0.6.28] 热查临时缓冲按长度复用。复用的只是「谁持有内存」，每问照样清零。
{
  const shape = ENGINE.includes('const HOT_SCRATCH = { busy: false,') &&
    ENGINE.includes('function hotScratchOf(n) {') && ENGINE.includes('if (s.busy) return null;') &&
    ENGINE.includes('function hotScratchDone() {') &&
    ENGINE.includes('const scratch = hotScratchOf(docs.length);') &&
    (ENGINE.match(/hotScratchDone\(\);/g) || []).length === 2 &&
    (ENGINE.match(/scratch === null \?/g) || []).length === 6;
  const A = 'alpha beta';
  const B = 'alpha 一律 必须先跑';
  const s1 = JSON.stringify(search(A, plain, { k: 5, explain: true, now: NOW }));
  const s2 = JSON.stringify(search(A, plain, { k: 5, explain: true, now: NOW }));
  search(B, plain, { k: 5, explain: true, now: NOW });
  const s3 = JSON.stringify(search(A, plain, { k: 5, explain: true, now: NOW }));
  const big = plain.concat([mk('0mbig001', 'fact', 'alpha beta gamma'), mk('0mbig002', 'fact', 'alpha delta')]);
  const t1 = JSON.stringify(search(A, big, { k: 5, explain: true, now: NOW }));
  const t2 = JSON.stringify(search(A, big, { k: 5, explain: true, now: NOW }));
  const s4 = JSON.stringify(search(A, plain, { k: 5, explain: true, now: NOW }));
  ok(
    'H9 临时缓冲按长度复用：连跑 / 插别的问 / 换语料长度再换回来，同问三份逐位相同',
    shape && s1 === s2 && s2 === s3 && s1 === s4 && t1 === t2,
    `形状=${shape} ${s1.length} 字符`,
  );
}

// ── H10 ──────────────────────────────────────────────────────────────────
// kDen / cvrOf 不清零（只在候选上先写后读），所以必须证明「跨选项、跨问」不会把脏值读进来。
{
  const q1 = 'alpha beta';
  const base = { k: 5, now: NOW };
  const first = JSON.stringify(search(q1, plain, { ...base, explain: true }));
  search(q1, plain, { ...base, coordPow: 2 });
  search(q1, plain, { ...base, inverted: false });
  search('0mzzzzzz', plain, base);
  search(q1, plain, { ...base, coord: false });
  const again = JSON.stringify(search(q1, plain, { ...base, explain: true }));
  ok(
    'H10 复用的缓冲不跨选项 / 不跨问残留：中间插 pow=2、inverted=false、另一问、coord=false，同一问逐位相同',
    first === again && first.length > 2,
    `${first.length} 字符`,
  );
}

// ── H11 ──────────────────────────────────────────────────────────────────
// [macro-fusion 0.6.29] 字段权重从「两次位与 + 两次加法」改成一次查表。
// 表的四格必须与老写法的逐位结果相同——含非整值权重时加法顺序一换末位就会动，所以逐对用 Object.is 比。
{
  const shape = ENGINE.includes('const FIELD_W_TAB = [1, 1 + FIELD_TITLE_W, 1 + FIELD_KW_W, 1 + FIELD_TITLE_W + FIELD_KW_W];') &&
    ENGINE.includes('const fw = FIELD_W_TAB[fl & 3];') &&
    ENGINE.includes('idf0 * fw * (f * k1p1 / (f + kDen[di]))') &&
    ENGINE.includes('if (fl & 1) fw += FIELD_TITLE_W;') === false;
  const oldWay = (fl, T, K) => {
    let fw = 1;
    if (fl & 1) fw += T;
    if (fl & 2) fw += K;
    return fw;
  };
  let bad = 0;
  for (const [T, K] of [[0.6, 0.6], [0.6, 0.1 + 0.2], [0.30000000000000004, 0.7], [0.6, 1e-9]]) {
    const tab = [1, 1 + T, 1 + K, 1 + T + K];
    for (let fl = 0; fl < 4; fl++) if (!Object.is(tab[fl], oldWay(fl, T, K))) bad += 1;
  }
  const r = search('alpha beta', plain, { k: 5, fieldKwW: 0.1 + 0.2, now: NOW });
  ok(
    'H11 字段权重查表：四格与「逐位加成」逐位相同（含非整值权重），内层不再分支',
    shape && bad === 0 && r.length > 0,
    `形状=${shape} 表值不符=${bad}`,
  );
}

// ── H12 ──────────────────────────────────────────────────────────────────
// [macro-fusion 0.6.29] 默认路（`explain` / `keepBand` 都为假）的瘦对象上不再算 `cover`：
// 这条路的回执是截断之后由 `matHitOf` 整条重铺的，`cover` 在那里按 `coverOf[di]` 现算，
// 扫描期到定档之间没有任何一处读它。三条路的 `cover` 必须逐位相同。
{
  // 这三处仍然表示「同一个表达式」：完整字面量里一处、`matHitOf` 里一处、`explain.cover` 里一处。
  const count = (ENGINE.match(/cover: Math\.round\(coverOf\[di\] \* 1e3\) \/ 1e3,/g) || []).length;
  const iLean = ENGINE.indexOf('if (leanHit) {');
  const iLeanEnd = iLean > 0 ? ENGINE.indexOf('});', iLean) : -1;
  const leanBlock = iLean > 0 && iLeanEnd > iLean ? ENGINE.slice(iLean, iLeanEnd) : '';
  const shape = count === 3 && leanBlock.length > 0 && leanBlock.includes('cover:') === false &&
    ENGINE.includes('const matHitOf = (h, di) => {');
  const r = search('alpha beta', plain, { k: 5, now: NOW });
  const allCover = r.length > 0 && r.every((h) => typeof h.cover === 'number' && Number.isFinite(h.cover));
  const kb = search('alpha beta', plain, { k: 5, keepBand: true, now: NOW });
  const kbCover = kb.length > 0 && kb.every((h) => typeof h.cover === 'number');
  const ex = search('alpha beta', plain, { k: 5, explain: true, now: NOW });
  const exSame = ex.length > 0 && ex.every((h, i) => h.explain !== void 0 && Object.is(h.explain.cover, r[i]?.cover));
  ok(
    'H12 瘦对象上不算 cover（全引擎只剩完整字面量与 matHitOf 两处），三条路的 cover 仍逐位相同',
    shape && allCover && kbCover && exSame,
    `字面量处数=${count} 默认带 cover=${allCover} keepBand 带 cover=${kbCover} explain 同值=${exSame}`,
  );
}

// ── H13 ──────────────────────────────────────────────────────────────────
// [macro-fusion 0.6.29] 三处「每条候选重读一遍 opts」的判定与两个循环不变量提到循环外。
// 提到外面最怕写死成 true，所以逐个开关再关一次，证明它们仍然生效。
{
  const shape = ENGINE.includes('const subjZero = subjRatio === void 0 || opts.identSubjBand === false || !identHardOk;') &&
    ENGINE.includes('const bandWOn = opts.identBand !== false && identHardOk;') &&
    ENGINE.includes('const subjBandOn = opts.identSubjBand !== false && identHardOk;') &&
    ENGINE.includes('const lvOn = opts.levelIntent !== false;') &&
    ENGINE.includes('const onBody = opts.lengthOnBody === false;') &&
    ENGINE.includes('const lenDl = onBody ? avgdl : avgBody;') &&
    ENGINE.includes('const k1p1 = k1 + 1;') &&
    ENGINE.includes('const satDen = k1 * (1 - bEff + bEff * len / lenDl);') &&
    (ENGINE.match(/opts\.identBand === false \|\| !identHardOk/g) || []).length === 0;
  // 三个开关各关一次：`identBand` 只影响 `_raw`（原样补分那条走的是 `identHardOk`），
  // `identSubjBand` 影响 `_subj`，`levelIntent` 影响 rules 条的分数；`lengthOnBody` 选长度与均值。
  const idDocs = [mk('0mwq5zzv', 'fact', '0mwq5zzv alpha'), mk('0mzzzzzz', 'fact', 'alpha beta')];
  const kbOn = search('0mwq5zzv alpha', idDocs, { k: 5, keepBand: true, now: NOW });
  const kbOff = search('0mwq5zzv alpha', idDocs, { k: 5, keepBand: true, identBand: false, now: NOW });
  const namedOn = kbOn.find((h) => h.id === '0mwq5zzv');
  const namedOff = kbOff.find((h) => h.id === '0mwq5zzv');
  const bandWorks = namedOn !== void 0 && namedOff !== void 0 && Number(namedOn._raw) > Number(namedOff._raw);
  const kbSubj = search('0mwq5zzv alpha', idDocs, { k: 5, keepBand: true, identSubjBand: false, now: NOW });
  const subjWorks = namedOn !== void 0 && Number(namedOn._subj) === 1 &&
    Number(kbSubj.find((h) => h.id === '0mwq5zzv')?._subj) === 0;
  const lvHi = search('该不该 alpha', plain, { k: 5, explain: true, now: NOW }).find((h) => h.level === 'rules');
  const lvLo = search('该不该 alpha', plain, { k: 5, explain: true, levelIntent: false, now: NOW }).find((h) => h.level === 'rules');
  const lvWorks = lvHi !== void 0 && lvLo !== void 0 && lvHi.score > lvLo.score;
  const bodyHi = search('alpha beta', plain, { k: 5, now: NOW });
  const bodyLo = search('alpha beta', plain, { k: 5, lengthOnBody: false, now: NOW });
  const bodyWorks = bodyHi.length === bodyLo.length && bodyHi.some((h, i) => h.score !== bodyLo[i]?.score);
  ok(
    'H13 循环不变量提出循环外：形状在位，identBand / identSubjBand / levelIntent / lengthOnBody 四个开关仍各自生效',
    shape && bandWorks && subjWorks && lvWorks && bodyWorks,
    `形状=${shape} 点名 _raw 仍抬=${bandWorks} 主语开关仍到 _subj=${subjWorks} 层级意图仍抬=${lvWorks} 长度口径仍选=${bodyWorks}`,
  );
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  probe-hotpath：${pass}/${pass + fail}`);
process.exitCode = fail === 0 ? 0 : 1;
