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
    // [macro-fusion 0.6.34] 六处 → 七处：候选表也改从 `hotScratchOf` 领（`candAt` 那处之外又多了
    // `candBuf` 的 `scratch === null ? new Int32Array(docs.length) : scratch.cand`），`hotScratchDone`
    // 仍是两处（正常返回 + 异常兜底）。
    (ENGINE.match(/scratch === null \?/g) || []).length === 7;
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
  // [macro-decl 0.6.39] 表还在，只是外面多乘了一个「这个词在库里有声明对端就打 0.7」的系数
  // （`qLoopDeclW`，按问句词给）。没有声明对端时它整条是 null，查表那一格逐位不变——
  // 所以形状判据收成「表 + 乘系数」，再把「系数缺省时就是表值」单独断言。
  const TABLE = 'const FIELD_W_TAB = [1, 1 + FIELD_TITLE_W, 1 + FIELD_KW_W, 1 + FIELD_TITLE_W + FIELD_KW_W];';
  const TAB_ONLY = 'const fw = FIELD_W_TAB[fl & 3];';
  const TAB_DECL = 'const fw = qLoopDeclW === null ? FIELD_W_TAB[fl & 3] : FIELD_W_TAB[fl & 3] * qLoopDeclW[qi];';
  const shape = ENGINE.includes(TABLE) &&
    (ENGINE.includes(TAB_DECL) || ENGINE.includes(TAB_ONLY)) &&
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
  // [macro-decl 0.6.39] 那条系数只在「问句里真有词带声明对端」时才不为 null：
  // 普通问句上它整条是 null，走查表那一格，读数必须与不打折时逐位相同。
  const gate = ENGINE.includes('if (declDirectW < 1 && lookupSyn !== null) {');
  const a = JSON.stringify(search('alpha beta', plain, { k: 5, now: NOW }));
  const b = JSON.stringify(search('alpha beta', plain, { k: 5, now: NOW, declDirectW: 1 }));
  ok(
    'H11b 声明折扣的系数是「有才对」：普通问句整条 null，读数与不打折逐位相同',
    gate && a === b,
    `闸门=${gate} 逐位相同=${a === b}`,
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

// ── H14 ──────────────────────────────────────────────────────────────────
// [macro-fusion 0.6.30] 定档的定位从「每条从头二分」改成「先按比例猜一个下标，再在猜出来的那一半里二分」。
// 这条探针把 `anchorChainOf` / `setBandsByThreshold` 连同它们的桶表从引擎原文抠出来跑（探针不另写
// 一份逻辑），再拿「每条都从头二分」的参考实现逐条对档号：必须逐位同档，且与分布无关。
{
  const iA = ENGINE.indexOf('const RAWK_SHIFT = 16;');
  const iC = ENGINE.indexOf('function setBandsBySort(hits, rawKey) {');
  const src = iA >= 0 && iC > iA ? ENGINE.slice(iA, iC) : '';
  let sand = null;
  try {
    sand = src === ''
      ? null
      : new Function(`var IMP_BAND = 0.85;\n${src}\nreturn { setBandsByThreshold, anchorChainOf };`)();
  } catch {
    sand = null;
  }
  const lcg = (seed0) => {
    let s = seed0;
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
  };
  const r1 = lcg(7);
  const r2 = lcg(11);
  const r3 = lcg(13);
  const r4 = lcg(17);
  const r5 = lcg(19);
  const r6 = lcg(23);
  const cases = [
    { name: '均匀', vals: Array.from({ length: 300 }, () => r1()) },
    { name: '同分', vals: Array.from({ length: 300 }, () => Math.round(r2() * 20) / 20) },
    { name: '偏斜', vals: Array.from({ length: 300 }, () => Math.exp(-r3() * 8) * 1000) },
    { name: '两值', vals: Array.from({ length: 300 }, () => (r4() < 0.5 ? 1 : 2)) },
    { name: '全等', vals: new Array(300).fill(5) },
    { name: '巨跨', vals: Array.from({ length: 300 }, () => r5() * 1e12) },
    { name: '微跨', vals: Array.from({ length: 300 }, (_, i) => 1e15 + i) },
    { name: '含零', vals: Array.from({ length: 300 }, () => (r6() < 0.3 ? 0 : r6())) },
  ];
  const refBand = (anchors, m, v) => {
    let lo = 0;
    let hi = m;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid] >= v) hi = mid;
      else lo = mid + 1;
    }
    return m - 1 - lo;
  };
  let ran = 0;
  let rows = 0;
  let bad = 0;
  if (sand !== null) {
    for (const c of cases) {
      const hits = c.vals.map((v) => ({ _raw: v }));
      hits.push({ _raw: 3, _ident: true }, { _raw: 4, _subj: 1 });
      const okRet = sand.setBandsByThreshold(hits, '_raw') === true;
      const anchors = sand.anchorChainOf(Float64Array.from(c.vals), c.vals.length);
      const m = anchors.length;
      ran += 1;
      if (!okRet) bad += 1;
      for (let i = 0; i < c.vals.length; i++) {
        rows += 1;
        if (!Object.is(hits[i]._bandTmp, refBand(anchors, m, c.vals[i]))) bad += 1;
      }
      // 指认项 / 主语项固定 -1（与 raw 大小无关）
      if (hits[c.vals.length]._bandTmp !== -1 || hits[c.vals.length + 1]._bandTmp !== -1) bad += 1;
    }
    // 复用缓冲：换一份更短的数组再跑，不许残留上一趟的值
    const two = [{ _raw: 0.5 }, { _raw: 2.5 }];
    const ok2 = sand.setBandsByThreshold(two, '_raw') === true;
    const an2 = sand.anchorChainOf(Float64Array.from([0.5, 2.5]), 2);
    if (!ok2 || !Object.is(two[0]._bandTmp, refBand(an2, an2.length, 0.5)) ||
      !Object.is(two[1]._bandTmp, refBand(an2, an2.length, 2.5))) bad += 1;
  }
  ok(
    'H14 定档定位：猜位 + 半区间二分与「每条从头二分」逐位同档（均匀 / 同分 / 偏斜 / 两值 / 全等 / 巨跨 / 微跨 / 含零）',
    sand !== null && ran === 8 && bad === 0,
    `从引擎抠函数=${sand !== null} · 分布 ${ran}/8 · 对档 ${rows} 条 · 不符 ${bad}`,
  );
}

