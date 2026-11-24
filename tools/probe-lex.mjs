// [macro-fusion 0.6.21] 判据：词法分类不许再「逐字符跑两条 Unicode 正则」。
//
// 背景（`docs/INTERNAL.md` 9.220）：0.6.20 之后 `classify` 是行视图第一名
// `vendor/meow-memory/lib/index.js:1631` 71.4ms + `:1632` 16.2ms = 88.7ms / 6.2%
// （10,000 条 / 300 问，1,433.5ms 总采样），而它每调一次要过 `CJK.test(cp)` 与
// `WORD.test(cp)` 两道 Unicode 属性正则——建库时一万条正文、每问若干次，全是同一批码点。
//
// 处方是 **BMP 表**：首次遇到非星外码点时用那两条正则自己扫一遍 0x0000–0xFFFF
// （把 65,536 个码点拼成一个大串、按连续段 `fill`），造一张 64KB 的 `Uint8Array`
// （0=skip / 1=cjk / 2=word），此后一次下标取数；星外码点与孤立代理项仍走原正则。
//
// 这一刀的风险不是慢，是**词**：分类错一个码点，切段就变、二元组就变、召回就变。
// 所以这个探针要证明六件事：
//
//   L0 形状：三档常量、惰性表、`buildClsBmp` 由 `CJK.source`/`WORD.source` 扫出来、
//      `clsCode` 有 `cp.length === 1` 快路与星外退路、tokenize 已改用数值比较、
//      `classify` 仍留成字符串包装（对外名不变）
//   L1 全码点：0x0000–0x10FFFF（跳过代理区）共 1,112,064 个码点，新旧分类逐点相同
//   L2 表本身：BMP 65,536 格与两条正则逐格一致；表长 65,536；建两次逐格相同（纯函数）
//   L3 切段：混排语料（全角、半角片假名、々/ー、emoji、星外字、孤立代理项、空串）逐串相同
//   L4 惰性：模块起来时表还没建；第一次分类才建；此后 identity 不变（不重建）
//   L5 退化：空串 / 纯标点 / 单字 / 星外字 / 孤立代理项 与参考实现同输出
import { readFileSync } from 'node:fs';

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

// ── 从引擎里把 0.6.21 那一段切出来当纯函数跑（不起索引、不碰存储）────────────────
const SEG_BEGIN = 'var CJK = ';
const SEG_END = 'function tokenize(text) {';
const segOf = (src) => {
  const a = src.indexOf(SEG_BEGIN);
  const b = src.indexOf(SEG_END);
  if (a < 0 || b <= a) return '';
  return src.slice(a, b);
};
const load = (src) => {
  const seg = segOf(src);
  if (seg === '') return null;
  return new Function(`${seg}\nreturn { classify, clsCode, buildClsBmp, CJK, WORD, CLS_SKIP, CLS_CJK, CLS_WORD, get clsBmp() { return clsBmp; } };`)();
};
const mod = load(ENGINE);

// ── 参考实现：0.6.20 之前那两条正则 + 切段逻辑（照抄旧 tokenize）────────────────
const CJK_REF = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3005\u30fc]/u;
const WORD_REF = /[\p{L}\p{N}]/u;
function refClassify(cp) {
  if (CJK_REF.test(cp)) return 'cjk';
  if (WORD_REF.test(cp)) return 'word';
  return 'skip';
}
function segsOf(text, cls) {
  const cps = Array.from(text.normalize('NFKC'));
  const out = [];
  let i = 0;
  while (i < cps.length) {
    const c = cls(cps[i]);
    if (c === 'skip') {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < cps.length && cls(cps[j]) === c) j += 1;
    const run = cps.slice(i, j);
    if (c === 'cjk') {
      if (run.length >= 2) for (let k = 0; k + 1 < run.length; k += 1) out.push(run[k] + run[k + 1]);
    } else out.push(run.join('').toLowerCase());
    i = j;
  }
  return out;
}

