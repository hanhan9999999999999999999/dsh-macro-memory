// [macro-fusion 0.6.22] 判据：建索引不再把同一批字段切两遍，且切词拆成「分段」+「成词」两段之后
// 逐字段结果与老口径**完全相同**。
//
// 背景（`docs/INTERNAL.md` 9.221）：0.6.21 之后冷建链第一名是 `bumpIn` `:3248` 57.0ms / 4.3%，
// 紧随其后是 `buildSearchIndex` `:3331` 23.1ms、`:3370` 21.0ms、`:3397` 17.8ms、`:3373` 13.6ms、
// `:3399` 11.5ms（10,000 条 / 300 问，1,337.0ms 总采样）。病根两条：
//   ① 同一批字段被切两遍——content 进 `plainToks` 一遍、数 `bodyLen` 又一遍；title 进 `plainToks`
//      一遍、建 `titleSets` 又一遍；keywords 在 `kwToks` 与 `kwSets` 两处表达式一字不差；
//   ② 每条配一个 `seen` Set，每个（条, 词）对要付 `m.get` + `m.set` + `seen.has` + `seen.add` 四次哈希查找。
//
// 处方：`tokenize` 拆成 `tokenizeSegs`（只看本串、纯函数）与 `finishToks`（看整表成分比例的英文化
// 那一趟），字段各分段一遍、成词一趟就地补；`seen` 换成「`m` 里键不存在即首次出现」。
//
// 这一刀的风险全在**词**上：切词结构一改，召回就动。所以这个探针要证明六件事：
//
//   C0 形状：三段函数在、buildSearchIndex 单趟填 plainToks/bodyLen/titleSets、keywords 只切一次、
//      `seen` 已删、`member` 判首次用 `m.get(t)` 的三目
//   C1 分段可交换：`segs(a) ++ segs(b)` 与 `segs(a + ' ' + b)` 逐 token 相同（空格可跳、词不错跨）
//   C2 成词可交换：`finishToks(segs(a) ++ segs(b))` 与 `tokenize(a + ' ' + b)` 逐 token 相同——
//      这一条是 0.6.22 的核心（英文化看整表比例，所以不能对半成品逐段跑）
//   C3 字段口径：按老代码的表达式复算 plainToks / bodyLen / titleSets / kwToks / kwSets，
//      与新的单趟实现逐条逐词相同（含 kwSeparate:false / fieldBoost:false 两条支路）
//   C4 确定性：同一批库连建两次、cache:false 与缓存两条路，检索回执逐位相同
//   C5 退化：空 title/content、null、emoji、星外字、全角、关键词全是停用词、关键词是逗号串
import { readFileSync } from 'node:fs';
import { search, searchIndexOf, clearSearchIndexCache } from '../vendor/meow-memory/lib/index.js';

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

// ── 从引擎里切出词法那一段当纯函数跑（不起索引、不碰存储）──────────────────────
const SEG_BEGIN = 'var CJK = ';
const SEG_END = 'function docText(d) {';
const segOf = (src) => {
  const a = src.indexOf(SEG_BEGIN);
  const b = src.indexOf(SEG_END);
  if (a < 0 || b <= a) return '';
  return src.slice(a, b);
};
const load = (src) => {
  const seg = segOf(src);
  if (seg === '') return null;
  return new Function(`${seg}\nreturn { classify, clsCode, clsAt, tokenizeSegs, finishToks, tokenize, isMostlyLatin, kwList };`)();
};
const LEX = load(ENGINE);