// ── H15 ──────────────────────────────────────────────────────────────────
// [macro-fusion 0.6.30] `impOf(dOf)` 这个小闭包摊平进扫描循环（`impRaw` + 内联 clamp）。
// `now: null` 关掉时间衰减，分数就只剩「词分 × impW」这一个随重要性变化的因子：
// 逐档对 `1 + (min(4, max(1, round(Number(imp)))) - 1) * 0.25` 的比值，逐位相同才算过。
{
  const shape = ENGINE.includes('const impRaw = Math.round(Number(dOf.importance));') &&
    ENGINE.includes('const impW = 1 + ((Number.isFinite(impRaw) ? (impRaw < 1 ? 1 : impRaw > 4 ? 4 : impRaw) : 1) - 1) * 0.25;') &&
    ENGINE.includes('const impOf = (d) => {') === false;
  const impOld = (v) => {
    const r = Math.round(Number(v));
    const c = Number.isFinite(r) ? Math.min(4, Math.max(1, r)) : 1;
    return 1 + (c - 1) * 0.25;
  };
  const imps = [1, 2, 3, 4, 9, 0, 0.4, 2.6, NaN, '2', null, void 0, -3];
  const docs = imps.map((v, i) => ({
    id: '0mz' + String(i).padStart(5, '0'),
    level: 'fact',
    title: 't',
    content: 'alpha beta gamma',
    importance: v,
    updated_at: '2026-01-01T00:00:00Z',
    keywords: ['alpha'],
    project: 'p',
  }));
  const r = search('alpha beta gamma', docs, { k: 20, now: null });
  const base = r.find((h) => h.id === '0mz00000'); // importance 1 → impW 1
  let checked = 0;
  let bad = 0;
  if (base !== void 0 && base.score > 0) {
    for (let i = 0; i < imps.length; i++) {
      const h = r.find((x) => x.id === '0mz' + String(i).padStart(5, '0'));
      if (h === void 0) continue;
      checked += 1;
      if (!Object.is(Math.round((h.score / base.score) * 1e9) / 1e9, Math.round(impOld(imps[i]) * 1e9) / 1e9)) bad += 1;
    }
  }
  ok(
    'H15 重要性权重：摊平后的 impW 与老闭包逐档同值（含越界 / 小数 / NaN / 字符串 / null / 负数），闭包已退休',
    shape && checked === imps.length && bad === 0,
    `形状=${shape} · 逐档 ${checked}/${imps.length} · 不符 ${bad}`,
  );
}

// ── H16 ──────────────────────────────────────────────────────────────────
// [macro-fusion 0.6.30] `verbatimInputs` 里两张同值铺表（`docs.map(() => null)` / `(() => 0)`）换成
// `new Array(n).fill(...)`；`lvTmp` 复用循环外的 `lvOn`。这两处都不能改值，所以除了形状，还钉一枚
// 回执指纹：固定语料 + 固定问句的 `id@score` 与 0.6.29 引擎逐位相同（发版前两条引擎跑过对照）。
{
  // 形状只看 `verbatimInputs` 的**代码行**（注释里提到老写法是正常的，不能拿全局 includes 判）
  const iV = ENGINE.indexOf('function verbatimInputs(query, docs, opts, textOf');
  const iVEnd = iV > 0 ? ENGINE.indexOf('\nfunction ', iV + 10) : -1;
  const vbCode = iV > 0 && iVEnd > iV
    ? ENGINE.slice(iV, iVEnd).split('\n').filter((ln) => !ln.trim().startsWith('//')).join('\n')
    : '';
  const shape = vbCode.includes('rawVerbatim: new Array(docs.length).fill(null),') &&
    vbCode.includes('subjRatio: new Array(docs.length).fill(0)') &&
    vbCode.includes('docs.map(') === false &&
    ENGINE.includes('lvTmp.push(lvHit && lvOn ? 1 : 0);') &&
    ENGINE.includes('lvTmp.push(lvHit && opts.levelIntent !== false ? 1 : 0);') === false;
  const lcg = (seed0) => {
    let s = seed0;
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
  };
  const r = lcg(97);
  const w = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', '一律', '必须', '先', '记忆', '星图'];
  const corpus = Array.from({ length: 120 }, (_, i) => {
    const n = 3 + ((r() * 5) | 0);
    const words = Array.from({ length: n }, () => w[(r() * w.length) | 0]);
    return {
      id: '0mg' + String(i).padStart(6, '0'),
      level: ['fact', 'lesson', 'rules', 'topic'][(r() * 4) | 0],
      title: words[0],
      content: words.join(' '),
      importance: 1 + ((r() * 4) | 0),
      updated_at: '2026-01-01T00:00:00Z',
      keywords: r() < 0.2 ? null : [w[(r() * w.length) | 0]],
      project: 'p',
    };
  });
  const qs = ['alpha beta', '必须 先 记忆', '星图 一律', 'gamma delta epsilon', '规则 是什么',
    '为什么 要 先', 'alpha gamma 记忆', '0mg000012 alpha'];
  const runs = qs.map((q) => search(q, corpus, { k: 8, now: NOW }));
  const digestOf = (rs) => rs.map((x) => x.map((h) => `${h.id}@${h.score.toFixed(12)}`).join(',')).join('|');
  const d = digestOf(runs);
  const GOLDEN = '0mg000005@3.664628057107,0mg000038@5.102523846806,0mg000061@4.788643770374,0mg000006@3.925122785034,0mg000074@2.232920822271|0mg000023@6.732283929790,0mg000108@5.065968177695,0mg000076@4.106832745439,0mg000104@4.756171212734,0mg000117@4.580868819911|0mg000100@5.906625216656,0mg000067@3.975949441312,0mg000115@3.760224920935,0mg000015@3.579293550671,0mg000047@3.464398706423|0mg000101@5.989226322228,0mg000037@4.382801980391,0mg000105@6.132937947203,0mg000016@5.714996394708,0mg000089@5.278362858510|||0mg000023@7.099164514106,0mg000108@5.912829410853,0mg000005@4.615892988676,0mg000084@3.935034576993,0mg000058@6.160437605175|0mg000012@3.148175340076,0mg000083@1.863256160943,0mg000005@1.755985977713,0mg000109@2.098783560051,0mg000073@1.049391780025';
  ok(
    'H16 同值铺表走原生 fill、层级意图复用循环外判据：回执指纹与 0.6.29 引擎逐位相同',
    shape && d === GOLDEN,
    `形状=${shape} · 指纹 ${d === GOLDEN ? '同' : '不同'}`,
  );
  if (d !== GOLDEN) console.log('DIGEST ' + d);
}

