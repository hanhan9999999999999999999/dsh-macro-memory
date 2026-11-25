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
  // 0.6.60：问句降档——真问句分数系统性低于祈使句，按闸门 × 本系数判。
  { key: 'injectQuestionFloor', type: 'num', group: 'inject' },
  { key: 'injectBodyMax', type: 'num', group: 'inject' },
  // 0.6.44：注入节奏两个旋钮——「一次会话一共允许多少字」与「同话题延续怎么判」。
  { key: 'injectSessionBudget', type: 'num', group: 'inject' },
  { key: 'injectRepeatSim', type: 'num', group: 'inject' },
  // 0.6.49：本会话给过的条目隔多少轮又能重新进候选。
  { key: 'injectReinjectTurns', type: 'num', group: 'inject' },
  // 0.6.55：一轮总上限——命中 + 邻域一起算的「每次注入一共多少字」。
  { key: 'injectTurnMaxChars', type: 'num', group: 'inject' },
  { key: 'neighborInject', type: 'bool', group: 'neighbor' },
  { key: 'neighborMax', type: 'num', group: 'neighbor' },
  { key: 'neighborChars', type: 'num', group: 'neighbor' },
  { key: 'neighborMinScore', type: 'num', group: 'neighbor' },
  { key: 'neighborSuspectTurns', type: 'num', group: 'neighbor' },
  // 0.6.62：边缘单条隔轮带——一块里只剩一条弱邻居时带一轮、休一轮。
  { key: 'neighborSoloEdge', type: 'num', group: 'neighbor' },
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
    ['settings.field.injectQuestionFloor.label', 'Question-mode gate'],
    [
      'settings.field.injectQuestionFloor.hint',
      'Questions (怎么 / 为什么 / 哪里 / how / why…) are judged by the gate above × this ratio (0–1; 1 = off). Measured default 0.6: a real question such as “git push 在 pwsh 里卡住怎么办” scores 0.26–0.29 and the plain 0.35 gate keeps it out, while an imperative of the same score (提交并推送) still stays out.',
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
    ['settings.field.injectReinjectTurns.label', 'Re-offer after turns'],
    [
      'settings.field.injectReinjectTurns.hint',
      'Entries already given in this session stay out of the candidates for this many turns (0 = never re-offer). Past that, a memory you were shown earlier can come back when it is again the best match — long sessions where the topic returns stop coming up empty. Default 12.',
    ],
    ['settings.field.injectTurnMaxChars.label', 'Per-turn injection cap'],
    [
      'settings.field.injectTurnMaxChars.hint',
      'Total characters of long-term memory injected into one turn (0 = no limit). Keyword hits spend first and the graph neighbourhood uses what is left; if the remainder cannot fit a useful block, no neighbours are injected that turn. This is a third account on top of the per-hit and per-session caps above.',
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
    ['settings.field.neighborSuspectTurns.label', 'Hold mis-edged neighbours'],
    [
      'settings.field.neighborSuspectTurns.hint',
      'An edge flagged as unrelated for this many turns in a row is left out of the neighbourhood block (0 = off, default 3). The graph is not touched and the ledger is kept: mute it with the nebula_link tool and the edge is cleared on the spot; if nothing is done, it comes back after three quiet turns.',
    ],
    ['settings.field.neighborSoloEdge.label', 'Alternate weak lone neighbours'],
    [
      'settings.field.neighborSoloEdge.hint',
      'A block holding a single neighbour below this strength (0–1, default 0.55, 0 = off) is treated as a faint side hint and injected every other turn. Measured on the real library: lone neighbours between 0.35 and 0.55 turn up on most operational turns — about 190 characters for one loosely related link — while a lone neighbour at 0.68+ is a real lead and keeps coming every turn. The same neighbour never repeats anyway (per-session ledger), so what is saved is the fresh weak one.',
    ],
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
    ['settings.field.injectQuestionFloor.label', '问句降档系数'],
    [
      'settings.field.injectQuestionFloor.hint',
      '带「怎么／为什么／哪里／如何」这类疑问词的问句，按上一项闸门 × 本系数 判（0–1，1＝关）。默认 0.6：实测「git push 在 pwsh 里卡住怎么办」这类真问句分数 0.26–0.29，被 0.35 挡在门外；同样分数的祈使句（提交并推送）照旧挡住。',
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
    ['settings.field.injectReinjectTurns.label', '会话内重新进候选'],
    [
      'settings.field.injectReinjectTurns.hint',
      '本会话已经给过的条目，隔多少轮之后可以重新进候选（0＝永不放回，默认 12）。超过这个轮数，以前给过的条目如果又是最贴问的，会再给一遍——长会话里话题绕回来时不至于空着；旧条目本来就在上下文里，多给一遍只是多花字，不给是直接丢能力。',
    ],
    ['settings.field.injectTurnMaxChars.label', '每轮注入总上限'],
    [
      'settings.field.injectTurnMaxChars.hint',
      '一轮里长期记忆一共允许多少字（0＝不限）。命中注入先花，星图邻域只能花剩下的；剩下的不够开一块，这轮就一条邻居都不带。这是压在「单次命中上限」「会话预算」之上的第三层总账。',
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
    ['settings.field.neighborSuspectTurns.label', '错边先不带'],
    [
      'settings.field.neighborSuspectTurns.hint',
      '一跳连着这么多轮被标「未沾词」就先不带（0＝关，默认 3）。图不动、账留着：确认无关就用 nebula_link 的 mute 断掉（a、b 写两端 id），当场销账；不理它则三轮后自动放回。',
    ],
    ['settings.field.neighborSoloEdge.label', '边缘单条隔轮带'],
    [
      'settings.field.neighborSoloEdge.hint',
      '一块里只剩一条邻居、强度又低于这个值（0–1，默认 0.55，0＝关），就按边缘线索处理：带一轮、休一轮。实测真库上 0.35–0.55 的单条占操作型轮次的一大半，每块约 190 字只换来一句「沾一个词」的横向线索；0.68 以上那种单条是真线索，照旧每轮带。同一条邻居本来就不会重复带（会话账），这里省的只是新来的弱邻居。',
    ],
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
    ['settings.field.injectQuestionFloor.label', 'Fator do limiar para perguntas'],
    [
      'settings.field.injectQuestionFloor.hint',
      'Perguntas (怎么 / 为什么 / 哪里 / how / why…) são julgadas por limiar × este fator (0–1; 1 = desligado). Padrão medido 0,6: uma pergunta real como “git push 在 pwsh 里卡住怎么办” fica em 0,26–0,29 e o limiar 0,35 a barra, enquanto um imperativo de mesma pontuação (提交并推送) continua barrado.',
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
    ['settings.field.injectReinjectTurns.label', 'Reoferecer após turnos'],
    [
      'settings.field.injectReinjectTurns.hint',
      'Entradas já dadas nesta sessão ficam fora dos candidatos por este número de turnos (0 = nunca reoferecer, padrão 12). Passado isso, uma memória mostrada antes volta quando é de novo a mais relevante — sessões longas em que o assunto retorna deixam de ficar vazias.',
    ],
    ['settings.field.injectTurnMaxChars.label', 'Teto de injeção por turno'],
    [
      'settings.field.injectTurnMaxChars.hint',
      'Total de caracteres de memória de longo prazo injetados em um turno (0 = sem limite). Os acertos por palavra-chave gastam primeiro e a vizinhança do grafo usa o que sobra; se o resto não couber um bloco útil, nenhum vizinho entra neste turno. É a terceira conta, acima dos tetos por acerto e por sessão.',
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
    ['settings.field.neighborSuspectTurns.label', 'Reter arestas suspeitas'],
    [
      'settings.field.neighborSuspectTurns.hint',
      'Uma aresta marcada como sem termo em comum por este número de turnos seguidos fica fora do bloco de vizinhança (0 = desligado, padrão 3). O grafo não muda e o registro fica: use o mute do nebula_link e a aresta é removida na hora; sem ação, ela volta depois de três turnos calmos.',
    ],
    ['settings.field.neighborSoloEdge.label', 'Alternar vizinho fraco isolado'],
    [
      'settings.field.neighborSoloEdge.hint',
      'Um bloco com um único vizinho abaixo desta força (0–1, padrão 0,55, 0 = desligado) conta como pista lateral fraca e entra a cada dois turnos. Medido na biblioteca real: vizinhos isolados entre 0,35 e 0,55 aparecem na maioria dos turnos operacionais — cerca de 190 caracteres por um elo frouxo — enquanto um vizinho isolado de 0,68+ é pista de verdade e continua entrando sempre. O mesmo vizinho nunca se repete (registro da sessão), então o que se economiza é o vizinho fraco novo.',
    ],
    [
      'settings.field.neighborMinScore.hint',
      'Vizinhos mais fracos que isto são descartados (0–1; padrão medido 0,35). Turnos só com vizinhos fracos não injetam nada em vez de encher com ruído.',
    ],
  ],
}

/** 出厂值：必须与引擎 / 融合层的默认值逐个相等（探针盯着）。 */
const DEFAULTS_BLOCK = `  /** 0.6.42：两个注入闸门的出厂值＝引擎默认（0.35 / 240 字），「恢复默认」写回它们（0.6.45 把闸门从 0.45 降到 0.35）。 */
  injectFloor: 0.35,
  /** 0.6.60：问句降档系数＝引擎默认 INJECT_QUESTION_FLOOR_RATIO（真问句 0.26–0.29 才进得来）。 */
  injectQuestionFloor: 0.6,
  injectBodyMax: 240,
  /** 0.6.44：注入节奏两个旋钮的出厂值＝引擎默认（0＝会话累计不限；0.25＝同话题抑制生效）。 */
  injectSessionBudget: 0,
  injectRepeatSim: 0.25,
  /** 0.6.49：本会话给过的条目隔 12 轮又能重新进候选（＝引擎默认 INJECT_REINJECT_TURNS_DEF）。 */
  injectReinjectTurns: 12,
  /** 0.6.55：一轮总上限的出厂值＝融合层默认 NEIGHBOR_TURN_MAX_CHARS（0＝不限）。 */
  injectTurnMaxChars: 0,
  /** 0.6.42：星图邻域四个旋钮的出厂值＝融合层默认（lib/macro/neighbor.js）。 */
  neighborInject: true,
  neighborMax: 4,
  neighborChars: 420,
  neighborMinScore: 0.35,
  /** 0.6.54：错边连标 3 轮先不带（＝融合层默认 NEIGHBOR_SUSPECT_TURNS）。 */
  neighborSuspectTurns: 3,
  /** 0.6.62：边缘单条隔轮带（＝融合层默认 NEIGHBOR_SOLO_EDGE_SCORE；0＝关）。 */
  neighborSoloEdge: 0.55,`

const FIELDS_BLOCK = `,
      { key: "injectFloor", label: "settings.field.injectFloor.label", type: "num", hint: "settings.field.injectFloor.hint" },
      { key: "injectQuestionFloor", label: "settings.field.injectQuestionFloor.label", type: "num", hint: "settings.field.injectQuestionFloor.hint" },
      { key: "injectBodyMax", label: "settings.field.injectBodyMax.label", type: "num", hint: "settings.field.injectBodyMax.hint" },
      { key: "injectSessionBudget", label: "settings.field.injectSessionBudget.label", type: "num", hint: "settings.field.injectSessionBudget.hint" },
      { key: "injectRepeatSim", label: "settings.field.injectRepeatSim.label", type: "num", hint: "settings.field.injectRepeatSim.hint" },
      { key: "injectReinjectTurns", label: "settings.field.injectReinjectTurns.label", type: "num", hint: "settings.field.injectReinjectTurns.hint" },
      { key: "injectTurnMaxChars", label: "settings.field.injectTurnMaxChars.label", type: "num", hint: "settings.field.injectTurnMaxChars.hint" }`

const GROUP_BLOCK = `  {
    title: "settings.group.neighbor",
    fields: [
      { key: "neighborInject", label: "settings.field.neighborInject.label", type: "bool", hint: "settings.field.neighborInject.hint" },
      { key: "neighborMax", label: "settings.field.neighborMax.label", type: "num", hint: "settings.field.neighborMax.hint" },
      { key: "neighborChars", label: "settings.field.neighborChars.label", type: "num", hint: "settings.field.neighborChars.hint" },
      { key: "neighborMinScore", label: "settings.field.neighborMinScore.label", type: "num", hint: "settings.field.neighborMinScore.hint" },
      { key: "neighborSuspectTurns", label: "settings.field.neighborSuspectTurns.label", type: "num", hint: "settings.field.neighborSuspectTurns.hint" },
      { key: "neighborSoloEdge", label: "settings.field.neighborSoloEdge.label", type: "num", hint: "settings.field.neighborSoloEdge.hint" }
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
