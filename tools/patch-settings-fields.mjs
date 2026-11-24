/**
 * 构建期补丁：把「注入与星图邻域」的旋钮搬进设置面板（0.6.42）。
 *
 * 为什么要有这一支：0.6.39 / 0.6.41 给引擎加了两个闸门（`injectFloor` 相关度闸、
 * `injectBodyMax` 单条正文上限），融合层本来就有四个邻域旋钮（`neighborInject` /
 * `neighborMax` / `neighborChars` / `neighborMinScore`）——六个都能改配置文件，
 * **但设置面板里一个都没有**：主人 2026-11-25 的原话是「长期记忆长度应该在设置里面
 * 加一个 user 可以自己调配的限制」。能力已经在了，用户却摸不到，等于没做。
 *
 * 为什么不手改 `vendor/meow-memory/lib/client.js`：那是 vendored 产物，上游一升级就
 * 被覆盖，而且 `vendor/VENDOR.json` 记着它的哈希。所以补丁写在构建里：`build.mjs`
 * 读进来 → 这份补丁按「确定的锚点、确定的次数」插进去 → 产出 `lib/client.js`。
 * 锚点少一处、多一处都直接抛错（`replaceN` 的做法），不静默放过。
 *
 * 补的是什么（三语 + 出厂值 + 字段表 + i18n 键清单）：
 *   1. 三份词典（en / zh / pt-br）各加 17 条：1 个分组标题 + 8 组 label/hint；
 *   2. `CONFIG_DEFAULTS` 加八个出厂值——设置页「恢复默认」写回的就是它们，
 *      所以它们必须与引擎 / 融合层的默认值逐个相等（`tools/probe-settings.mjs` 盯着）；
 *   3. `FIELDS` 的注入组补 `injectFloor` / `injectBodyMax` / `injectSessionBudget` /
 *      `injectRepeatSim`，并新开一组「星图邻域」；
 *   4. `UI_KEYS`（面板文案键清单）补齐，缺键的界面会显示成 raw key。
 *
 * [0.6.44] 注入组多了两个节奏旋钮：会话累计预算（默认 0 = 不限）与同话题抑制（默认 0.25）。
 * 前者就是主人 2026-11-25 说的那句「每次长期记忆注入要有限制，默认可以是没有限制」的
 * **整会话版本**——injectMaxChars 管单次，这个管一次会话一共花多少。
 */

/** 面板新增的字段（顺序即界面顺序）：key / type / 属于哪个分组。 */
export const NEW_FIELDS = [
  { key: 'injectFloor', type: 'num', group: 'inject' },
  { key: 'injectBodyMax', type: 'num', group: 'inject' },
  // 0.6.44：注入节奏两个旋钮——「一次会话一共允许多少字」与「同话题延续怎么判」。
  { key: 'injectSessionBudget', type: 'num', group: 'inject' },
  { key: 'injectRepeatSim', type: 'num', group: 'inject' },
  { key: 'neighborInject', type: 'bool', group: 'neighbor' },
  { key: 'neighborMax', type: 'num', group: 'neighbor' },
  { key: 'neighborChars', type: 'num', group: 'neighbor' },
  { key: 'neighborMinScore', type: 'num', group: 'neighbor' },
]