// ── H17 ──────────────────────────────────────────────────────────────────
// [macro-fusion 0.6.31] 定档前的两趟合成一趟 + 桶表只清上一趟碰过的段 + 时间衰减阈值提出循环外。
// 这条只管形状：老写法必须真的不在、新写法必须真的在。语义等价由 H18（定档链逐位）与 H19（回执指纹）管。
{
  // 切函数体 + 剔掉整行注释再判：引擎注释里为说明「老写法是什么」会把老写法原样写进注释，
  // 直接用 includes 去全文件找会自己撞自己（0.6.30 的 H16 就踩过）。
  const codeOf = (name) => {
    const at = ENGINE.indexOf(`function ${name}(`);
    if (at < 0) return '';
    const next = ENGINE.indexOf('\nfunction ', at + 1);
    const body = next < 0 ? ENGINE.slice(at) : ENGINE.slice(at, next);
    return body.split('\n').filter((ln) => !ln.trimStart().startsWith('//')).join('\n');
  };
  const band = codeOf('setBandsByThreshold');
  const chain = codeOf('anchorChainOf');
  const firstPass =
    band.includes('if (rawkVals.length < total) rawkVals = new Float64Array(total);') &&
    band.includes('vals[plain++] = r;') &&
    !band.includes('idx[plain] = i;') &&
    band.includes('if (typeof r !== "number" || !Number.isFinite(r) || r < 0) return false;') &&
    !band.includes('if (rawkVals.length < plain)') &&
    !band.includes('vals[j++] = h[rawKey];');
  const histPass =
    chain.includes('rawkHist.fill(0, 0, rawkTopPrev + 1);') &&
    chain.includes('for (let b = 0; b <= top; b++)') &&
    chain.includes('rawkTopPrev = top;') &&
    !chain.includes('rawkHist.fill(0);') &&
    !chain.includes('for (let b = 0; b < RAWK_NB; b++)');
  const emitPass =
    ENGINE.includes('const impBandMax = IMP_BAND * maxRaw;') &&
    !ENGINE.includes('!(raw[di] >= IMP_BAND * maxRaw)') &&
    ENGINE.includes('!(raw[di] >= impBandMax)');
  ok(
    'H17 定档合成一趟 / 桶表单段清理 / 衰减阈值提循环外：形状在位，老写法不在',
    firstPass && histPass && emitPass,
    `合成一趟=${firstPass} 单段清理=${histPass} 阈值提出=${emitPass}`,
  );
}