// ── L0 形状 ───────────────────────────────────────────────────────────────────
{
  const seg = segOf(ENGINE);
  // 0.6.22 起切词拆成 tokenizeSegs（分段）+ finishToks（英文化），逐码点的活全在 tokenizeSegs 里，
  // 所以形状检查盯它；tokenize 现在只是一行包装。
  const body = ENGINE.slice(ENGINE.indexOf('function tokenizeSegs(text) {'));
  const tokBody = body.slice(0, body.indexOf('\n}\n'));
  // 形状判据要先剥注释：老写法的解释（`不再 `Array.from(normalize(...))`）仍留在 `//` 里。
  const tokCode = tokBody.split('\n').filter((l) => l.trim().startsWith('//') === false).join('\n');
  const wrapper = ENGINE.slice(ENGINE.indexOf('function tokenize(text) {'));
  const wrapperBody = wrapper.slice(0, wrapper.indexOf('\n}\n'));
  const cjkLine = (seg.match(/^var CJK = (.*)$/m) || ['', ''])[1];
  const wordLine = (seg.match(/^var WORD = (.*)$/m) || ['', ''])[1];
  const shape = {
    consts: seg.includes('var CLS_SKIP = 0;') && seg.includes('var CLS_CJK = 1;') && seg.includes('var CLS_WORD = 2;'),
    lazy: seg.includes('var clsBmp = null;'),
    table: seg.includes('var t = new Uint8Array(65536);') && seg.includes('String.fromCharCode(c)'),
    fromRegex: seg.includes('new RegExp(CJK.source + "+", "gu")') && seg.includes('new RegExp(WORD.source + "+", "gu")'),
    onlyEmpty: seg.includes('if (t[k] === CLS_SKIP) t[k] = CLS_WORD;'),
    fastPath: seg.includes('if (cp.length === 1) {') && seg.includes('return t[cp.charCodeAt(0)];'),
    fallback: seg.includes('if (CJK.test(cp)) return CLS_CJK;'),
    wrapper: /function classify\(cp\) \{\n {2}var k = clsCode\(cp\);/.test(seg),
    // [0.6.24] 切段循环从「先 Array.from 成码点数组、再按下标比」改成在归一后的字符串上按下标走，
    // 形状关键词随之从 `cps[i]` / `nCp` 变成 `s.codePointAt(i)` / `nS`；守的仍是「数值比较、不调 classify」。
    tokNumeric: tokCode.includes('const cls = clsCode(') && tokCode.includes('if (cls === CLS_SKIP) {') && tokCode.includes('=== cls)') && tokCode.includes('if (cls === CLS_CJK) {'),
    tokNoRegex: tokCode.includes('classify(') === false,
    tokWrap: wrapperBody.includes('return finishToks(tokenizeSegs(text));'),
    strIndex: tokCode.includes('const nS = s.length;') && tokCode.includes('Array.from(') === false,
    regeces: cjkLine.includes('\\p{Script=Han}') && wordLine.includes('\\p{L}'),
  };
  const bad = Object.keys(shape).filter((k) => !shape[k]);
  ok(
    'L0 形状：三档常量 / 惰性表 / 表由 CJK·WORD 两条正则扫出 / 单码点快路 + 星外退路 / tokenizeSegs 改数值比较且不再调 classify / tokenize 留成一行包装 / classify 仍留成字符串包装',
    bad.length === 0 && mod !== null,
    `缺 ${bad.length === 0 ? '无' : bad.join(',')}`,
  );
}

// ── L1 全码点（最强的判据：1,112,064 个码点逐点相同）────────────────────────────
{
  let mism = 0;
  let first = '';
  let n = 0;
  for (let c = 0; c <= 0x10ffff; c += 1) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    const ch = String.fromCodePoint(c);
    n += 1;
    if (refClassify(ch) !== mod.classify(ch)) {
      mism += 1;
      if (first === '') first = `U+${c.toString(16).toUpperCase().padStart(4, '0')} ${refClassify(ch)}≠${mod.classify(ch)}`;
    }
  }
  ok('L1 全码点：0x0000–0x10FFFF（跳过代理区）逐点分类与旧正则相同', mism === 0 && n === 1112064, mism === 0 ? `${n.toLocaleString('en-US')} 码点 · 0 不一致` : `${mism} 不一致 · 首例 ${first}`);
}

// ── L2 表本身 ─────────────────────────────────────────────────────────────────
{
  const t1 = mod.buildClsBmp();
  const t2 = mod.buildClsBmp();
  let cellBad = 0;
  let cellFirst = '';
  for (let c = 0; c <= 0xffff; c += 1) {
    const a = refClassify(String.fromCharCode(c));
    const want = a === 'cjk' ? mod.CLS_CJK : a === 'word' ? mod.CLS_WORD : mod.CLS_SKIP;
    if (t1[c] !== want) {
      cellBad += 1;
      if (cellFirst === '') cellFirst = `U+${c.toString(16).toUpperCase().padStart(4, '0')} want ${want} got ${t1[c]}`;
    }
  }
  let same = t1.length === t2.length;
  for (let c = 0; same && c <= 0xffff; c += 1) if (t1[c] !== t2[c]) same = false;
  const counts = [0, 0, 0];
  for (let c = 0; c <= 0xffff; c += 1) counts[t1[c]] += 1;
  ok(
    'L2 表本身：BMP 65,536 格与两条正则逐格一致、长度 65,536、建两次逐格相同（纯函数）',
    cellBad === 0 && t1.length === 65536 && same,
    cellBad === 0 ? `skip ${counts[0]} / cjk ${counts[1]} / word ${counts[2]}` : `${cellBad} 格不一致 · 首例 ${cellFirst}`,
  );
}