/** 三份词典要插的 13 条文案。zh 的写法在插进去时转成 \uXXXX（与包内既有风格一致）。 */
const TEXT = {
  en: [
    ['settings.group.neighbor', 'Graph neighbourhood'],
    ['settings.field.injectFloor.label', 'Hit relevance gate'],
    [
      'settings.field.injectFloor.hint',
      'Keyword hits scoring below this are not injected (0–1; 0 = gate off). 0.35 is the measured default: strong hits still come through, fragments that only share one word stay out.',
    ],
    ['settings.field.injectBodyMax.label', 'Per-entry body baseline'],
    [
      'settings.field.injectBodyMax.hint',
      'Baseline body characters per entry (0 = the whole entry). Rank decides the actual share each round: the most relevant hit gets twice the baseline, every later hit 60% of it. An over-long entry keeps its first sentence plus the one most relevant to the question and says how much was folded away — memory_read returns the full text.',
    ],
    ['settings.field.injectSessionBudget.label', 'Session injection budget'],
    [
      'settings.field.injectSessionBudget.hint',
      'Total characters of keyword-hit injection allowed across one session (0 = no limit). Once spent, no more hits are injected — the model can still memory_search what it needs.',
    ],
    ['settings.field.injectRepeatSim.label', 'Same-topic suppression'],
    [
      'settings.field.injectRepeatSim.hint',
      'When this turn’s wording overlaps the previous injection’s question this much (0–1; 1 = off, default 0.25), only hits clearly more relevant than last turn’s best are injected — follow-ups stop re-reading the same neighbourhood.',
    ],
    ['settings.field.neighborInject.label', 'Inject graph neighbourhood'],    [
      'settings.field.neighborInject.hint',
      "Each turn, append what this message is connected to in the graph. Off falls back to “no lookup unless the model asks”.",
    ],
    ['settings.field.neighborMax.label', 'Neighbours per turn'],
    ['settings.field.neighborMax.hint', 'Upper bound on neighbours appended per turn (0 = none).'],
    ['settings.field.neighborChars.label', 'Neighbourhood block characters'],
    [
      'settings.field.neighborChars.hint',
      'Character budget for the neighbourhood block, header and the path/mute guidance included.',
    ],
    ['settings.field.neighborMinScore.label', 'Neighbour strength floor'],
    [
      'settings.field.neighborMinScore.hint',
      'Neighbours weaker than this are dropped (0–1; measured default 0.35). A turn whose neighbours are all weak injects nothing rather than padding with noise.',
    ],
  ],
  zh: [
    ['settings.group.neighbor', '星图邻域'],
    ['settings.field.injectFloor.label', '命中相关度闸'],
    [
      'settings.field.injectFloor.hint',
      '关键词命中分数低于它的不注入（0–1，0＝关闸）。0.35 是实测默认值：强命中照旧进来，只沾一个词的碎片被挡在外面。',
    ],
    ['settings.field.injectBodyMax.label', '单条正文基准上限'],
    [
      'settings.field.injectBodyMax.hint',
      '单条记忆最多注入多少字的正文（0＝整条）。每轮按名次分配：最贴问的那条给两倍基准，其余各给六成。超长条目保留首句与最贴问的那一句，并自述折叠了多少字；要全文用 memory_read。',
    ],
    ['settings.field.injectSessionBudget.label', '会话注入预算'],
    [
      'settings.field.injectSessionBudget.hint',
      '一次会话里关键词命中注入一共允许多少字（0＝不限）。花完就不再注入，模型要什么可以自己 memory_search。',
    ],
    ['settings.field.injectRepeatSim.label', '同话题抑制'],
    [
      'settings.field.injectRepeatSim.hint',
      '这一轮的问句与上一次注入时的问句重合到这个程度（0–1，1＝关，默认 0.25），就只注入比上一轮最好那条明显更相关的条目——追问不再重复看同一批邻居。',
    ],
    ['settings.field.neighborInject.label', '每轮带星图邻域'],
    [
      'settings.field.neighborInject.hint',
      '每轮把「这句话在星图里连着谁」追加进上下文。关掉就退回「模型不查就没有」。',
    ],
    ['settings.field.neighborMax.label', '每轮邻居条数'],
    ['settings.field.neighborMax.hint', '每轮最多带几条邻居（0＝一条都不带）。'],
    ['settings.field.neighborChars.label', '邻域块字符上限'],
    ['settings.field.neighborChars.hint', '邻域那一块（含标题与「看路径 / 断边」指引）最多多少字符。'],
    ['settings.field.neighborMinScore.label', '邻居强度下限'],
    [
      'settings.field.neighborMinScore.hint',
      '强度低于它的邻居不注入（0–1，实测默认 0.35）；整批都弱就一条都不带，不拿噪声凑数。',
    ],
  ],
  'pt-br': [
    ['settings.group.neighbor', 'Vizinhança do grafo'],
    ['settings.field.injectFloor.label', 'Limiar de relevância dos acertos'],
    [
      'settings.field.injectFloor.hint',
      'Acertos por palavra-chave abaixo deste valor não são injetados (0–1; 0 = desligado). 0,35 é o padrão medido: acertos fortes continuam passando, fragmentos que só compartilham uma palavra ficam de fora.',
    ],
    ['settings.field.injectBodyMax.label', 'Base de corpo por entrada'],
    [
      'settings.field.injectBodyMax.hint',
      'Base de caracteres de corpo por entrada (0 = a entrada inteira). A divisão por posição define a cota de cada rodada: a entrada mais relevante recebe o dobro da base, as demais 60% dela. Uma entrada longa mantém a primeira frase e a mais relevante para a pergunta, e informa quanto foi omitido — memory_read traz o texto completo.',
    ],
    ['settings.field.injectSessionBudget.label', 'Orçamento de injeção por sessão'],
    [
      'settings.field.injectSessionBudget.hint',
      'Total de caracteres de injeção por acerto de palavra-chave permitido em uma sessão (0 = sem limite). Esgotado, nada mais é injetado — o modelo ainda pode usar memory_search.',
    ],
    ['settings.field.injectRepeatSim.label', 'Supressão de mesmo assunto'],
    [
      'settings.field.injectRepeatSim.hint',
      'Quando a frase deste turno se sobrepõe à pergunta da injeção anterior neste grau (0–1; 1 = desligado, padrão 0,25), só entram acertos claramente mais relevantes que o melhor do turno anterior.',
    ],
    ['settings.field.neighborInject.label', 'Injetar vizinhança do grafo'],
    [
      'settings.field.neighborInject.hint',
      'A cada turno, anexa o que esta mensagem conecta no grafo. Desligado volta a “sem consulta, a menos que o modelo peça”.',
    ],
    ['settings.field.neighborMax.label', 'Vizinhos por turno'],
    ['settings.field.neighborMax.hint', 'Máximo de vizinhos anexados por turno (0 = nenhum).'],
    ['settings.field.neighborChars.label', 'Caracteres do bloco de vizinhança'],
    [
      'settings.field.neighborChars.hint',
      'Orçamento de caracteres do bloco de vizinhança, incluindo cabeçalho e a orientação de path/mute.',
    ],
    ['settings.field.neighborMinScore.label', 'Piso de força do vizinho'],
    [
      'settings.field.neighborMinScore.hint',
      'Vizinhos mais fracos que isto são descartados (0–1; padrão medido 0,35). Turnos só com vizinhos fracos não injetam nada em vez de encher com ruído.',
    ],
  ],
}