// ── H18 ──────────────────────────────────────────────────────────────────
// [macro-fusion 0.6.31] 桶表（65,536 格）不再每问整表 `fill(0)`、前缀和也不再走满 65,536 格，
// 改成「上一趟碰过 0..top 这一段清掉、前缀和只走到这一趟的 top」。这条探针把 `anchorChainOf`
// 连同桶表一起从引擎原文抠出来，故意让相邻两趟的 top 一高一低（先巨跨后紧凑、先紧凑后巨跨），
// 每一趟都跟「纯排序 + 阈值链」的参考实现逐位比：桶表漏清必定在这里露馅。
{
  const iA = ENGINE.indexOf('const RAWK_SHIFT = 16;');
  const iC = ENGINE.indexOf('function setBandsBySort(hits, rawKey) {');
  const src = iA >= 0 && iC > iA ? ENGINE.slice(iA, iC) : '';
  let sand = null;
  try {
    sand = src === ''
      ? null
      : new Function(`var IMP_BAND = 0.85;\n${src}\nreturn { anchorChainOf, anchorChainSorted };`)();
  } catch {
    sand = null;
  }
  const lcg = (seed0) => {
    let s = seed0;
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
  };
  const refOf = (vals, n) => {
    const c = Float64Array.from(vals.subarray(0, n));
    c.sort();
    return sand.anchorChainSorted(c, n);
  };
  const shapes = [
    (r, i) => r(),                       // 均匀 0..1
    (r, i) => r() * 1e12,                // 巨跨（桶号拉满）
    (r, i) => Math.round(r() * 4) / 4,   // 同分很多
    (r, i) => 1e15 + i,                  // 微跨
    (r, i) => (i % 3 === 0 ? 0 : r()),   // 含零
    (r, i) => Math.exp(-r() * 6),        // 偏斜
  ];
  const sizes = [0, 1, 2, 5, 37, 200, 1500, 4000];
  const r = lcg(2031);
  let checks = 0;
  let bad = 0;
  const firstBad = [];
  // 顺序刻意「高 top 与低 top 交替」：桶表只在下一趟开头清上一趟那段，
  // 只要清少了或者前缀和走短了，紧接着那一趟就会读到上一趟的残值。
  for (let s = 0; s < shapes.length; s++) {
    for (let t = 0; t < sizes.length; t++) {
      const n = sizes[t];
      const arr = new Float64Array(Math.max(n, 1));
      for (let i = 0; i < n; i++) arr[i] = shapes[s](r, i);
      if (n === 0) continue;
      const got = sand.anchorChainOf(arr, n);
      const exp = refOf(arr, n);
      checks += 1;
      const same = JSON.stringify(got) === JSON.stringify(exp);
      if (!same) {
        bad += 1;
        if (firstBad.length < 3) firstBad.push(`shape${s}/n${n}: ${JSON.stringify(got)} != ${JSON.stringify(exp)}`);
      }
      // 同一向量连跑两次：第二条必须还是同一个答案（读的是自己的残值就会被抓出来）
      const twice = sand.anchorChainOf(arr, n);
      checks += 1;
      if (JSON.stringify(twice) !== JSON.stringify(exp)) {
        bad += 1;
        if (firstBad.length < 3) firstBad.push(`shape${s}/n${n} 第二趟: ${JSON.stringify(twice)}`);
      }
    }
  }
  ok(
    'H18 桶表只清上一趟那段、前缀和只走到 top：六种分布 × 八种长度逐位与「排序 + 阈值链」相同',
    sand !== null && checks > 0 && bad === 0,
    sand === null ? '抠不出 anchorChainOf' : `${checks} 项 · 不符 ${bad}${firstBad.length ? ' · ' + firstBad.join(' ; ') : ''}`,
  );
}

// ── H19 ──────────────────────────────────────────────────────────────────
// [macro-fusion 0.6.31] 三笔改动都是「换写法不换算术」，所以整条回执必须与 0.6.30 逐位相同——
// 而 0.6.30 的指纹已经钉在 H16 的 GOLDEN 里（那份又与 0.6.29 对过）。这里复用同一串：
// 两个版本之间只要有一位分数动了，这条就红。
{
  const lcg = (seed0) => {
    let s = seed0;
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
  };
  const r = lcg(97);
  const w = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', '一律', '必须', '先', '记忆', '星图'];
  const corpus = Array.from({ length: 120 }, (_, i) => {
    const n = 3 + ((r() * 5) | 0);
    const words = Array.from({ length: n }, () => w[(r() * w.length) | 0]);
    return {
      id: '0mg' + String(i).padStart(6, '0'),
      level: ['fact', 'lesson', 'rules', 'topic'][(r() * 4) | 0],
      title: words[0],
      content: words.join(' '),
      importance: 1 + ((r() * 4) | 0),
      updated_at: '2026-01-01T00:00:00Z',
      keywords: r() < 0.2 ? null : [w[(r() * w.length) | 0]],
      project: 'p',
    };
  });
  const qs = ['alpha beta', '必须 先 记忆', '星图 一律', 'gamma delta epsilon', '规则 是什么',
    '为什么 要 先', 'alpha gamma 记忆', '0mg000012 alpha'];
  const runs = qs.map((q) => search(q, corpus, { k: 8, now: NOW }));
  const digestOf = (rs) => rs.map((x) => x.map((h) => `${h.id}@${h.score.toFixed(12)}`).join(',')).join('|');
  const d = digestOf(runs);
  const GOLDEN31 = '0mg000005@3.664628057107,0mg000038@5.102523846806,0mg000061@4.788643770374,0mg000006@3.925122785034,0mg000074@2.232920822271|0mg000023@6.732283929790,0mg000108@5.065968177695,0mg000076@4.106832745439,0mg000104@4.756171212734,0mg000117@4.580868819911|0mg000100@5.906625216656,0mg000067@3.975949441312,0mg000115@3.760224920935,0mg000015@3.579293550671,0mg000047@3.464398706423|0mg000101@5.989226322228,0mg000037@4.382801980391,0mg000105@6.132937947203,0mg000016@5.714996394708,0mg000089@5.278362858510|||0mg000023@7.099164514106,0mg000108@5.912829410853,0mg000005@4.615892988676,0mg000084@3.935034576993,0mg000058@6.160437605175|0mg000012@3.148175340076,0mg000083@1.863256160943,0mg000005@1.755985977713,0mg000109@2.098783560051,0mg000073@1.049391780025';
  ok(
    'H19 三笔改动不换算术：回执指纹与 0.6.29 / 0.6.30 逐位相同',
    d === GOLDEN31,
    `指纹 ${d === GOLDEN31 ? '同' : '不同'}`,
  );
  if (d !== GOLDEN31) console.log('DIGEST31 ' + d);
}