// ── L3 切段对拍 ───────────────────────────────────────────────────────────────
{
  const corpus = [
    '记忆管理插件的性能优化：把 n-gram 共现换成倒排索引，2026-03-14 0.6.21 released',
    'Hello, World! 你好世界。 ＡＢＣ１２３（全角） ﾊﾝｶｸ ㈱ ① Ⅷ',
    '記憶 插件 Ａ 1.0.0 — 破折号、书名号《测试》 混排 mixed 中文English混排',
    '　  \t\n\r　、。，．：；？！',
    '',
    'a',
    '读',
    '读两遍',
    'file.path/to_name-v2.ts',
    '한국어 日本語 ひらがな カタカナ ｶﾀｶﾅ 々 ー',
    '𠀋𠮷 astral 文字',
    '😀🎉 emoji 混排 中文字',
    '𠀋𠀋𠀋 三连星外',
    '\uD800\uDC00\uDFFF\uD800a\uDC00',
  ];
  let bad = 0;
  let first = '';
  for (const s of corpus) {
    const a = JSON.stringify(segsOf(s, refClassify));
    const b = JSON.stringify(segsOf(s, mod.classify));
    if (a !== b) {
      bad += 1;
      if (first === '') first = `${JSON.stringify(s.slice(0, 24))} ref ${a.slice(0, 80)} got ${b.slice(0, 80)}`;
    }
  }
  ok('L3 切段：混排语料（全角/半角片假名/々ー/emoji/星外字/孤立代理项/空串/单字）逐串相同', bad === 0, bad === 0 ? `${corpus.length} 串 · 0 不一致` : `${bad} 串不一致 · 首例 ${first}`);
}

// ── L4 惰性 ───────────────────────────────────────────────────────────────────
{
  const fresh = load(ENGINE);
  const bornNull = fresh.clsBmp === null;
  const firstOut = fresh.clsCode('中');
  const built = fresh.clsBmp;
  const builtOnce = built !== null && built.length === 65536 && firstOut === fresh.CLS_CJK;
  for (let i = 0; i < 200; i += 1) fresh.clsCode(i % 2 === 0 ? '中' : 'a');
  const stable = fresh.clsBmp === built;
  ok(
    'L4 惰性：模块起来时表还没建、第一次分类才建（一次 64KB）、此后 identity 不变（不重建）',
    bornNull && builtOnce && stable,
    `起于 null=${bornNull} · 首调建好=${builtOnce} · 后续不重建=${stable}`,
  );
}

// ── L5 退化 ───────────────────────────────────────────────────────────────────
{
  const cases = ['', '   ', '、。，．', 'a', '中', '🥲', '𠀋', '\uD800', '中a中', '中\n中'];
  let bad = 0;
  let first = '';
  for (const s of cases) {
    const a = JSON.stringify(segsOf(s, refClassify));
    const b = JSON.stringify(segsOf(s, mod.classify));
    if (a !== b) {
      bad += 1;
      if (first === '') first = `${JSON.stringify(s)} ref ${a} got ${b}`;
    }
  }
  const emptyTok = segsOf('   、。，．\t', mod.classify).length === 0;
  const singleCjk = JSON.stringify(segsOf('中', mod.classify)) === '[]';
  const pairCjk = JSON.stringify(segsOf('中文', mod.classify)) === '["中文"]';
  ok(
    'L5 退化：空串/纯标点/单字/星外字/孤立代理项与参考同输出；标点串 0 token、单汉字 0 token、两汉字 1 个二元组',
    bad === 0 && emptyTok && singleCjk && pairCjk,
    bad === 0 ? `${cases.length} 例 ok · 标点0=${emptyTok} · 单字0=${singleCjk} · 二元组=${pairCjk}` : `${bad} 例不一致 · 首例 ${first}`,
  );
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} · probe-lex ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