/** 出厂值：必须与引擎 / 融合层的默认值逐个相等（探针盯着）。 */
const DEFAULTS_BLOCK = `  /** 0.6.42：两个注入闸门的出厂值＝引擎默认（0.35 / 240 字），「恢复默认」写回它们（0.6.45 把闸门从 0.45 降到 0.35）。 */
  injectFloor: 0.35,
  injectBodyMax: 240,
  /** 0.6.44：注入节奏两个旋钮的出厂值＝引擎默认（0＝会话累计不限；0.25＝同话题抑制生效）。 */
  injectSessionBudget: 0,
  injectRepeatSim: 0.25,
  /** 0.6.42：星图邻域四个旋钮的出厂值＝融合层默认（lib/macro/neighbor.js）。 */
  neighborInject: true,
  neighborMax: 4,
  neighborChars: 420,
  neighborMinScore: 0.35,`

const FIELDS_BLOCK = `,
      { key: "injectFloor", label: "settings.field.injectFloor.label", type: "num", hint: "settings.field.injectFloor.hint" },
      { key: "injectBodyMax", label: "settings.field.injectBodyMax.label", type: "num", hint: "settings.field.injectBodyMax.hint" },
      { key: "injectSessionBudget", label: "settings.field.injectSessionBudget.label", type: "num", hint: "settings.field.injectSessionBudget.hint" },
      { key: "injectRepeatSim", label: "settings.field.injectRepeatSim.label", type: "num", hint: "settings.field.injectRepeatSim.hint" }`

const GROUP_BLOCK = `  {
    title: "settings.group.neighbor",
    fields: [
      { key: "neighborInject", label: "settings.field.neighborInject.label", type: "bool", hint: "settings.field.neighborInject.hint" },
      { key: "neighborMax", label: "settings.field.neighborMax.label", type: "num", hint: "settings.field.neighborMax.hint" },
      { key: "neighborChars", label: "settings.field.neighborChars.label", type: "num", hint: "settings.field.neighborChars.hint" },
      { key: "neighborMinScore", label: "settings.field.neighborMinScore.label", type: "num", hint: "settings.field.neighborMinScore.hint" }
    ]
  },
`