// ── H20 ──────────────────────────────────────────────────────────────────
// [macro-fusion 0.6.32] 扫描期不再给每条候选建回执对象：算完分数就写进平行缓冲，定档 / 补分 /
// 选前 k / 物化四步全在缓冲上做，只有入选的 k 条变成对象。这条只管形状：快路必须真的在，
// 老后处理必须**原样**留在 `if (!fastDone) { … }` 里（一个字都不能改，否则老路口径就变了）。
{
  const codeOf = (name) => {
    const at = ENGINE.indexOf(`function ${name}(`);
    if (at < 0) return '';
    const next = ENGINE.indexOf('\nfunction ', at + 1);
    const body = next < 0 ? ENGINE.slice(at) : ENGINE.slice(at, next);
    return body.split('\n').filter((ln) => !ln.trimStart().startsWith('//')).join('\n');
  };
  const searchBody = codeOf('search');
  const bufBody = codeOf('hitBufOf');
  const atGuard = searchBody.indexOf('if (!fastDone) {');
  const atBandize = searchBody.indexOf("bandize(hits, '_raw', k);");
  const fastShape =
    searchBody.includes('const hitBuf = leanHit ? hitBufOf(docs.length) : null;') &&
    searchBody.includes('const fastOk = hitBuf !== null;') &&
    searchBody.includes('let fastDone = false;') &&
    searchBody.includes('if (fastOk) {') &&
    searchBody.includes('hdi[q] = di;') &&
    searchBody.includes('hscore[q] = raw[di] * w * impW * stW * foldOf;') &&
    searchBody.includes('continue;') &&
    // 老路的三只临时数组与两段对象字面量都还在（快路是**加法**，不是替换）
    searchBody.includes('vbTmp.push(vbOf);') &&
    searchBody.includes('srTmp.push(srOf);') &&
    searchBody.includes('lvTmp.push(lvHit && lvOn ? 1 : 0);') &&
    searchBody.includes('trTmp.push(trOf);') &&
    searchBody.includes('if (leanHit) {') &&
    searchBody.includes('} else hits.push({');
  // 老后处理整段（补分 → bandize）必须落在守卫里面：`bandize` 夹在守卫开头与 `trimByBand` 之间
  const atTrim = searchBody.indexOf('const outHits = trimByBand(hits, k, opts);');
  const guarded =
    atGuard >= 0 && atBandize > atGuard && atTrim > atBandize &&
    searchBody.slice(atGuard, atTrim).includes("bandize(hits, '_raw', k);");
  const guardShape =
    (searchBody.match(/hitBufDone\(\);/g) || []).length === 2 &&
    searchBody.includes('const haveBands = cnt >= 2;') &&
    searchBody.includes('want > 0 && cmpQ(q, heap[0]) < 0');
  const bufShape =
    bufBody.includes('const cap = n + 64;') &&
    bufBody.includes('if (s.n !== cap)') &&
    bufBody.includes('if (s.busy) return null;') &&
    bufBody.includes('new Int32Array(cap)') &&
    bufBody.includes('new Float64Array(cap)') &&
    bufBody.includes('new Uint8Array(cap)') &&
    codeOf('hitBufDone').includes('HIT_BUF.busy = false;');
  ok(
    'H20 扫描期只写缓冲、老后处理原样留在守卫里：形状在位',
    fastShape && guarded && guardShape && bufShape,
    `快路=${fastShape} 守卫=${guarded && guardShape} 缓冲=${bufShape}`,
  );
}

// ── H21 ──────────────────────────────────────────────────────────────────
// [macro-fusion 0.6.32] 快路自己走的定档 / 选前 k，边界值必须与老路同一口径：
//   · `k` 缺省（`undefined`）、`k = 0`、`k` 为负数在两边都走「want = 全量」那条支，回执必须同条数；
//   · `k` 取 0.4（`Math.round` 成 0）是唯一的例外：老路由在 `bandize` 的空堆上读 `heap[0]` 抛
//     TypeError，快路带了 `want > 0` 守卫、返回空数组。这条把「不抛且空」钉住（老行为是崩，不是答案）；
//   · 命中 0 条 / 恰好 1 条（`cnt < 2` 时一条档都不许写）都不许抛。
{
  const corpus = [
    { id: 'sa1', project: 'p', level: 'fact', title: '潮汐 表', content: '潮汐 表 读数 一。', keywords: ['潮汐'], importance: 2, updated_at: NOW - 1000, last_accessed_at: NOW - 1000 },
    { id: 'sa2', project: 'p', level: 'fact', title: '鲸歌', content: '鲸歌 频率 二。', keywords: ['鲸歌'], importance: 3, updated_at: NOW - 2000, last_accessed_at: NOW - 2000 },
    { id: 'sa3', project: 'p', level: 'fact', title: '潮汐 表 读数', content: '潮汐 表 读数 三。', keywords: ['潮汐', '表'], importance: 1, updated_at: NOW - 3000, last_accessed_at: NOW - 3000 },
  ];
  const run = (q, opts) => {
    try {
      return { n: search(q, corpus, { ...opts, now: NOW }).length, err: null };
    } catch (e) {
      return { n: -1, err: e.message };
    }
  };
  const wide = run('潮汐 表 读数', {});
  const huge = run('潮汐 表 读数', { k: 1e9 });
  const zero = run('潮汐 表 读数', { k: 0 });
  const neg = run('潮汐 表 读数', { k: -3 });
  const frac = run('潮汐 表 读数', { k: 0.4 });
  const one = run('鲸歌 频率', { k: 5 });
  const none = run('完全不存在的丙词', { k: 5 });
  const okEdge =
    wide.err === null && huge.err === null && zero.err === null && neg.err === null && frac.err === null &&
    one.err === null && none.err === null &&
    wide.n === huge.n && wide.n > 0 &&
    zero.n === wide.n && neg.n === wide.n && frac.n === 0 &&
    one.n === 1 && none.n === 0;
  ok(
    'H21 快路的 k 边界与命中 0/1 条：不抛、k=0/负与缺省同条数、k=0.4 空数组',
    okEdge,
    `缺省=${wide.n} 超大=${huge.n} k0=${zero.n} k负=${neg.n} k0.4=${frac.n} 单命中=${one.n} 空=${none.n}${frac.err ? ' · 0.4 抛 ' + frac.err : ''}`,
  );
}