// ── C0 形状 ───────────────────────────────────────────────────────────────────
{
  const idx = ENGINE.indexOf('function buildSearchIndex(docs, opts = {}, sig = null) {');
  const after = ENGINE.indexOf('\n}\n', idx);
  const body = idx < 0 ? '' : ENGINE.slice(idx, after);
  const tokBody = ENGINE.slice(ENGINE.indexOf('function tokenize(text) {'));
  const tokOne = tokBody.slice(0, tokBody.indexOf('\n}\n'));
  const shape = {
    segsFn: ENGINE.includes('function tokenizeSegs(text) {'),
    finishFn: ENGINE.includes('function finishToks(out) {') && ENGINE.includes('return isMostlyLatin(out) ? normalizeEn(out) : out;'),
    tokWrapper: /function tokenize\(text\) \{\s*return finishToks\(tokenizeSegs\(text\)\);/.test(tokOne),
    singlePass: body.includes("const ts = tokenizeSegs(String(d.title ?? ''));") && body.includes("const cs = tokenizeSegs(String(d.content ?? ''));"),
    bodyInPlace: body.includes('const body = finishToks(cs);') && body.includes('bodyLen[i] = body.length > 0 ? body.length : 1;'),
    // [0.6.25] 标题那份词表原地接上正文（老写法是 `ts.concat(cs)`，每条多造一只数组）
    plainInPlace: body.includes('plainToks[i] = finishToks(ts);') && body.includes('for (let k = 0; k < cs.length; k++) ts.push(cs[k]);'),
    titleSetInPlace: body.includes('titleSets[i] = new Set(finishToks(ts));'),
    // keywords 只「成词」一趟（`kwFlatArr` 里那一次）；kwSeparate:false 那条支路用的是分段版
    // `tokenizeSegs`，与它互斥，不额外付成词的钱。
    kwOnce: (body.match(/tokenize\(/g) || []).length === 1 && body.includes('const kwSets = useField ? kwFlatArr.map((t) => new Set(t)) : null;'),
    noSeen: body.includes('const seen = new Set();') === false && body.includes('seen.has(') === false,
    firstViaMap: body.includes('const cur = m.get(t);') && body.includes('else m.set(t, cur + 1);'),
    noRetok: body.includes('docs.map((d) => tokenize(String(d.content ?? \'\')))') === false && body.includes('new Set(tokenize(') === false,
    bodyLenFromSegs: body.includes('const kwFlatArr = kwSep || useField'),
  };
  const bad = Object.keys(shape).filter((k) => !shape[k]);
  ok(
    'C0 形状：tokenize 拆成 tokenizeSegs + finishToks 两段（tokenize 仍是一行包装）/ buildSearchIndex 单趟填 plainToks·bodyLen·titleSets / keywords 只切一次 / 每条不再配 seen Set / 首见判据改 m.get',
    bad.length === 0 && LEX !== null,
    `缺 ${bad.length === 0 ? '无' : bad.join(',')}`,
  );
}

// ── 语料：用来做引理对拍 ──────────────────────────────────────────────────────
const PAIRS = [
  ['基线要跑几轮才收敛', '自检基线 跑两趟 三趟 才收敛 收敛 收敛'],
  ['keywords as string', '逗号分隔的关键词写法 也要一致'],
  ['KvNet probe 0.6.22', 'kvnet 探针 sigRowFor classify CLS_CJK 65,536 个码点 😀𠀀𪚥'],
  ['', '只有正文 没有标题'],
  ['只有标题', ''],
  ['', ''],
  ['the quick brown fox', 'jumps over the lazy dog and the end'],
  ['索引 缓存', 'the index cache is warm and the search is fast'],
  ['记忆管理', 'Hello World 你好世界 全角ＡＢＣ１２３'],
  ['同一个词重复很多次', '重复 重复 重复 重复 重复'],
  ['中', 'a'],
  ['a', '中'],
  ['𠀋𠮷 astral', '😀🎉 emoji 混排'],
  ['   ', '   \n\t '],
];

// ── C1 分段可交换 ─────────────────────────────────────────────────────────────
{
  let bad = 0;
  let first = '';
  for (const [title, content] of PAIRS) {
    const want = JSON.stringify(LEX.tokenizeSegs(`${title} ${content}`));
    const got = JSON.stringify(LEX.tokenizeSegs(title).concat(LEX.tokenizeSegs(content)));
    if (want !== got) {
      bad += 1;
      if (first === '') first = `${JSON.stringify(title).slice(0, 16)} + ${JSON.stringify(content).slice(0, 16)}`;
    }
    const kw = LEX.kwList({ keywords: ['关键词', 'as', '缓存'] }).join(' ');
    const want3 = JSON.stringify(LEX.tokenizeSegs(`${title} ${content} ${kw}`));
    const got3 = JSON.stringify(LEX.tokenizeSegs(title).concat(LEX.tokenizeSegs(content), LEX.tokenizeSegs(kw)));
    if (want3 !== got3) {
      bad += 1;
      if (first === '') first = `kw 支路 ${JSON.stringify(title).slice(0, 16)}`;
    }
  }
  ok('C1 分段可交换：segs(a) ++ segs(b) 与 segs(a ␠ b) 逐 token 相同（含 keywords 拼在后面那条支路）', bad === 0, bad === 0 ? `${PAIRS.length} 对 · 0 不一致` : `${bad} 处不一致 · 首例 ${first}`);
}

// ── C2 成词可交换（本版核心）─────────────────────────────────────────────────
{
  let bad = 0;
  let first = '';
  let latinCases = 0;
  for (const [title, content] of PAIRS) {
    const want = JSON.stringify(LEX.tokenize(`${title} ${content}`));
    const got = JSON.stringify(LEX.finishToks(LEX.tokenizeSegs(title).concat(LEX.tokenizeSegs(content))));
    if (want !== got) {
      bad += 1;
      if (first === '') first = `${JSON.stringify(title).slice(0, 16)} + ${JSON.stringify(content).slice(0, 16)} want ${want.slice(0, 90)} got ${got.slice(0, 90)}`;
    }
    const segs = LEX.tokenizeSegs(`${title} ${content}`);
    if (LEX.isMostlyLatin(segs)) latinCases += 1;
  }
  // 反面例子：title 单独看是「以拉丁为主」（会被英文化砍停用词 / 词尾归一），拼上中文正文后不再以拉丁为主。
  // 老代码对「拼好的整串」跑一次成词，新代码必须同样只在整表上跑——这一条就是盯它。
  const latinTitle = 'keywords as string';
  const cjkBody = '这是中文正文 四个实词 都在这里';
  const a = JSON.stringify(LEX.tokenize(`${latinTitle} ${cjkBody}`));
  const b = JSON.stringify(LEX.finishToks(LEX.tokenizeSegs(latinTitle).concat(LEX.tokenizeSegs(cjkBody))));
  const naivelyWrong = JSON.stringify(LEX.tokenize(latinTitle).concat(LEX.tokenize(cjkBody)));
  ok(
    'C2 成词可交换：finishToks(segs(a) ++ segs(b)) 与 tokenize(a ␠ b) 逐 token 相同（英文化只在整表上跑一次）',
    bad === 0 && a === b && naivelyWrong !== a && latinCases > 0,
    bad === 0
      ? `${PAIRS.length} 对 · 0 不一致 · 以拉丁为主 ${latinCases} 对 · 混排反例（逐段成词会更短）${naivelyWrong.slice(0, 40)}…`
      : `${bad} 处不一致 · 首例 ${first}`,
  );
}

// ── C3 字段口径：老表达式 vs 新单趟 ───────────────────────────────────────────
const DOCS = [
  { id: 'd1', title: '基线要跑几轮才收敛', content: '自检基线 跑两趟 三趟 才收敛 收敛 收敛', keywords: ['基线', '收敛'] },
  { id: 'd2', title: '', content: '', keywords: [] },
  { id: 'd3', title: '   ', content: '   \n\t ', keywords: [''] },
  { id: 'd4', title: 'KvNet probe 0.6.22', content: 'kvnet 探针 sigRowFor classify CLS_CJK 65,536 个码点 😀𠀀𪚥', keywords: ['kvnet', 'p0.6.22', 'probe'] },
  { id: 'd5', title: '同一个词重复很多次', content: '重复 重复 重复 重复 重复 重复 重复 重复 重复 重复', keywords: ['重复', '重复'] },
  { id: 'd6', title: '标题里的词也在正文里', content: '标题里的词也在正文里 标题里的词也在正文里', keywords: ['标题里的词也在正文里'] },
  { id: 'd7', title: 'keywords as string', content: '逗号分隔的关键词写法 也要一致', keywords: '逗号,分隔,的关键词' },
  { id: 'd8', title: null, content: null, keywords: null },
  { id: 'd9', title: 'undefined 与 null 混着来', content: 'undefined null NaN Infinity', keywords: [undefined, null, '   '] },
  { id: 'd10', title: 'ASCII only', content: 'the quick brown fox jumps over the lazy dog the end', keywords: ['fox', 'dog'] },
  { id: 'd11', title: '全是停用词的关键词', content: '正文里没有任何英文', keywords: ['a', 'the', 'as', 'and'] },
  { id: 'd12', title: 'keywords JSON', content: '关键词写成 JSON 串也要一致', keywords: '["甲","乙","丙"]' },
];
{
  let bad = 0;
  let first = '';
  const kwFlat = (d) => LEX.kwList(d).flatMap((w) => LEX.tokenize(String(w ?? '')));
  for (const kwSep of [true, false]) {
    for (const useField of [true, false]) {
      DOCS.forEach((d, i) => {
        const kwSegs = LEX.kwList(d).flatMap((w) => LEX.tokenizeSegs(String(w ?? '')));
        // 老口径（0.6.21 的表达式，逐条抄）
        const dTextOld = kwSep
          ? `${String(d.title ?? '')} ${String(d.content ?? '')}`
          : [String(d.title ?? ''), String(d.content ?? ''), LEX.kwList(d).join(' ')].join(' ');
        const oldPlain = LEX.tokenize(dTextOld);
        const oldBody = LEX.tokenize(String(d.content ?? ''));
        const oldBodyLen = oldBody.length > 0 ? oldBody.length : 1;
        const oldTitleSet = useField ? new Set(LEX.tokenize(String(d.title ?? ''))) : null;
        const oldKwSet = useField ? new Set(kwFlat(d)) : null;
        const oldKwToks = kwSep ? kwFlat(d) : null;
        // 新口径（0.6.22 单趟里那几行，逐条抄）
        const ts = LEX.tokenizeSegs(String(d.title ?? ''));
        const cs = LEX.tokenizeSegs(String(d.content ?? ''));
        const body = LEX.finishToks(cs);
        const newBodyLen = body.length > 0 ? body.length : 1;
        const newPlain = kwSep ? LEX.finishToks(ts.concat(cs)) : LEX.finishToks(ts.concat(cs, kwSegs));
        const newTitleSet = useField ? new Set(LEX.finishToks(ts)) : null;
        const newKwSet = useField ? new Set(kwFlat(d)) : null;
        const newKwToks = kwSep ? kwFlat(d) : null;
        const pairs = [
          ['plainToks', JSON.stringify(oldPlain), JSON.stringify(newPlain)],
          ['bodyLen', String(oldBodyLen), String(newBodyLen)],
          ['titleSets', oldTitleSet === null ? 'null' : JSON.stringify([...oldTitleSet].sort()), newTitleSet === null ? 'null' : JSON.stringify([...newTitleSet].sort())],
          ['kwSets', oldKwSet === null ? 'null' : JSON.stringify([...oldKwSet].sort()), newKwSet === null ? 'null' : JSON.stringify([...newKwSet].sort())],
          ['kwToks', oldKwToks === null ? 'null' : JSON.stringify(oldKwToks), newKwToks === null ? 'null' : JSON.stringify(newKwToks)],
        ];
        for (const [field, x, y] of pairs) {
          if (x !== y) {
            bad += 1;
            if (first === '') first = `doc#${i}(${d.id})/${field} kwSep=${kwSep} field=${useField} old=${x.slice(0, 70)} new=${y.slice(0, 70)}`;
          }
        }
      });
    }
  }
  ok(
    'C3 字段口径：plainToks / bodyLen / titleSets / kwSets / kwToks 与老表达式逐条相同（kwSeparate × fieldBoost 四条支路）',
    bad === 0,
    bad === 0 ? `${DOCS.length} 条 × 4 支路 · 0 不一致` : `${bad} 处不一致 · 首例 ${first}`,
  );
}

// ── C4 确定性：连建两次、缓存两条路，回执逐位相同 ────────────────────────────
{
  const q = '基线 收敛 重复';
  const idsOf = (hits) => hits.map((h) => h.id).join(',');
  const a = idsOf(search(q, DOCS, { k: 5 }));
  const b = idsOf(search(q, DOCS, { k: 5 }));
  const c = idsOf(search(q, DOCS, { k: 5, cache: false }));
  const d2 = idsOf(search(q, DOCS, { k: 5, cache: false }));
  ok('C4 确定性：同一批库连查两次、cache:false 与缓存两条路，回执逐位相同', a === b && a === c && c === d2 && a !== '', `hits=${a === '' ? 0 : a.split(',').length}`);
}

// ── C5 退化 ───────────────────────────────────────────────────────────────────
{
  const cases = [
    ['', '', []],
    [null, null, null],
    ['😀', '🎉 emoji 混排', ['😀']],
    ['𠀋𠮷', '𠀀𪚥 星外字', ['𠀋']],
    ['全角ＡＢＣ', '半角abc', ['Ａ']],
    ['a', 'the', ['the']],
    ['', '   \n\t ', ['   ']],
    ['逗号', '串关键词', '甲,乙,丙'],
    ['JSON', '关键词', '["甲","乙"]'],
    ['中', '中', ['中']],
    ['  标题  ', '  正文  ', ['  关键词  ']],
  ];
  let bad = 0;
  let first = '';
  for (const [title, content, keywords] of cases) {
    const d = { id: 'x', title, content, keywords };
    const want = JSON.stringify(LEX.tokenize([String(title ?? ''), String(content ?? ''), LEX.kwList(d).join(' ')].join(' ')));
    const got = JSON.stringify(LEX.finishToks(LEX.tokenizeSegs(String(title ?? '')).concat(LEX.tokenizeSegs(String(content ?? '')), LEX.kwList(d).flatMap((w) => LEX.tokenizeSegs(String(w ?? ''))))));
    if (want !== got) {
      bad += 1;
      if (first === '') first = `${JSON.stringify(title).slice(0, 14)} want ${want.slice(0, 70)} got ${got.slice(0, 70)}`;
    }
  }
  const empties = LEX.tokenizeSegs('').length === 0 && LEX.finishToks([]).length === 0;
  const stopOnly = LEX.tokenize('the as and a').length === 0;
  ok(
    'C5 退化：空/null/emoji/星外字/全角/纯停用词/逗号串与 JSON 串关键词，与「拼起来再一次成词」逐 token 相同',
    bad === 0 && empties && stopOnly,
    bad === 0 ? `${cases.length} 例 ok · 空表 0 token · 纯停用词 0 token` : `${bad} 例不一致 · 首例 ${first}`,
  );
}

// ── C6 切词逐位：下标版 vs 0.6.23 的 Array.from 版 ────────────────────────────
{
  // 老实现（0.6.23 原文，逐字抄下来当尺子；分类仍用引擎自己的 clsCode）
  const refSegs = (text) => {
    const cps = Array.from(text.normalize('NFKC'));
    const out = [];
    const nCp = cps.length;
    let i = 0;
    while (i < nCp) {
      const cls = LEX.clsCode(cps[i]);
      if (cls === 0) {
        i += 1;
        continue;
      }
      let j = i + 1;
      while (j < nCp && LEX.clsCode(cps[j]) === cls) j += 1;
      const run = cps.slice(i, j);
      if (cls === 1) {
        if (run.length >= 2) for (let k = 0; k + 1 < run.length; k += 1) out.push(run[k] + run[k + 1]);
      } else out.push(run.join('').toLowerCase());
      i = j;
    }
    return out;
  };
  const CASES = [
    ...PAIRS.flat(),
    '', ' ', '中', 'a', '中文分词测试', 'the quick brown fox',
    '𠀀𪚥𠀀𪚥 astral 中文', '😀😀 emoji 中文', '\ud800 孤立代理项 \udfff 中文',
    'ＡＢＣ ａｂｃ １２３ 全角', 'ﬁ ﬀ ﬁne 合字', 'İstanbul ıI', 'e\u0301 combining',
    '日本語のテキスト カタカナ ひらがな 漢字', '한국어 텍스트 테스트',
    '零宽\u200b字符\u200d混排', 'x'.repeat(300) + '中文'.repeat(120),
    '中英混 mixed 123 abc', '㍿㌔㌀ 半角ｶﾀｶﾅ', 'αβγ Ωμέγα', '  多个   空格    中文  ',
    '换行\n回车\r\n制表\t中文', '中文，标点。英文. test；分号：冒号', 'x'.repeat(400),
  ];
  let bad = 0;
  let first = '';
  let tokens = 0;
  for (const s of CASES) {
    const x = String(s ?? '');
    const want = refSegs(x);
    const got = LEX.tokenizeSegs(x);
    tokens += want.length;
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      bad += 1;
      if (first === '') first = `${JSON.stringify(x).slice(0, 18)} want ${JSON.stringify(want).slice(0, 70)} got ${JSON.stringify(got).slice(0, 70)}`;
    }
  }
  const body = ENGINE.slice(ENGINE.indexOf('function tokenizeSegs(text) {'), ENGINE.indexOf('function finishToks(out) {'));
  // 注释里会提到形状本身（比如「不再 Array.from(...)」），形状判据只看代码行
  const code = body.split('\n').filter((l) => l.trim().startsWith('//') === false).join('\n');
  const shape = {
    noArrayFrom: code.includes('Array.from(') === false,
    normalizeInPlace: code.includes('const s = text.normalize("NFKC");'),
    cpWidth: code.includes('const w0 = s.codePointAt(i) > 65535 ? 2 : 1;'),
    bigramBySlice: code.includes('out.push(s.slice(ps, k + w));') && code.includes('out.push(prev + cur);') === false,
  };
  const miss = Object.keys(shape).filter((k) => !shape[k]);
  ok(
    'C6 切词逐位：下标版与 Array.from 版逐 token 相同（星外字 / emoji / 孤立代理项 / NFKC 全角合字 / 超长串），且不再造字符数组',
    bad === 0 && miss.length === 0,
    bad === 0 ? `${CASES.length} 例 · ${tokens} token · 0 不一致${miss.length === 0 ? '' : ` · 形状缺 ${miss.join(',')}`}` : `${bad} 例不一致 · 首例 ${first}`,
  );
}

// ── C7 df 摊出来 / 倒排条目只查一次 ──────────────────────────────────────────
{
  const begin = ENGINE.indexOf('function buildSearchIndex(docs, opts = {}, sig = null) {');
  const body = begin < 0 ? '' : ENGINE.slice(begin, ENGINE.indexOf('\n}\n', begin));
  const code = body.split('\n').filter((l) => l.trim().startsWith('//') === false).join('\n');
  const shape = {
    refsOneArray: code.includes('const refs = postings === null ? null : [];'),
    refsPerDoc: code.includes('let refN = 0;') && code.includes('refs[refN++] = p;') && code.includes('refs.length = 0;'),
    dfFromD: code.includes('if (postings !== null) for (const [t, p] of postings) df.set(t, p.d.length);'),
    twoLookups: (code.match(/postings\.get\(t\)/g) || []).length === 2,
    noOptionalChain: code.includes('postings?.get(') === false,
    dfInlineFallback: (code.match(/df\.set\(t, \(df\.get\(t\) \?\? 0\) \+ 1\)/g) || []).length === 2,
  };
  const miss = Object.keys(shape).filter((k) => !shape[k]);
  clearSearchIndexCache();
  const idx = searchIndexOf(DOCS, {});
  let bad = 0;
  for (const [t, p] of idx.postings) if (idx.df.get(t) !== p.d.length) bad += 1;
  const invisible = [...idx.df.keys()].filter((t) => !idx.postings.has(t)).length;
  clearSearchIndexCache();
  const noInv = searchIndexOf(DOCS, { inverted: false });
  const sameDf = noInv.postings === null && JSON.stringify([...idx.df]) === JSON.stringify([...noInv.df]);
  // 倒排里 f / t 与 d 同下标对齐（收尾那趟按下标回填，错位就会撞这条）
  let misalign = 0;
  for (const [, p] of idx.postings) if (p.d.length !== p.f.length || p.d.length !== p.t.length) misalign += 1;
  ok(
    'C7 df 摊出来：df 恒等于倒排长度、与关掉倒排那条支路逐位相同（键序同），且每条只回查一次倒排（f/t 与 d 对齐）',
    miss.length === 0 && bad === 0 && invisible === 0 && sameDf && misalign === 0,
    `df ${idx.df.size} 词 · 倒排 ${idx.postings.size} 词 · 不等 ${bad} · 缺键 ${invisible} · 关倒排同名同值 ${sameDf} · 错位 ${misalign}${miss.length === 0 ? '' : ` · 形状缺 ${miss.join(',')}`}`,
  );
}

// ── C8 成词那一趟不再付正则 / 不再拼临时的二元组 ────────────────────────────
{
  const begin = ENGINE.indexOf('function isLatinToken(t) {');
  const body = begin < 0 ? '' : ENGINE.slice(begin, ENGINE.indexOf('function tokenizeSegs(text) {', begin));
  const code = body.split('\n').filter((l) => l.trim().startsWith('//') === false).join('\n');
  const shape = {
    latinByCode: code.includes('if (c < 97 || c > 122) return false;'),
    noLatinRegex: code.includes('/^[a-z]+$/') === false,
    newlineStrict: code.includes('const end = t.charCodeAt') === false && code.includes('for (let i = 0; i < len; i++) {'),
    earlyExit: code.includes('if (latin * 2 >= ln) return true;'),
  };
  // 行为：与老判据（正则版 + 整表扫完）逐例同值
  const refMostly = (tokens) => {
    if (tokens.length === 0) return false;
    let latin = 0;
    for (const t of tokens) if (/^[a-z]+$/.test(t)) latin += 1;
    return latin * 2 >= tokens.length;
  };
  const ALPHA = ['a', 'z', 'abc', 'keyword', 'A', 'aA', 'a1', '', '中文', 'ab\n', '\n', 'a\n', 'ab\nc', 'x'.repeat(5), 'İ', 'ﬀ'];
  const CASES = [];
  for (let i = 0; i < ALPHA.length; i++) {
    for (let j = 0; j < ALPHA.length; j++) CASES.push([ALPHA[i], ALPHA[j], ALPHA[(i + j) % ALPHA.length]]);
  }
  CASES.push([], ['a'], ['中文'], ['a', '中文'], ['abc', 'def', 'ghi']);
  let bad = 0;
  let first = '';
  for (const toks of CASES) {
    const want = refMostly(toks);
    const got = LEX.isMostlyLatin(toks);
    if (want !== got) {
      bad += 1;
      if (first === '') first = `${JSON.stringify(toks)} want ${want} got ${got}`;
    }
  }
  const miss = Object.keys(shape).filter((k) => !shape[k]);
  ok(
    'C8 成词那一趟：拉丁词按码点判（97–122）不再逐词跑正则、过半即早退，判据与正则版逐例同值',
    LEX !== null && miss.length === 0 && bad === 0,
    LEX === null ? '词法段没切出来' : `${CASES.length} 例 · 0 不一致${miss.length === 0 ? '' : ` · 形状缺 ${miss.join(',')}`}${bad === 0 ? '' : ` · 首例 ${first}`}`,
  );
}

// ── C9 按下标分类：不为「一个码点」造字符串 ──────────────────────────────────
{
  const begin = ENGINE.indexOf('function clsAt(s, i) {');
  const atBody = begin < 0 ? '' : ENGINE.slice(begin, ENGINE.indexOf('\n}\n', begin));
  const atCode = atBody.split('\n').filter((l) => l.trim().startsWith('//') === false).join('\n');
  const tokBody = ENGINE.slice(ENGINE.indexOf('function tokenizeSegs(text) {'), ENGINE.indexOf('function finishToks(out) {'));
  const tokCode = tokBody.split('\n').filter((l) => l.trim().startsWith('//') === false).join('\n');
  const shape = {
    atExists: begin >= 0 && atCode.includes('var c = s.charCodeAt(i);'),
    surrogatePair: atCode.includes('if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {') && atCode.includes('if (d >= 0xdc00 && d <= 0xdfff) return clsCode(s.slice(i, i + 2));'),
    bmpTable: atCode.includes('var t = clsBmp === null ? (clsBmp = buildClsBmp()) : clsBmp;') && atCode.includes('return t[c];'),
    // 内层两处都走 clsAt；老写法（`s[i]` 单字符串 / 星外 `s.slice(j, j + 2)`）不再出现
    tokUsesAt: tokCode.includes('const cls = clsAt(s, i);') && tokCode.includes('while (j < nS && clsAt(s, j) === cls) {'),
    noCharIndex: tokCode.includes('s[i]') === false,
    noInnerSlice: tokCode.includes('clsCode(') === false,
  };
  // 行为：每个下标按「该下标的码点」独立核对——分类以 Unicode 属性正则为尺子
  // （`classify` 就是那两条正则本体，不经 BMP 表；它给的是 cjk/word/skip 三个词，
  // 这里折回 1/2/0 与 `clsAt` 的数值口径对齐），星外字、孤立代理项、全角、合字都过一遍。
  const NUM = { cjk: 1, word: 2, skip: 0 };
  const CASES = [
    '中文分词测试', 'the quick brown fox', '𠀀𪚥𠀋𠮷 astral', '😀🎉 emoji 混排', '\ud800 孤立高位 \udfff 孤立低位',
    'ＡＢＣ１２３ 全角', 'ﬁne ﬀ 合字', 'İstanbul ıI', '日本語テキスト カタカナ ひらがな', '한국어 텍스트',
    'αβγ Ωμέγα', '中英混 mixed 123', '㍿㌔㌀ 半角ｶﾀｶﾅ', '零宽\u200b字符\u200d', 'x'.repeat(64) + '中文'.repeat(8),
  ];
  let bad = 0;
  let first = '';
  let seen = 0;
  for (const raw of CASES) {
    const s = raw.normalize('NFKC');
    for (let i = 0; i < s.length; i += 1) {
      const cp = s.codePointAt(i);
      const want = NUM[LEX.classify(String.fromCodePoint(cp))];
      const got = LEX.clsAt(s, i);
      seen += 1;
      if (want !== got) {
        bad += 1;
        if (first === '') first = `${JSON.stringify(s.slice(Math.max(0, i - 4), i + 4))} @${i} U+${cp.toString(16)} want ${want} got ${got}`;
      }
    }
  }
  // 惰性表的第二只口子：先问过一次之后 clsCode 与 clsAt 必须同值（表建好前后不许有差）
  const SAME = ['a', 'Z', '中', 'ア', '6', ' ', '，', '𠀀', '😀', '\ud800', '\u200b', 'Ａ', 'ν'];
  for (const ch of SAME) {
    const a = LEX.clsCode(ch);
    const b = LEX.clsAt(ch, 0);
    if (a !== b) {
      bad += 1;
      if (first === '') first = `clsCode≠clsAt ${JSON.stringify(ch)} ${a}/${b}`;
    }
  }
  const miss = Object.keys(shape).filter((k) => !shape[k]);
  ok(
    'C9 按下标分类：tokenizeSegs 内层只读 charCodeAt 查表（不再造单字符/星外切片串），分类结果与正则尺子逐下标同值',
    LEX !== null && miss.length === 0 && bad === 0,
    LEX === null ? '词法段没切出来' : `${CASES.length} 串 · ${seen} 下标 · ${SAME.length} 码点对拍 · 0 不一致${miss.length === 0 ? '' : ` · 形状缺 ${miss.join(',')}`}${bad === 0 ? '' : ` · 首例 ${first}`}`,
  );
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} · probe-cold ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