/** 把一段中文转成包内既有的 \uXXXX 转义写法（ASCII 原样保留）。 */
export function escZh(text) {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code > 0x7e) out += '\\u' + code.toString(16).toUpperCase().padStart(4, '0')
    else out += ch
  }
  return out
}

/** 数一数锚点出现几次：既不是 1 也不是期望值就抛错（宁可构建失败，也不要静默少插一段）。 */
function expect(hay, needle, count) {
  let n = 0
  let at = hay.indexOf(needle)
  while (at >= 0) {
    n += 1
    at = hay.indexOf(needle, at + needle.length)
  }
  if (n !== count) throw new Error(`build: 锚点出现 ${n} 次（期望 ${count}）：${JSON.stringify(needle.slice(0, 80))}`)
}

/**
 * 按语言把 13 条文案插进对应的词典：锚点是三份词典里都有的
 * `"settings.field.injectMaxChars.hint": ` 那一行，出现顺序就是 en / zh / pt-br。
 *
 * @param {string} text meow 子层 bundle 全文。
 * @returns {string}
 */
function patchDicts(text) {
  const anchor = '"settings.field.injectMaxChars.hint": '
  expect(text, anchor, 3)
  const lines = text.split('\n')
  const ins = []
  let seen = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith('  ' + anchor)) continue
    const lang = ['en', 'zh', 'pt-br'][seen]
    seen += 1
    if (lang === undefined) throw new Error('build: 词典锚点超过三处')
    const body = TEXT[lang]
      .map(([key, value]) =>
        // zh 走 \uXXXX 转义时**不能**再过一遍 JSON.stringify：那会把反斜杠自己转义成
        // `\\u661F`，浏览器拿到的是六个字符而不是一个字。所以这里手拼引号。
        lang === 'zh'
          ? `  ${JSON.stringify(key)}: "${escZh(value)}",`
          : `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`,
      )
      .join('\n')
    ins.push({ at: i + 1, body })
  }
  if (seen !== 3) throw new Error(`build: 只认到 ${seen} 份词典`)
  for (const { at, body } of ins.reverse()) lines.splice(at, 0, body)
  return lines.join('\n')
}

/**
 * 给 meow 子层 bundle 打上 0.6.42 的四个补丁。
 *
 * @param {string} text meow 子层 bundle 全文。
 * @returns {string}
 */
export function applySettingsFields(text) {
  let out = text

  // 1) 三份词典（先做：它按行号插入，越早越不容易被后续替换打乱）。
  out = patchDicts(out)

  // 2) 出厂值。
  const defaultsAnchor = '  injectMaxChars: 0,'
  expect(out, defaultsAnchor, 1)
  out = out.replace(defaultsAnchor, defaultsAnchor + '\n' + DEFAULTS_BLOCK)

  // 3) 注入组补两个字段。
  const fieldAnchor =
    '      { key: "injectMaxChars", label: "settings.field.injectMaxChars.label", type: "num", hint: "settings.field.injectMaxChars.hint" }'
  expect(out, fieldAnchor, 1)
  out = out.replace(fieldAnchor, fieldAnchor + FIELDS_BLOCK)

  // 4) 新开「星图邻域」一组，插在「反思」组**前面**（顺序：注入 → 邻域 → 反思）。
  //    锚点必须带上前一行那个 `{`：只锚 `title:` 会把新组插进旧组的对象体里，
  //    产出一段语法错误的 bundle（0.6.42 首跑就这么炸过一次，check-client-bundle 没抓到，
  //    probe-client-ui 一执行 bundle 就报 Unexpected token '{'）。
  const groupAnchor = '  {\n    title: "settings.group.reflect",'
  expect(out, groupAnchor, 1)
  out = out.replace(groupAnchor, GROUP_BLOCK + groupAnchor)

  // 5) 面板文案键清单。
  const keyAnchor = '  "settings.field.injectMaxChars.hint",'
  expect(out, keyAnchor, 1)
  const keys = [
    ...new Set(['settings.group.neighbor', ...NEW_FIELDS.flatMap((f) => [`settings.field.${f.key}.label`, `settings.field.${f.key}.hint`])]),
  ]
    .map((k) => `  ${JSON.stringify(k)},`)
    .join('\n')
  out = out.replace(keyAnchor, keyAnchor + '\n' + keys)

  return out
}