// ── H22 ──────────────────────────────────────────────────────────────────
// [macro-fusion 0.6.32] 缓冲是**复用**的：同一个进程里上一问留下的档号 / 分数如果没被覆盖干净，
// 下一问就会读到别人的残值。这里让三问交替（宽命中 → 窄命中 → 目标问）反复跑，
// 目标问无论在什么前序之后、在冷启动的语料副本上、还是连跑两遍，回执都必须逐位相同。
{
  const mkDocs = () => Array.from({ length: 60 }, (_, i) => ({
    id: '0mr' + String(i).padStart(6, '0'),
    level: i % 5 === 0 ? 'rules' : 'fact',
    title: ['alpha', 'beta', 'gamma'][i % 3],
    content: ['alpha beta', 'alpha delta 记忆', 'beta gamma 星图', 'delta 一律 必须'][i % 4] + ` 第 ${i} 条。`,
    importance: 1 + (i % 4),
    updated_at: NOW - i * 1000,
    last_accessed_at: NOW - i * 700,
    keywords: [['alpha'], ['beta'], ['gamma'], null][i % 4],
    project: 'p',
  }));
  const dig = (rs) => rs.map((h) => `${h.id}@${h.score.toFixed(12)}#${h.cover ?? ''}`).join(',');
  const A = 'delta 一律 必须 星图';
  const B = 'alpha beta gamma';
  const C = 'zeta 不存在的词';
  const d1 = mkDocs();
  const d2 = mkDocs();
  search(B, d1, { k: 5, now: NOW });
  const afterB = dig(search(A, d1, { k: 5, now: NOW }));
  search(C, d1, { k: 5, now: NOW });
  const afterC = dig(search(A, d1, { k: 5, now: NOW }));
  const twice = dig(search(A, d1, { k: 5, now: NOW }));
  const cold = dig(search(A, d2, { k: 5, now: NOW }));
  ok(
    'H22 缓冲复用不串味：同一目标问在不同前序 / 连跑 / 冷语料上逐位相同',
    afterB !== '' && afterB === afterC && afterB === twice && afterB === cold,
    `前序B=${afterB === afterC ? '同' : '不同'} 连跑=${afterB === twice ? '同' : '不同'} 冷语料=${afterB === cold ? '同' : '不同'}`,
  );
}

// ── H23 ──────────────────────────────────────────────────────────────────
// [macro-fusion 0.6.33] 定档猜位从「数值线性刻度」换成「位级对数刻度」。
//
// 症状：锚链是 `v < IMP_BAND * anchor`（0.85）压出来的**几何级数**，相邻锚点比值恒 ≥ 1.176，
// 而 0.6.32 的猜位是 `(v - a0v) / (aLv - a0v) * (m - 1)`——按数值线性插值，在几何链上必然猜偏。
// 实测（`E:\Temp\cmp\bguess33.mjs` + 插桩引擎，3000 问 / 10,000 条）：**猜位直接命中只有 0.5%、
// 每条约 3.63 趟二分**，两条「猜位命中即收口」的新分支纯属加价（A/B 无收益）。
//
// 处方：`rawkBucketOf` 是数值的高 16 位（符号 1 + 阶码 11 + 尾数 4），对非负数**单调**、分辨率
// 1/16 个八度（0.0625 < 0.32 个八度一个锚点）——正好是一把「以 2 为底的对数刻度尺」，且只花一个
// 位运算。猜位仍只是猜位：落点靠「前一位严格小 / 后一位不小于」两条收口校验，猜偏就退回窄窗二分，
// 所以档号**逐位等于** lowerBound（`probe-band` / `probe-order` 与四把尺子共同兜底）。
//
// 这里钉三件事：形状在位（老线性刻度已撤）／与老后处理逐位同档／档号仍单调同分同档。
{
  const want = [
    'const g0 = rawkBucketOf(a0v);',
    'const gL = rawkBucketOf(aLv);',
    'const posScale = gL > g0 ? (m - 1) / (gL - g0) : 0;',
    'let est = ((rawkBucketOf(v) - g0) * posScale) | 0;',
    'if (est === 0 || anchors[est - 1] < v) loI = est;',
    'if (anchors[loI] >= v) hiI = loI;',
  ];
  const missing = want.filter((s) => !ENGINE.includes(s));
  // 老线性刻度只剩冷路 `setBandsByThreshold` 那一份（它仍被 `bandize` 用着，不改）；
  // 热路这一段（从 `const g0 = …` 到选前 k 之前）里必须已经没有它。
  const hotStart = ENGINE.indexOf('const g0 = rawkBucketOf(a0v);');
  const hotEnd = ENGINE.indexOf('// ⑥ 选前 k：有界堆');
  const hotBlock = hotStart >= 0 && hotEnd > hotStart ? ENGINE.slice(hotStart, hotEnd) : '';
  const linearGone = hotBlock !== '' && !hotBlock.includes('let est = ((v - a0v) * posScale) | 0;');
  ok(
    'H23a 定档猜位改位级对数刻度：形状在位、热路的老线性刻度已撤',
    missing.length === 0 && linearGone,
    `缺=${missing.length} 热路段=${hotBlock.length}B 线性旧写法已撤=${linearGone}`,
  );
}
{
  // ② 语料：同分重复 / 跨量级 / 只有两条 / 大杂烩——全是「锚点正好落在某条分值上」的边界。
  const base = (i, content, importance, days) => ({
    id: '0mb' + String(i).padStart(6, '0'),
    level: i % 6 === 0 ? 'rules' : 'fact',
    title: ['alpha', 'beta', 'gamma'][i % 3],
    content,
    importance,
    updated_at: NOW - days * 86400000,
    last_accessed_at: NOW - days * 3600000,
    keywords: [['alpha'], ['beta'], ['gamma'], null][i % 4],
    project: 'p',
  });
  const corpora = {
    dup: Array.from({ length: 24 }, (_, i) => base(i, 'alpha beta gamma delta 星图', 2, 3)),
    scale: Array.from({ length: 40 }, (_, i) =>
      base(i, `${'alpha '.repeat(1 + (i % 4))}${'beta '.repeat(1 + (i % 3))}记忆 ${i}`,
        1 + (i % 4), i * (i % 5 === 0 ? 30 : 1))),
    tiny: [base(0, 'alpha beta 记忆', 1, 1), base(1, 'alpha gamma 星图', 4, 40)],
    mixed: Array.from({ length: 120 }, (_, i) =>
      base(i, `${['alpha', 'beta', 'gamma', 'delta', '一律'][i % 5]} ${['记忆', '星图', '索引'][i % 3]} 第 ${i} 条`,
        1 + ((i * 7) % 4), (i * 13) % 200)),
  };
  const Q = 'alpha beta gamma 记忆 星图';
  const bands = (rs) => rs.map((h) => `${h.id}@${h._band ?? 'x'}`).join(',');
  const detail = [];
  let sameAll = true;
  for (const [name, docs] of Object.entries(corpora)) {
    const lean = search(Q, docs, { k: docs.length, now: NOW });
    const told = search(Q, docs, { k: docs.length, now: NOW, explain: true });
    const same = bands(lean) === bands(told);
    if (!same) sameAll = false;
    detail.push(`${name}=${same ? '同' : '不同'}(${lean.length})`);
  }
  ok('H23b 对数刻度猜位不换算术：快路与老后处理逐位同档', sameAll, detail.join(' '));
}
{
  // ③ 档号的两条硬性质：随 raw 单调不增（v 大 ⇒ 档号小）／同分必同档
  const docs = Array.from({ length: 90 }, (_, i) => ({
    id: '0mc' + String(i).padStart(6, '0'),
    level: 'fact',
    title: 't',
    content: `${['alpha', 'beta', 'gamma'][i % 3]} ${['记忆', '星图'][i % 2]} 第 ${i % 17} 条`,
    importance: 1 + ((i * 5) % 4),
    updated_at: NOW - ((i * 37) % 300) * 86400000,
    keywords: ['alpha'],
    project: 'p',
  }));
  const rs = search('alpha beta gamma 记忆 星图', docs, { k: docs.length, now: NOW, explain: true });
  let mono = true;
  let sameScoreSameBand = true;
  for (let i = 0; i < rs.length; i++) {
    for (let j = 0; j < rs.length; j++) {
      const a = rs[i];
      const b = rs[j];
      if (a._raw > b._raw && !(a._band <= b._band)) mono = false;
      if (a._raw === b._raw && a._band !== b._band) sameScoreSameBand = false;
    }
  }
  ok(
    'H23c 档号仍单调、同分同档：raw 大则档号不增，等分必等档',
    rs.length >= 2 && mono && sameScoreSameBand,
    `条数=${rs.length} 单调=${mono} 同分同档=${sameScoreSameBand}`,
  );
}

// ── H24 ──────────────────────────────────────────────────────────────────
// [macro-fusion 0.6.34] 每问常数项与候选表的存储形态。
//
// 症状（`docs/INTERNAL.md` 9.233）：`search` 行级剖面里 `recencyWeight(...)` / `statusWeight(...)`
// 这两个一元小函数的耗时被记在**调用那一行**（114 / 50ms），看上去像「调用开销」；候选表是
// `const candArr = []` + `candArr.push(di)`，每问都要长一只 8,700 元素的普通数组（容量翻倍、
// 元素搬移），而 `scoreCandSet` 随后顺序读的其实只是「这一问命中了哪几条」。
//
// 处方：候选表换成与 `raw` / `kDen` 同寿命的定长 `Int32Array` + 游标 `candN`；时间梯子改踩
// **毫秒差**（`ageMs < 864e5 ? … : ageMs < 15552e6 ? 0.15 : 0.08`），省掉 `ageMs / 864e5` 这一次
// 除法；衰减守卫把只读数值数组的条件提前，越过 `impBandMax` 的那几条不必再去翻 doc 对象；
// `impW` / `stW` 就地摊平（顺带把 `recencyWeight` / `statusWeight` 从热路调用点摘掉）。
//
// 反证留档：光摊平这两个小函数只值 **−0.6%**（跨进程三轮中位 1.1647 → 1.1578）——V8 本来就会
// 内联它们，剖面把时间记在调用行不等于真有调用开销；加上定长候选表与守卫换序才到 **−7.4%**
// （同一把尺子三轮中位 1.1725 → 1.0856）。
//
// 这里钉三件事：形状在位（老 `[]`+push 与 `ageDays` 已撤）／递推梯子与老除法梯子逐位等价
// （±1ms 边界各探一遍）／定长缓冲跨查询复用不串味。
{
  const want = [
    'const candBuf = candAt === null ? null : scratch === null ? new Int32Array(docs.length) : scratch.cand;',
    's.cand = new Int32Array(n);',
    'if (candAt[di] === 0) { candAt[di] = 1; candBuf[candN++] = di; }',
    'const ageMs = now - (dOf.last_accessed_at ?? dOf.updated_at);',
    'ageMs < 15552e6 ? 0.15 : 0.08',
  ];
  const missing = want.filter((s) => !ENGINE.includes(s));
  const gone = ['candArr.push(', 'candArr.length = 0', 'const ageDays = (now -', 'recencyWeight(now,'];
  const alive = gone.filter((s) => ENGINE.includes(s));
  ok(
    'H24a 候选表改定长 Int32Array、时间梯子踩毫秒差：形状在位、老写法已撤',
    missing.length === 0 && alive.length === 0,
    `缺=${missing.length} 残留=${alive.length}${alive.length === 0 ? '' : `（${alive.join(' / ')}）`}`,
  );
}
{
  // ② 梯子等价：整数毫秒下 `ageMs < K * 864e5` 与 `ageMs / 864e5 < K` 逐位同分叉。
  // 探 10 个档位 × 边界前后各 1ms（含 0 天与越界端），任何一处阈值写错（比如 15552e5）都会红。
  const FLOOR = 0.08;
  const ladderOld = (ageMs) => {
    const d = ageMs / 864e5;
    return Math.max(
      FLOOR,
      d < 1 ? 1 : d < 2 ? 0.9 : d < 4 ? 0.8 : d < 7 ? 0.65 : d < 15 ? 0.5 : d < 30 ? 0.35 : d < 60 ? 0.25 : d < 180 ? 0.15 : 0.08,
    );
  };
  const ladderNew = (ageMs) =>
    Math.max(
      FLOOR,
      ageMs < 864e5 ? 1 : ageMs < 1728e5 ? 0.9 : ageMs < 3456e5 ? 0.8 : ageMs < 6048e5 ? 0.65 : ageMs < 1296e6 ? 0.5 : ageMs < 2592e6 ? 0.35 : ageMs < 5184e6 ? 0.25 : ageMs < 15552e6 ? 0.15 : 0.08,
    );
  let mismatch = 0;
  let probed = 0;
  for (const days of [0, 1, 2, 4, 7, 15, 30, 60, 180, 400]) {
    for (const off of [-1, 0, 1]) {
      const ageMs = days * 864e5 + off;
      probed += 1;
      if (ladderOld(ageMs) !== ladderNew(ageMs)) mismatch += 1;
    }
  }
  ok('H24b 毫秒梯子与老除法梯子逐位等价（10 档 × 边界 ±1ms）', mismatch === 0 && probed === 30, `探=${probed} 不符=${mismatch}`);
}
{
  // ③ 定长缓冲复用不串味：同一目标问在「前序其它问 / 连跑 / 冷语料」三种前序下结果逐位相同，
  //    且 k 边界（1 / 全部 / 0）不越界。
  const NOW2 = NOW;
  const docs = Array.from({ length: 240 }, (_, i) => ({
    id: '0md' + String(i).padStart(6, '0'),
    level: i % 5 === 0 ? 'rules' : 'fact',
    title: ['alpha', 'beta', 'gamma'][i % 3],
    content: `${'alpha '.repeat(1 + (i % 4))}${['beta', 'gamma', 'delta'][i % 3]} 记忆 第 ${i} 条`,
    importance: 1 + ((i * 3) % 4),
    updated_at: NOW2 - ((i * 53) % 400) * 864e5,
    last_accessed_at: NOW2 - ((i * 29) % 400) * 36e5,
    keywords: [['alpha'], ['beta'], null][i % 3],
    project: 'p',
  }));
  const fp = (rs) => rs.map((h) => `${h.id}@${h._band ?? 'x'}@${h.score.toFixed(9)}`).join(',');
  const target = 'alpha beta 记忆';
  const runA = fp(search(target, docs, { k: 5, now: NOW2 }));
  search('gamma delta 第 1 条', docs, { k: 8, now: NOW2 });
  const runB = fp(search(target, docs, { k: 5, now: NOW2 }));
  const again = fp(search(target, docs, { k: 5, now: NOW2 }));
  const cold = fp(search(target, docs.map((d) => ({ ...d })), { k: 5, now: NOW2 }));
  const one = search(target, docs, { k: 1, now: NOW2 });
  const two = search(target, docs, { k: 2, now: NOW2 });
  const all = search(target, docs, { k: docs.length, now: NOW2 });
  ok(
    'H24c 定长候选表复用不串味、k 边界不越界',
    runA !== '' && runA === runB && runA === again && runA === cold && one.length === 1 && two.length === 2 && all.length > 1 && all.length <= docs.length,
    `前序=${runA === runB ? '同' : '不同'} 连跑=${runA === again ? '同' : '不同'} 冷语料=${runA === cold ? '同' : '不同'} k1=${one.length} k2=${two.length} kAll=${all.length}`,
  );
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  probe-hotpath：${pass}/${pass + fail}`);
process.exitCode = fail === 0 ? 0 : 1;
