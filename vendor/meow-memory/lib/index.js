// src/index.ts
import { boundContextSummary, createUserMessage as createUserMessage3 } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { appendFileSync as appendFileSync2, existsSync as existsSync9, mkdirSync as mkdirSync6, readFileSync as readFileSync8, renameSync as renameSync6, statSync as statSync3, unlinkSync, writeFileSync as writeFileSync5 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { dirname as dirname6, join as join9 } from "node:path";

// src/db.ts
import { randomUUID } from "node:crypto";
import { existsSync as existsSync4, mkdirSync as mkdirSync3, renameSync as renameSync3, statSync } from "node:fs";
import { dirname as dirname3, join as join4 } from "node:path";
import { DatabaseSync } from "node:sqlite";

// src/prompt-loader.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { join as join2, dirname as dirname2 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/home-dir.ts
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
var DEFAULT_HOME_DIR = join(homedir(), ".dsh-meow");
function envHomeDir() {
  const v = process.env.MEOW_MEMORY_HOME?.trim();
  if (v === void 0 || v === "") return void 0;
  const r = resolve(v);
  if (r === dirname(r) || r === resolve(homedir())) return void 0;
  return r;
}
function homePointerFile() {
  return join(dshHomeDir(), "storages", "meow-memory-home.json");
}
function readHomePointer() {
  try {
    const parsed = JSON.parse(readFileSync(homePointerFile(), "utf8"));
    if (typeof parsed.homeDir !== "string") return void 0;
    const r = resolve(parsed.homeDir.trim());
    if (!isAbsolute(r) || r === dirname(r) || r === resolve(homedir()) || !existsSync(r)) return void 0;
    return r;
  } catch {
    return void 0;
  }
}
function fallbackHomeDir() {
  return envHomeDir() ?? readHomePointer() ?? DEFAULT_HOME_DIR;
}
var active = fallbackHomeDir();
function activeHomeDir() {
  return active;
}
function setActiveHomeDir(dir) {
  active = dir;
}
function dshHomeDir() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}
function pluginRootDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}
function homeDirPresets() {
  return {
    default: DEFAULT_HOME_DIR,
    "dsh-storage": join(dshHomeDir(), "storages", "meow-memory"),
    "plugin-root": join(pluginRootDir(), "storage")
  };
}
function resolveHomeDir(value) {
  if (typeof value !== "string") return fallbackHomeDir();
  const v = value.trim();
  if (v === "" || v === "default") return fallbackHomeDir();
  if (v === "dsh-storage" || v === "plugin-root") return homeDirPresets()[v];
  if (!isAbsolute(v)) return fallbackHomeDir();
  const r = resolve(v);
  if (r === dirname(r)) return fallbackHomeDir();
  if (r === resolve(homedir())) return fallbackHomeDir();
  return r;
}
function countFiles(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(join(dir, e.name));
    else n++;
  }
  return n;
}
function switchHomeDir(target, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const from = active;
  const to = resolve(target);
  if (to === from) return { changed: false, migrated: false, mode: "same", files: 0, from, to };
  try {
    if (existsSync(to) && readdirSync(to).length > 0) {
      active = to;
      return { changed: true, migrated: false, mode: "reused-nonempty", files: 0, from, to };
    }
    let files = 0;
    try {
      files = countFiles(from);
    } catch {
    }
    if (existsSync(to)) {
      try {
        rmdirSync(to);
      } catch {
      }
    }
    let mode = "copy";
    if (!existsSync(to)) {
      mkdirSync(dirname(to), { recursive: true });
      try {
        renameSync(from, to);
        mode = "rename";
      } catch {
      }
    }
    if (mode === "copy") {
      mkdirSync(to, { recursive: true });
      cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
    }
    active = to;
    try {
      const ptr = homePointerFile();
      if (isAbsolute(ptr)) {
        mkdirSync(dirname(ptr), { recursive: true });
        writeFileSync(
          ptr,
          JSON.stringify({ homeDir: to, migratedFrom: from, migratedAt: now, mode, files }, null, 1),
          "utf8"
        );
      }
    } catch {
    }
    try {
      writeFileSync(
        join(to, "home-dir.json"),
        JSON.stringify({ migratedFrom: from, migratedAt: now, mode, files }, null, 1),
        "utf8"
      );
    } catch {
    }
    return { changed: true, migrated: true, mode, files, from, to };
  } catch (e) {
    return {
      changed: false,
      migrated: false,
      mode: "failed",
      files: 0,
      from,
      to,
      error: e instanceof Error ? e.message : String(e)
    };
  }
}

// src/prompt-loader.ts
var PROMPTS_DIR = join2(dirname2(fileURLToPath2(import.meta.url)), "prompts");
function overrideDir() {
  return join2(activeHomeDir(), "prompts");
}
var DEFAULT_LANG = "zh";
var currentLang = DEFAULT_LANG;
function setPromptLang(lang) {
  currentLang = lang;
}
function getPromptLang() {
  return currentLang;
}
var SLOTS = [
  "system-guide",
  "reflect",
  "dream-header",
  "dream-atomic",
  "dream-topic",
  "dream-project-summary",
  "welcome-guide",
  "first-create-notice",
  "external-memory-notice",
  "labels",
  "tools"
];
var SLOT_PARAMS = {
  reflect: ["projectList"],
  "dream-header": ["timestamp", "idx", "total", "roundKind"],
  "dream-topic": ["list"],
  "dream-project-summary": ["projects"],
  "welcome-guide": ["homePath"]
};
function readSlotFile(slot, lang) {
  const read = (p) => readFileSync2(p, "utf8").replace(/\s+$/, "").replace(/\\_/g, "_");
  const override = join2(overrideDir(), lang, `${slot}.md`);
  if (existsSync2(override)) return read(override);
  if (lang !== DEFAULT_LANG) {
    const primary = join2(PROMPTS_DIR, lang, `${slot}.md`);
    if (existsSync2(primary)) return read(primary);
  }
  return read(join2(PROMPTS_DIR, DEFAULT_LANG, `${slot}.md`));
}
function fillTemplate(text, params = {}) {
  let out = text;
  for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{${k}}`, () => v);
  return out;
}
function parseKeyValueText(text) {
  const map = /* @__PURE__ */ new Map();
  let cur = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("- ")) {
      const sep = line.indexOf(": ");
      if (sep > 2) {
        cur = line.slice(2, sep);
        map.set(cur, line.slice(sep + 2));
        continue;
      }
    }
    if (cur !== null && line.startsWith("  ") && line.trim().length > 0) {
      map.set(cur, `${map.get(cur)}
${line.trimStart()}`);
    }
  }
  return map;
}
function resolveSlotText(slot, params = {}, lang = getPromptLang()) {
  const required = SLOT_PARAMS[slot] ?? [];
  for (const p of required) {
    if (!(p in params)) throw new Error(`[meow-memory] \u69FD\u4F4D ${slot} \u7F3A\u5C11\u5FC5\u9700\u5360\u4F4D\u7B26 {${p}}`);
  }
  return fillTemplate(readSlotFile(slot, lang), params);
}
function keyedValue(slot, key, lang = getPromptLang()) {
  const v = resolveKeyedText(slot, lang).get(key);
  if (v === void 0) throw new Error(`[meow-memory] prompt \u6587\u6848\u7F3A\u5931\uFF1A${slot}.md \u7684 "${key}"`);
  return v;
}
function resolveKeyedText(slot, lang = getPromptLang()) {
  return parseKeyValueText(readSlotFile(slot, lang));
}

// src/trust.ts
import { createHash } from "node:crypto";
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync3, readdirSync as readdirSync2, renameSync as renameSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
function normalizeWorkspacePath(p) {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
var markersDir = null;
function enableWorkspaceTrust(homeDir = activeHomeDir()) {
  const dir = join3(homeDir, "trusted-workspaces");
  try {
    mkdirSync2(dir, { recursive: true });
    markersDir = dir;
  } catch {
    markersDir = null;
  }
}
function disableWorkspaceTrust() {
  markersDir = null;
}
function markerPath(ws) {
  const hash = createHash("sha256").update(normalizeWorkspacePath(ws)).digest("hex");
  return join3(markersDir, `${hash}.json`);
}
function readMarker(ws) {
  try {
    const parsed = JSON.parse(readFileSync3(markerPath(ws), "utf8"));
    if (parsed === null || typeof parsed !== "object" || typeof parsed.path !== "string") return void 0;
    return parsed;
  } catch {
    return void 0;
  }
}
function writeMarker(ws, marker) {
  const target = markerPath(ws);
  const tmp = `${target}.tmp`;
  writeFileSync2(tmp, JSON.stringify(marker, null, 1), "utf8");
  renameSync2(tmp, target);
}
function isTrustedWorkspace(ws) {
  if (markersDir === null) return true;
  const marker = readMarker(ws);
  return marker !== void 0 && typeof marker.trustedAt === "number";
}
function isUntrustedMemoryWorkspace(ws) {
  return !isTrustedWorkspace(ws);
}
function trustWorkspace(ws, source = "meow-trust") {
  if (markersDir === null) return false;
  try {
    const existing = readMarker(ws);
    if (existing !== void 0 && typeof existing.trustedAt === "number") return true;
    writeMarker(ws, { ...existing, path: ws, trustedAt: Date.now(), trustedSource: source });
    return true;
  } catch {
    return false;
  }
}
var CREATION_DIR_IGNORE = /* @__PURE__ */ new Set(["memory.db", "memory.db-wal", "memory.db-shm", "memory.db.tmp", "dream-debug.log"]);
function registerCreatedWorkspace(workspace, dir) {
  if (markersDir === null) return;
  if (isTrustedWorkspace(workspace)) return;
  try {
    const dirPath = join3(workspace, dir);
    if (existsSync3(dirPath)) {
      for (const entry of readdirSync2(dirPath)) {
        if (!CREATION_DIR_IGNORE.has(entry)) return;
      }
    }
    trustWorkspace(workspace, "created-empty");
  } catch {
  }
}
function hasExternalNoticeShown(ws) {
  if (markersDir === null) return true;
  return typeof readMarker(ws)?.noticedAt === "number";
}
function markExternalNoticeShown(ws) {
  if (markersDir === null) return;
  try {
    const existing = readMarker(ws);
    if (existing === void 0) {
      writeMarker(ws, { path: ws, noticedAt: Date.now() });
    } else if (typeof existing.noticedAt !== "number") {
      writeMarker(ws, { ...existing, noticedAt: Date.now() });
    }
  } catch {
  }
}
function seedTrustedWorkspaces(indexFile = join3(activeHomeDir(), "window-index.json")) {
  if (markersDir === null) return { trusted: 0, listed: 0 };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync3(indexFile, "utf8"));
  } catch {
    return { trusted: 0, listed: 0 };
  }
  if (parsed === null || typeof parsed !== "object") return { trusted: 0, listed: 0 };
  const workspaces = /* @__PURE__ */ new Set();
  for (const ws of Object.values(parsed)) {
    if (typeof ws === "string" && ws.length > 0) workspaces.add(ws);
  }
  let trusted = 0;
  for (const ws of workspaces) {
    if (trustWorkspace(ws, "window-index-seed")) trusted += 1;
  }
  return { trusted, listed: workspaces.size };
}
function trustCommandDefinition() {
  return {
    name: "meow-trust",
    description: "\u4FE1\u4EFB\u5F53\u524D\u5DE5\u4F5C\u533A\u81EA\u5E26\u7684\u8BB0\u5FC6\u5E93\uFF08.dsh-meow \u975E\u672C\u673A\u521B\u5EFA\u65F6,meow-memory \u4F1A\u6682\u505C\u6CE8\u5165/\u68C0\u7D22/\u6574\u7406;\u6267\u884C\u672C\u547D\u4EE4\u6062\u590D,\u5373\u523B\u751F\u6548,\u65E0\u9700\u91CD\u542F\uFF09\u3002",
    handler(invocation) {
      const agent = invocation?.agent;
      const cwd = agent?.session?.header?.cwd;
      if (typeof cwd !== "string" || cwd.length === 0) {
        return { kind: "error", text: "/meow-trust \u65E0\u6CD5\u786E\u5B9A\u5F53\u524D\u7A97\u53E3\u7684\u5DE5\u4F5C\u533A\uFF08\u4F1A\u8BDD\u65E0 cwd\uFF09\u3002" };
      }
      if (markersDir === null) {
        return { kind: "error", text: "/meow-trust \u4E0D\u53EF\u7528\uFF1A\u4FE1\u4EFB\u95E8\u672A\u542F\u7528\uFF08\u672C\u5B9E\u4F8B\u672A\u5B8C\u6210\u88C5\u914D\uFF09\u3002" };
      }
      if (isTrustedWorkspace(cwd)) return { kind: "success", text: "\u6B64\u5DE5\u4F5C\u533A\u7684\u8BB0\u5FC6\u5E93\u5DF2\u5728\u4FE1\u4EFB\u540D\u5355\u4E2D\uFF0C\u65E0\u9700\u91CD\u590D\u4FE1\u4EFB\u3002" };
      const ok = trustWorkspace(cwd, "meow-trust");
      return ok ? { kind: "success", text: "\u5DF2\u4FE1\u4EFB\u6B64\u5DE5\u4F5C\u533A\u7684\u8BB0\u5FC6\u5E93\uFF1A\u6CE8\u5165 / \u68C0\u7D22 / \u6574\u7406 / \u5199\u5165\u5373\u523B\u6062\u590D\uFF0C\u65E0\u9700\u91CD\u542F\u3002" } : { kind: "error", text: "/meow-trust \u5199\u5165\u4FE1\u4EFB\u6CE8\u518C\u8868\u5931\u8D25\uFF08\u5168\u5C40\u76EE\u5F55\u4E0D\u53EF\u5199\uFF1F\uFF09\uFF0C\u8BF7\u68C0\u67E5 meow-memory \u5168\u5C40\u76EE\u5F55\u6743\u9650\u3002" };
    }
  };
}

// src/db.ts
var LEVELS = ["soul", "user", "project", "fact", "lesson", "topic", "rules"];
var PROJECT_SUBCATEGORIES = ["overview", "structure", "decisions", "quotes", "ops", "todo"];
var lbl = (key, params) => fillTemplate(keyedValue("labels", key), params);
function relativeTime(ms) {
  if (!ms) return lbl("time.none");
  const diff = Date.now() - ms;
  if (diff < 6e4) return lbl("time.justNow");
  if (diff < 36e5) return lbl("time.minutes", { n: String(Math.floor(diff / 6e4)) });
  if (diff < 864e5) return lbl("time.hours", { n: String(Math.floor(diff / 36e5)) });
  if (diff < 30 * 864e5) return lbl("time.days", { n: String(Math.floor(diff / 864e5)) });
  return new Date(ms).toISOString().slice(0, 10);
}
var GLOBAL_PROJECT_CANON = "\u5168\u5C40";
var markerCache = null;
function globalProjectMarker() {
  const lang = getPromptLang();
  if (markerCache !== null && markerCache.lang === lang) return markerCache.marker;
  let marker;
  try {
    marker = lbl("project.global");
  } catch {
    marker = GLOBAL_PROJECT_CANON;
  }
  markerCache = { lang, marker };
  return marker;
}
var GLOBAL_PROJECT_CANON_EN = "global";
function isGlobalProject(field) {
  if (field === null) return false;
  const trimmed = field.trim();
  if (trimmed === GLOBAL_PROJECT_CANON) return true;
  if (trimmed.toLowerCase() === GLOBAL_PROJECT_CANON_EN) return true;
  return trimmed.toLowerCase() === globalProjectMarker().toLowerCase();
}
function isGlobalScope(field) {
  if (field === null) return true;
  const trimmed = field.trim();
  return trimmed === "" || isGlobalProject(trimmed);
}
function projectList(field) {
  if (!field || isGlobalProject(field)) return [];
  return field.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}
function projectCovers(field, name2) {
  if (field === null || isGlobalProject(field)) return true;
  return projectList(field).includes(name2);
}
function projectLabel(field) {
  if (isGlobalProject(field)) return globalProjectMarker();
  if (field === null || field === "") return lbl("project.unlabeled");
  return projectList(field).join("/");
}
function newId(now = Date.now()) {
  const t = now.toString(36).padStart(9, "0");
  return t + "-" + randomUUID().replace(/-/g, "").slice(0, 26);
}
// [macro-fusion 0.2.123] 邻居每条最多印多少字：上下文是「看清这句话在说什么」，不是全文搬运。
var CTX_CHARS = 200;
// [0.2.126] 邻居一次最多铺这么多行。离线台（LoCoMo 1,193 题，真引擎）：±2 合并窗口不限行
//  42.5%（4,727 字符）、限 24 行 41.5%（3,462 字符）、限 16 行 39.1%（2,335 字符）、
//  逐条 ±1 38.9%（3,501 字符）——24 行这一档与逐条 ±1 花一样多的字，多 2.6pt，所以封在 24。
var CTX_LINES = 24;
// [0.2.132] 邻居行预算分档：问句在问时间就还是 24 行，其余铺到 48 行。
//   LoCoMo 1,193 题同题对照（omni40 / omni41 / omni42 三次独立跑，同一套材料构造）：
//     A 24 行/前 8 段 54.4 / 54.9 / 55.4；
//     T 时间题 24 行、其余 48 行 57.6 / 57.5 / 58.2（净 +38 / +31 / +33，p≤0.0001）；
//     中间档 36 行 54.6（净 −4，p=0.85）——不是线性，是阈值：行数不给到 48 等于没加；
//     反过来只加段数不加行数（24 段 × 24 行）55.1（净 −4，p=0.80）——段数不是那个旋钮。
//   时间题必须留着窄：48 行一律铺，cat2（时间）47.7→43.6，日期被多出来的噪声稀释。
//   代价：非时间题的邻居字符 +67%（约 3.4k → 6.7k），所以再压一道字符闸（见 CTX_CHARS_DEEP）。
var CTX_LINES_DEEP = 48;
// 铺宽时最多花这么多字符（只数邻居行正文，不含命中本体）：行数放开、字数不放开。
var CTX_CHARS_DEEP = 7000;

// [0.2.129] 时间轴只在「问句本身在问时间」时才印。1,193 题同题对照（omni13）：
//   不印 43.8% / 一律印 46.2% / 只在问句含时间词时印 46.5%（p<0.0001）——一律印会多花 168 字，
//   而且单跳查事实的题会掉分（cat4 71.5%→70.9%）；按问句闸门反而把 cat4 保住了。
var TIMELINE_CUE =
  /\b(when|what date|what day|which (year|month|day|week)|how long|how many (days|weeks|months|years)|before|after|earlier|later|first|last|ago|yesterday|tomorrow|next (week|month|year)|previous)\b|\u4ec0\u4e48\u65f6\u5019|\u4f55\u65f6|\u54ea\u5929|\u54ea\u4e00\u5929|\u51e0\u53f7|\u54ea\u5e74|\u54ea\u4e2a\u6708|\u661f\u671f\u51e0|\u5468\u51e0|\u591a\u4e45|\u591a\u957f\u65f6\u95f4|\u4e4b\u524d|\u4e4b\u540e|\u4ee5\u524d|\u4ee5\u540e|\u6700\u65e9|\u6700\u665a|\u5148\u540e/i;
var TIMELINE_MAX = 8;
var COMMON_COLS = `
  id TEXT PRIMARY KEY,
  title TEXT,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 1,
  keywords TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  source_session TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  read_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER
`;
var SCHEMAS = {
  soul: `CREATE TABLE IF NOT EXISTS soul (${COMMON_COLS})`,
  user: `CREATE TABLE IF NOT EXISTS user (${COMMON_COLS})`,
  project: `CREATE TABLE IF NOT EXISTS project (${COMMON_COLS},
    project TEXT NOT NULL,
    subcategory TEXT)`,
  fact: `CREATE TABLE IF NOT EXISTS fact (${COMMON_COLS},
    project TEXT)`,
  lesson: `CREATE TABLE IF NOT EXISTS lesson (${COMMON_COLS},
    corrected INTEGER NOT NULL DEFAULT 0,
    project TEXT)`,
  topic: `CREATE TABLE IF NOT EXISTS topic (${COMMON_COLS},
    goal TEXT,
    project TEXT)`,
  rules: `CREATE TABLE IF NOT EXISTS rules (${COMMON_COLS},
    project TEXT)`
  // project 可空：null=全局准则（高 importance 全量注入），非空=项目特定（memory_project 注入）
};
function memoryDbPath(workspace, dir = ".dsh-meow") {
  return join4(workspace, dir, "memory.db");
}
var MemoryDb = class {
  db;
  path;
  /** #104：node:sqlite 的连接在长会话/WAL 反复增长/外部 checkpoint 后可能进入不可用
   *  状态（此后每条语句抛 "disk I/O error"），而库文件本身完好（integrity_check ok、
   *  外部进程可写）——重启即恢复证明只需重建连接。所有运行时语句经此包装：命中
   *  瞬时失效（disk I/O / locked / not open）时重连一次并重放本条语句。
   *  prepare 放在 try 内：连接已死时 prepare 本身就会抛，同样走重连。 */
  p(sql) {
    const exec = (m, args) => {
      try {
        return this.db.prepare(sql)[m](...args);
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (!/disk I\/O|database is locked|not open/i.test(msg)) throw e;
        try {
          this.db.close();
        } catch {
        }
        this.db = new DatabaseSync(this.path);
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA busy_timeout = 5000");
        return this.db.prepare(sql)[m](...args);
      }
    };
    return {
      run: (...args) => exec("run", args),
      get: (...args) => exec("get", args),
      all: (...args) => exec("all", args)
    };
  }
  constructor(path) {
    this.path = path;
    mkdirSync3(dirname3(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    for (const level of LEVELS) this.db.exec(SCHEMAS[level]);
    this.db.exec(`CREATE TABLE IF NOT EXISTS dream_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at INTEGER NOT NULL,
      summary TEXT,
      changes TEXT,
      note TEXT
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS windows (
      session_id TEXT PRIMARY KEY,
      workspace TEXT,
      last_event_time INTEGER,
      last_dream_time INTEGER,
      dream_owner TEXT,
      dream_started_at INTEGER,
      dream_progress_at INTEGER,
      dream_group_idx INTEGER,
      dream_T INTEGER
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS dream_meta (
      key TEXT PRIMARY KEY,
      value INTEGER
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS dream_skip (
      session_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      skip_dream INTEGER NOT NULL DEFAULT 1,
      skip_inject INTEGER NOT NULL DEFAULT 0,
      skip_write INTEGER NOT NULL DEFAULT 0
    )`);
    this.upgrade();
  }
  /** 幂等升级：缺列补列；旧 UUID id 按 created_at 重排为时间前缀 id；
   *  v0.7.0：dream_at 列并入 updated_at（记忆时间戳=最后更新时间）后删除。 */
  upgrade() {
    for (const level of LEVELS) {
      const cols = new Set(
        this.p(`PRAGMA table_info(${level})`).all().map((c) => c.name)
      );
      if (cols.has("dream_at")) {
        this.db.exec(`UPDATE ${level} SET updated_at = MAX(COALESCE(updated_at, 0), COALESCE(dream_at, 0)) WHERE dream_at IS NOT NULL`);
        this.db.exec(`ALTER TABLE ${level} DROP COLUMN dream_at`);
      }
      if (level === "project" && !cols.has("subcategory")) {
        this.db.exec("ALTER TABLE project ADD COLUMN subcategory TEXT");
      }
      if (level === "topic" && !cols.has("project")) {
        this.db.exec("ALTER TABLE topic ADD COLUMN project TEXT");
      }
      // [macro-fusion 0.4.0] 「召回过」与「真读过」是两件事，体检的 unused 要靠后者。
      // 老库补列（DEFAULT 0 不会把历史读当成没读，只是从这一版起开始记）。
      if (!cols.has("read_count")) {
        this.db.exec(`ALTER TABLE ${level} ADD COLUMN read_count INTEGER NOT NULL DEFAULT 0`);
      }
      const legacy = this.p(`SELECT id FROM ${level}`).all();
      for (const { id } of legacy) {
        if (/^[0-9a-z]{9}-/.test(id)) continue;
        const created = this.p(`SELECT created_at FROM ${level} WHERE id = ?`).get(id).created_at;
        this.p(`UPDATE ${level} SET id = ? WHERE id = ?`).run(newId(created), id);
      }
    }
    const wCols = new Set(
      this.p("PRAGMA table_info(windows)").all().map((c) => c.name)
    );
    for (const [col, ddl] of [
      ["dream_owner", "TEXT"],
      ["dream_started_at", "INTEGER"],
      ["dream_progress_at", "INTEGER"],
      ["dream_group_idx", "INTEGER"],
      ["dream_T", "INTEGER"]
    ]) {
      if (!wCols.has(col)) this.db.exec(`ALTER TABLE windows ADD COLUMN ${col} ${ddl}`);
    }
    if (wCols.has("dream_pending")) {
      this.db.exec(`UPDATE windows SET dream_owner = 'legacy-pending', dream_started_at = 0, dream_progress_at = 0, dream_group_idx = 0, dream_T = last_event_time WHERE dream_pending = 1 AND dream_owner IS NULL`);
    }
    const sCols = new Set(
      this.p("PRAGMA table_info(dream_skip)").all().map((c) => c.name)
    );
    for (const [col, ddl] of [
      ["skip_dream", "INTEGER NOT NULL DEFAULT 1"],
      ["skip_inject", "INTEGER NOT NULL DEFAULT 0"],
      ["skip_write", "INTEGER NOT NULL DEFAULT 0"]
    ]) {
      if (!sCols.has(col)) this.db.exec(`ALTER TABLE dream_skip ADD COLUMN ${col} ${ddl}`);
    }
  }
  /** 新库（memories 全空）判定：迁移只在库刚创建时执行一次。 */
  isFresh() {
    const row = this.p("SELECT COUNT(*) AS n FROM soul").get();
    return row.n === 0;
  }
  /** VACUUM INTO 一致性快照到目标路径（#37 可选备份；目标已存在会抛，调用方先轮转）。
   *  WAL 下安全：快照含 WAL 内容，读连接一致性由 SQLite 保证。 */
  vacuumInto(target) {
    this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  }
  insert(row) {
    const now = Date.now();
    const full = {
      id: row.id ?? newId(now),
      level: row.level,
      title: row.title ?? null,
      content: row.content,
      importance: row.importance ?? 1,
      keywords: row.keywords ?? [],
      status: row.status ?? "active",
      corrected: row.corrected ?? 0,
      project: row.project ?? null,
      subcategory: row.subcategory ?? null,
      goal: row.goal ?? null,
      source_session: row.source_session ?? null,
      hit_count: row.hit_count ?? 0,
      created_at: row.created_at ?? now,
      updated_at: row.updated_at ?? now,
      last_accessed_at: row.last_accessed_at ?? null
    };
    this.db.prepare(
      `INSERT INTO ${full.level} (id, title, content, importance, keywords, status, source_session, hit_count, created_at, updated_at, last_accessed_at
          ${full.level === "project" ? ", project, subcategory" : ""}
          ${full.level === "fact" || full.level === "lesson" || full.level === "rules" ? ", project" : ""}
          ${full.level === "lesson" ? ", corrected" : ""}
          ${full.level === "topic" ? ", goal, project" : ""}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          ${full.level === "project" ? ", ?, ?" : ""}
          ${full.level === "fact" || full.level === "lesson" || full.level === "rules" ? ", ?" : ""}
          ${full.level === "lesson" ? ", ?" : ""}
          ${full.level === "topic" ? ", ?, ?" : ""}
        )`
    ).run(
      full.id,
      full.title,
      full.content,
      full.importance,
      JSON.stringify(full.keywords),
      full.status,
      full.source_session,
      full.hit_count,
      full.created_at,
      full.updated_at,
      full.last_accessed_at,
      ...full.level === "project" ? [full.project ?? "", full.subcategory] : [],
      ...full.level === "fact" || full.level === "lesson" || full.level === "rules" ? [full.project] : [],
      ...full.level === "lesson" ? [full.corrected] : [],
      ...full.level === "topic" ? [full.goal, full.project] : []
    );
    return full;
  }
  /** 跨表定位（UUID 全局唯一，扫描全部表）。id 支持 8 位前缀匹配
   *  （快照/检索结果给的是截断 id；前缀碰撞时取第一个）。 */
  findById(id) {
    const prefix = id.length < 36;
    for (const level of LEVELS) {
      const sql = prefix ? `SELECT * FROM ${level} WHERE id LIKE ?` : `SELECT * FROM ${level} WHERE id = ?`;
      const r = this.p(sql).get(prefix ? `${id}%` : id);
      if (r) return { row: this.fromRow(level, r), level };
    }
    return void 0;
  }
  /** 短 id 全量解析（#62）：返回全部前缀命中（跨表）。findById 首条语义只配只读展示；
   *  写路径必须走这里做歧义拒绝——findById 首条 + 拿解析出的全 id 去 update，会绕过
   *  update 内部的 LIKE 歧义守卫，静默改错条目。 */
  findByIdAll(id) {
    const prefix = id.length < 36;
    const out = [];
    for (const level of LEVELS) {
      const sql = prefix ? `SELECT * FROM ${level} WHERE id LIKE ?` : `SELECT * FROM ${level} WHERE id = ?`;
      const rows = this.p(sql).all(prefix ? `${id}%` : id);
      for (const r of rows) out.push({ row: this.fromRow(level, r), level });
    }
    return out;
  }
  update(level, id, patch) {
    const sets = [];
    const args = [];
    const push = (col, val) => {
      sets.push(`${col} = ?`);
      args.push(val);
    };
    if (patch.content !== void 0) push("content", patch.content);
    if (patch.title !== void 0) push("title", patch.title);
    if (patch.importance !== void 0) push("importance", patch.importance);
    if (patch.keywords !== void 0) push("keywords", JSON.stringify(patch.keywords));
    if (patch.status !== void 0) push("status", patch.status);
    if (patch.corrected !== void 0 && level === "lesson") push("corrected", patch.corrected);
    if (patch.project !== void 0 && (level === "project" || level === "fact" || level === "lesson" || level === "rules")) {
      push("project", patch.project);
    }
    if (patch.subcategory !== void 0 && level === "project") push("subcategory", patch.subcategory);
    if (patch.goal !== void 0 && level === "topic") push("goal", patch.goal);
    if (patch.project !== void 0 && level === "topic") push("project", patch.project);
    if (sets.length === 0) return false;
    push("updated_at", Date.now());
    let targetId = id;
    if (id.length < 36) {
      const matches = this.p(`SELECT id FROM ${level} WHERE id LIKE ?`).all(`${id}%`);
      if (matches.length > 1) {
        console.warn(`[meow-memory] update \u62D2\u7EDD\u6B67\u4E49\u77ED id\uFF1A${level} \u524D\u7F00 "${id}" \u547D\u4E2D ${matches.length} \u884C\uFF0C\u8BF7\u7528\u5B8C\u6574 id`);
        return false;
      }
      if (matches.length === 0) return false;
      targetId = matches[0].id;
    }
    const res = this.p(`UPDATE ${level} SET ${sets.join(", ")} WHERE id = ?`).run(...args, targetId);
    return res.changes > 0;
  }
  list(level, opts = {}) {
    const where = [];
    const args = [];
    if (opts.status) {
      where.push("status = ?");
      args.push(opts.status);
    }
    if (opts.project !== void 0 && (level === "project" || level === "fact" || level === "lesson" || level === "rules")) {
      where.push("project = ?");
      args.push(opts.project);
    }
    const sql = `SELECT * FROM ${level}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC`;
    const rows = this.p(sql).all(...args);
    return rows.map((r) => this.fromRow(level, r));
  }
  /** 全部 active 条目（dream / 注入用），按 level 分组。 */
  allActive() {
    const out = {};
    for (const level of LEVELS) out[level] = this.list(level, { status: "active" });
    return out;
  }
  /** 可检索条目：active 全部；project.subcategory='todo' 的 stale 视为 done 参与检索。
   *  （用户拍板：todo 过时=finish 可检索，其他类别过时不检索。） */
  listSearchable(level) {
    const active2 = this.list(level, { status: "active" });
    if (level !== "project") return active2;
    const todoDone = this.p(`SELECT * FROM project WHERE status = 'stale' AND subcategory = 'todo'`).all().map((r) => this.fromRow("project", r));
    return [...active2, ...todoDone];
  }
  /** [macro-fusion 0.2.123] 同层相邻行：一条记忆常常只是「对话里的一个回合」，单看它一句
   *  会答错，前一句/后一句才是它的意思。离线台实测（LoCoMo 1,540 题，真引擎）：只排单条
   *  hit@20 0.7526、MRR 0.4792；把命中扩成前后各 1 条的窗口后 hit@20 0.8656、MRR 0.5856，
   *  前后各 2 条到 0.9182——这是「把命中当窗口」而不是「把分数调高」，排序与分数一个字没动。
   *  只读同层、按 rowid 相邻（写入顺序）取 active 行，不跨层：跨层会把 fact 和 lesson
   *  拼成一句话，读起来像同一个人说的。 */
  adjacentWindows(entries, span = 1) {
    const out = new Map();
    const n = Math.min(3, Math.max(0, Math.trunc(Number(span)) || 0));
    if (n === 0) return out;
    for (const e of entries) {
      const table = String(e?.level ?? "");
      if (!Object.prototype.hasOwnProperty.call(SCHEMAS, table)) continue;
      const rid = Number(this.p(`SELECT rowid AS rid FROM ${table} WHERE id = ?`).get(e.id)?.rid);
      if (!Number.isFinite(rid)) continue;
      const slim = (rows) =>
        rows.map((r) => ({
          id: String(r.id ?? ""),
          level: table,
          content: String(r.content ?? "").slice(0, CTX_CHARS),
          day: stampDay(r.updated_at),
        }));
      // status 收紧到 active：把已作废的邻居拼进上下文，等于让一段被推翻的话重新开口。
      const before = slim(
        this.p(`SELECT id, content, updated_at FROM ${table} WHERE rowid < ? AND rowid >= ? AND status = 'active' ORDER BY rowid DESC`).all(rid, rid - n),
      );
      const after = slim(
        this.p(`SELECT id, content, updated_at FROM ${table} WHERE rowid > ? AND rowid <= ? AND status = 'active' ORDER BY rowid`).all(rid, rid + n),
      );
      if (before.length > 0 || after.length > 0) out.set(String(e.id), { before, after });
    }
    return out;
  }
  bumpHit(level, id) {
    this.p(`UPDATE ${level} SET hit_count = hit_count + 1, last_accessed_at = ? WHERE id = ?`).run(
      Date.now(),
      id
    );
  }
  /** [macro-fusion 0.4.0] 真被 read 打开一次。与 bumpHit 分开记：
   *  检索命中不等于读——命中只证明「排进了候选」，读过才证明「这段正文进过上下文」。
   *  体检的 unused 判的是后者（hit_count > 0 且 read_count = 0）。 */
  bumpRead(level, id) {
    this.p(`UPDATE ${level} SET read_count = read_count + 1, last_accessed_at = ? WHERE id = ?`).run(
      Date.now(),
      id
    );
  }
  count(level) {
    const row = this.p(`SELECT COUNT(*) AS n FROM ${level}`).get();
    return row.n;
  }
  /** 全部出现过（含已过时）的项目名：project/fact/lesson/topic/rules 五表的 project 列并集
   *  （多值逗号分隔展开；全局标记不是项目，projectList 已排除）。供记忆导引列出"用户的所有 project"。 */
  listProjectNames() {
    const names = /* @__PURE__ */ new Set();
    for (const level of ["project", "fact", "lesson", "topic", "rules"]) {
      const rows = this.p(`SELECT project FROM ${level} WHERE project IS NOT NULL AND project != ''`).all();
      for (const r of rows) for (const n of projectList(r.project)) names.add(n);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }
  logDream(summary, changes, note = "") {
    this.db.prepare("INSERT INTO dream_log (run_at, summary, changes, note) VALUES (?, ?, ?, ?)").run(Date.now(), summary, JSON.stringify(changes), note);
  }
  recentDream(hours) {
    const row = this.db.prepare("SELECT run_at FROM dream_log ORDER BY run_at DESC LIMIT 1").get();
    if (!row) return false;
    return Date.now() - row.run_at < hours * 36e5;
  }
  /** [macro-fusion 0.2.97] 最近几次 dream 的账本（面板只读这个，不靠猜）：changes 里 0.2.96 起的
   *  plan 就是那一轮的规模。changes 坏行照样出一行（plan=null），别让一行坏账吞掉整本账。 */
  recentDreams(limit = 5) {
    const asked = Math.trunc(Number(limit));
    const n = Math.min(50, Math.max(1, Number.isFinite(asked) && asked > 0 ? asked : 5));
    const rows = this.db.prepare("SELECT run_at, summary, changes, note FROM dream_log ORDER BY run_at DESC LIMIT ?").all(n);
    return rows.map((r) => {
      let changes = null;
      try {
        changes = JSON.parse(String(r.changes ?? ""));
      } catch {
        changes = null;
      }
      return { runAt: Number(r.run_at) || 0, summary: String(r.summary ?? ""), changes, note: String(r.note ?? "") };
    });
  }
  /** [macro-fusion 0.2.100] 账本分页：一页几条、从第几条开始。行里带 rowid（面板只当内部句柄，
   *  对外仍按「第 k 近」说话），并给同 run_at 一个稳定的次序（rowid DESC），否则翻页会漏条/重条。 */
  // [macro-fusion 0.2.105] 再收 since / until（毫秒，闭区间）：问「这几天整理得怎么样」以前只能翻页数条。
  // 时间条件也必须留在 SQL 里，理由与项目筛同款——搬出去算，「第几页」和「一共几条」就各有一套了。
  recentDreamsPage(limit = 5, offset = 0, project = "", since = 0, until = 0) {
    const askedLimit = Math.trunc(Number(limit));
    const n = Math.min(50, Math.max(1, Number.isFinite(askedLimit) && askedLimit > 0 ? askedLimit : 5));
    const askedOffset = Math.trunc(Number(offset));
    const skip = Number.isFinite(askedOffset) && askedOffset > 0 ? askedOffset : 0;
    // [macro-fusion 0.2.101] 按项目段筛：SQL 里筛，不搬到 JS 里再挑——否则「第几页」和
    // 「一共几条」会各算一套，翻页就漏条。
    // [macro-fusion 0.2.102] 再补 je.type='text'：老账本里 projects 是数字，别让数字被当成名字。
    const name = String(project ?? "").trim();
    const from = Number(since);
    const to = Number(until);
    const parts = [];
    const args = [];
    if (name !== "") {
      parts.push(
        "json_valid(changes) AND EXISTS (SELECT 1 FROM json_each(json_extract(dream_log.changes, '$.plan.projects')) WHERE json_each.type = 'text' AND json_each.value = ?)",
      );
      args.push(name);
    }
    // run_at 是毫秒时间戳，闭区间：since 当天 0 点、until 当天 23:59:59.999 都算在内。
    if (Number.isFinite(from) && from > 0) {
      parts.push("run_at >= ?");
      args.push(Math.trunc(from));
    }
    if (Number.isFinite(to) && to > 0) {
      parts.push("run_at <= ?");
      args.push(Math.trunc(to));
    }
    const where = parts.length === 0 ? "" : "WHERE " + parts.join(" AND ");
    const sql = "SELECT rowid AS id, run_at, summary, changes, note FROM dream_log " + where + " ORDER BY run_at DESC, rowid DESC LIMIT ? OFFSET ?";
    const rows = this.db.prepare(sql).all(...args, n, skip);
    return rows.map((r) => {
      let changes = null;
      try {
        changes = JSON.parse(String(r.changes ?? ""));
      } catch {
        changes = null;
      }
      return {
        id: Number(r.id) || 0,
        runAt: Number(r.run_at) || 0,
        summary: String(r.summary ?? ""),
        changes,
        note: String(r.note ?? ""),
      };
    });
  }
  dreamCount() {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM dream_log").get();
    return Number(row?.n) || 0;
  }
  /** [macro-fusion 0.2.105] 账本最早 / 最新一条的时间（毫秒）。筛空了要靠它说清「这段时间里没有」
   *  与「账本里根本没有这段」——不给这两个数，读者只能把空结果读成「整理没发生过」。 */
  dreamsSpan() {
    const row = this.db.prepare("SELECT MIN(run_at) AS a, MAX(run_at) AS b FROM dream_log").get();
    return { first: Number(row?.a) || 0, last: Number(row?.b) || 0 };
  }
  /** [macro-fusion 0.2.101] 账本按项目段筛：project 为空就是全账本。
   *  项目名在 changes.plan.projects 里（JSON 数组），所以走 json_each；坏行先被 json_valid 挡掉，
   *  不许让一行坏账把整条查询带崩，也不许把它悄悄算成「匹配」。 */
  // [macro-fusion 0.2.105] 带 since / until 时 total 也必须是筛后的数（否则翻到第二页就空）。
  dreamCountOf(project = "", since = 0, until = 0) {
    const name = String(project ?? "").trim();
    const from = Number(since);
    const to = Number(until);
    const parts = [];
    const args = [];
    if (name !== "") {
      parts.push(
        "json_valid(changes) AND EXISTS (SELECT 1 FROM json_each(json_extract(dream_log.changes, '$.plan.projects')) WHERE json_each.type = 'text' AND json_each.value = ?)",
      );
      args.push(name);
    }
    if (Number.isFinite(from) && from > 0) {
      parts.push("run_at >= ?");
      args.push(Math.trunc(from));
    }
    if (Number.isFinite(to) && to > 0) {
      parts.push("run_at <= ?");
      args.push(Math.trunc(to));
    }
    if (parts.length === 0) return this.dreamCount();
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM dream_log WHERE " + parts.join(" AND ")).get(...args);
    return Number(row?.n) || 0;
  }
  /** [macro-fusion 0.2.101] 项目段的分布：每个项目在多少次账里出现过（次数降序、同数次按名字）。
   *  返回 total 是「一共几个不同的项目段」——只列前几条时，别把「没列出来」读成「没有」。
   *  [macro-fusion 0.2.102] 只认文本：0.2.96～0.2.101 写出来的账里 projects 是个数字，
   *  json_each 会把它摊成一行 value=3——那不是项目名，别让它出现在分布里冒充一个项目。 */
  dreamProjects(limit = 5) {
    const asked = Math.trunc(Number(limit));
    const n = Math.min(20, Math.max(1, Number.isFinite(asked) && asked > 0 ? asked : 5));
    const rows = this.db
      .prepare(
        "SELECT je.value AS project, COUNT(*) AS n FROM dream_log, " +
          "json_each(json_extract(dream_log.changes, '$.plan.projects')) AS je " +
          "WHERE json_valid(dream_log.changes) AND je.type = 'text' GROUP BY je.value ORDER BY n DESC, je.value ASC LIMIT ?",
      )
      .all(n);
    const seen = this.db
      .prepare(
        "SELECT COUNT(DISTINCT je.value) AS n FROM dream_log, " +
          "json_each(json_extract(dream_log.changes, '$.plan.projects')) AS je " +
          "WHERE json_valid(dream_log.changes) AND je.type = 'text'",
      )
      .get();
    return {
      items: rows.map((r) => ({ project: String(r.project ?? ""), n: Number(r.n) || 0 })),
      total: Number(seen?.n) || 0,
    };
  }
  /** [macro-fusion 0.2.104] 账本行的稳定引用：id 是 dream_log.id（INTEGER PRIMARY KEY AUTOINCREMENT），
   *  只增不减、删了也不复用——「第几近」会随新账往下挪，这个号不挪，所以对外要有一个叫得住的名字。
   *  返回 {id, runAt, summary, changes, note}，没有这一行就 null（别拿「读不到」冒充「不存在」）。 */
  dreamById(id) {
    const asked = Math.trunc(Number(id));
    const key = Number.isFinite(asked) && asked > 0 ? asked : 0;
    if (key === 0) return null;
    const row = this.db.prepare("SELECT id, run_at, summary, changes, note FROM dream_log WHERE id = ?").get(key);
    if (!row) return null;
    let changes = null;
    try {
      changes = JSON.parse(String(row.changes ?? ""));
    } catch {
      changes = null;
    }
    return { id: Number(row.id) || 0, runAt: Number(row.run_at) || 0, summary: String(row.summary ?? ""), changes, note: String(row.note ?? "") };
  }
  /** [macro-fusion 0.2.104] 这一行现在排第几近（1 = 最新）。排序与 recentDreamsPage 必须同一把尺子
   *  （run_at DESC, id DESC），否则「引用」和「第几近」会指向不同的行。没有这一行返回 0。 */
  dreamRankOf(id) {
    const asked = Math.trunc(Number(id));
    const key = Number.isFinite(asked) && asked > 0 ? asked : 0;
    if (key === 0) return 0;
    const row = this.db.prepare("SELECT id, run_at FROM dream_log WHERE id = ?").get(key);
    if (!row) return 0;
    const at = Number(row.run_at) || 0;
    const self = Number(row.id) || 0;
    const before = this.db
      .prepare("SELECT COUNT(*) AS n FROM dream_log WHERE run_at > ? OR (run_at = ? AND id > ?)")
      .get(at, at, self);
    return (Number(before?.n) || 0) + 1;
  }
  close() {
    try {
      this.db.close();
    } catch {
    }
  }
  /** 子 agent / dream 用的只读快照：把一组行转成纯数据（无 db 依赖）。 */
  snapshot(level, opts = {}) {
    return this.list(level, opts);
  }
  // ── windows 窗口表（dream 判定：跨重启持久化） ───────────────────────────
  touchWindow(sessionId, workspace, eventTime) {
    this.db.prepare(`INSERT INTO windows (session_id, workspace, last_event_time, last_dream_time) VALUES (?, ?, ?, NULL)
        ON CONFLICT(session_id) DO UPDATE SET workspace = excluded.workspace, last_event_time = MAX(last_event_time, excluded.last_event_time)`).run(sessionId, workspace, eventTime);
  }
  setWindowDream(sessionId, time) {
    this.p(`UPDATE windows SET last_dream_time = ? WHERE session_id = ?`).run(time, sessionId);
  }
  /** 原子抢占 dream 租约（跨进程/实例防重复 start）：返回 true 表示抢占成功（可 start）。
   *  条件：无租约（owner IS NULL）或租约已过期（progress_at 超 leaseMs）。owner 只用于抢占判断 + 诊断；
   *  推进/收尾按「sessionId + 租约未过期」判定，不校验 owner。 */
  claimDream(sessionId, owner, T2, leaseMs) {
    this.db.prepare(`INSERT OR IGNORE INTO windows (session_id, workspace, last_event_time, last_dream_time) VALUES (?, NULL, 0, NULL)`).run(sessionId);
    const now = Date.now();
    return this.db.prepare(
      `UPDATE windows SET dream_owner = ?, dream_started_at = ?, dream_progress_at = ?, dream_group_idx = 0, dream_T = ?
           WHERE session_id = ? AND (dream_owner IS NULL OR dream_progress_at IS NULL OR dream_progress_at <= ?)`
    ).run(owner, now, now, T2, sessionId, now - leaseMs).changes === 1;
  }
  /** dream 收尾：清租约 + 记 last_dream_time（dream 完成时刻）。 */
  finishDream(sessionId, time) {
    this.db.prepare(`UPDATE windows SET dream_owner = NULL, dream_started_at = NULL, dream_progress_at = NULL, dream_group_idx = NULL, dream_T = NULL, last_dream_time = ? WHERE session_id = ?`).run(time, sessionId);
    this.clearDreamFailure(sessionId);
    this.delDreamMeta(`dreamplan:${sessionId}`);
  }
  /** dream 失败释放：只清租约，**不动 last_dream_time**——窗口保持「待整理」状态，
   *  下个检查周期 windowNeedsDream 仍成立即自动重试。
   *  与 finishDream 的语义区分：finish=完成/用户中止（封存，last_dream_time=收尾时刻）；
   *  release=执行失败（网络/服务瞬态故障，非用户意愿，2026-09-05 教训：把失败窗口
   *  按 aborted 封存会让一次断网整夜吞掉所有窗口的 dream 且永不重试）。 */
  releaseDream(sessionId) {
    this.db.prepare(`UPDATE windows SET dream_owner = NULL, dream_started_at = NULL, dream_progress_at = NULL, dream_group_idx = NULL, dream_T = NULL WHERE session_id = ?`).run(sessionId);
    this.delDreamMeta(`dreamplan:${sessionId}`);
  }
  // ── dream 失败计数（issue #36）──────────────────────────────────────────────
  // 存 dream_meta（KV，跨实例/重启共享）：`dreamfail_c:<sid>` = 连续失败次数、
  // `dreamfail_t:<sid>` = 计数对应的整理范围 T。T 变了（窗口有新活动 → 新一轮整理
  // 范围不同）自动从 1 重计；dream 收尾（finishDream）清零。与 releaseDream 的
  // 「失败不封存、可重试」语义配套：失败只释放，连续达上限（DREAM_MAX_ATTEMPTS，
  // dream.ts）才封存止损——既不让一次故障静默吞掉整窗记忆，也不让持续性故障
  // 变成无限重试烧 token。
  /** 记一次 dream 失败，返回当前连续失败次数（同 T 累加，T 变化重计）。 */
  recordDreamFailure(sessionId, T2) {
    const prevT = this.p(`SELECT value FROM dream_meta WHERE key = ?`).get(`dreamfail_t:${sessionId}`);
    const prevC = this.p(`SELECT value FROM dream_meta WHERE key = ?`).get(`dreamfail_c:${sessionId}`);
    const count = prevT !== void 0 && prevT.value === T2 && prevC !== void 0 && typeof prevC.value === "number" && prevC.value >= 1 ? prevC.value + 1 : 1;
    this.db.prepare(`INSERT INTO dream_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(`dreamfail_t:${sessionId}`, T2);
    this.db.prepare(`INSERT INTO dream_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(`dreamfail_c:${sessionId}`, count);
    return count;
  }
  /** 清 dream 失败计数（finishDream 收尾时自动调用；一般无需手动调）。 */
  clearDreamFailure(sessionId) {
    this.p(`DELETE FROM dream_meta WHERE key = ?`).run(`dreamfail_t:${sessionId}`);
    this.p(`DELETE FROM dream_meta WHERE key = ?`).run(`dreamfail_c:${sessionId}`);
  }
  /** dream_meta 通用读写（KV，跨实例/重启共享）。当前用于轮次计划快照
   *  `dreamplan:<sid>`（#69）。 */
  setDreamMeta(key, value) {
    this.p(`INSERT INTO dream_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }
  getDreamMeta(key) {
    const r = this.p(`SELECT value FROM dream_meta WHERE key = ?`).get(key);
    return typeof r?.value === "string" ? r.value : void 0;
  }
  delDreamMeta(key) {
    this.p(`DELETE FROM dream_meta WHERE key = ?`).run(key);
  }
  /** 是否有进行中/未收尾的 dream（租约存在，无论是否过期）。 */
  isDreamPending(sessionId) {
    const row = this.p(`SELECT dream_owner FROM windows WHERE session_id = ?`).get(sessionId);
    return row?.dream_owner != null;
  }
  /** 读窗口当前 dream 租约；无租约返回 null。 */
  getDreamLease(sessionId) {
    const row = this.db.prepare(`SELECT dream_owner, dream_started_at, dream_progress_at, dream_group_idx, dream_T FROM windows WHERE session_id = ?`).get(sessionId);
    if (!row || row.dream_owner == null) return null;
    return {
      owner: row.dream_owner,
      started_at: row.dream_started_at ?? 0,
      progress_at: row.dream_progress_at ?? 0,
      group_idx: row.dream_group_idx ?? 0,
      T: row.dream_T ?? 0
    };
  }
  /** CAS 推进租约：group_idx +1 并刷新心跳。多实例同收 turn-stopping 时只有一个成功。 */
  advanceDreamLease(sessionId, fromIdx, leaseMs) {
    const now = Date.now();
    return this.db.prepare(
      `UPDATE windows SET dream_group_idx = dream_group_idx + 1, dream_progress_at = ?
           WHERE session_id = ? AND dream_group_idx = ? AND dream_owner IS NOT NULL AND dream_progress_at > ?`
    ).run(now, sessionId, fromIdx, now - leaseMs).changes === 1;
  }
  /** 轮内租约心跳：只刷新 progress_at，不动 group_idx（推进仍归 advanceDreamLease 的 CAS）。
   *  安全性：只 touch 梦的活跃租约——finalize/release/abort 清租约后 changes=0，
   *  调用方据此自动停表，僵尸 dream 永远不会被心跳续命。 */
  touchDreamLease(sessionId) {
    return this.db.prepare(`UPDATE windows SET dream_progress_at = ? WHERE session_id = ? AND dream_owner IS NOT NULL`).run(Date.now(), sessionId).changes === 1;
  }
  // ── dream_skip 门控表（v0.16.0 跳过 dream → v0.30.0 升级为「记忆参与」三档门控，#38）──
  // 一行 = 一个窗口的门控状态：skip_dream（跳过整理：自动 dream + 自动反思）、
  // skip_inject（停止读入：首轮快照/命中/重注入/search/read 等读入口）、skip_write
  // （停止写入：普通轮的 remember/update；整理轮写入跟随整理档）。三档全 false 删行。
  /** 读某窗口的门控状态（无行 = 三档全开）。 */
  getMemoryScope(sessionId) {
    const row = this.db.prepare(`SELECT skip_dream, skip_inject, skip_write FROM dream_skip WHERE session_id = ?`).get(sessionId);
    if (row === void 0) return { dream: false, inject: false, write: false };
    return { dream: row.skip_dream === 1, inject: row.skip_inject === 1, write: row.skip_write === 1 };
  }
  /** 设置某窗口某档的开关；三档全 false 时删行（表只存有门槛的窗口）。
   *  新行显式插 0（DDL 的 DEFAULT 1 只服务于老行迁移——老行语义就是 dream 跳过）。 */
  setMemoryScopeField(sessionId, field, value) {
    const col = field === "dream" ? "skip_dream" : field === "inject" ? "skip_inject" : "skip_write";
    this.db.prepare(`INSERT INTO dream_skip (session_id, created_at, skip_dream, skip_inject, skip_write) VALUES (?, ?, 0, 0, 0) ON CONFLICT(session_id) DO NOTHING`).run(sessionId, Date.now());
    this.p(`UPDATE dream_skip SET ${col} = ? WHERE session_id = ?`).run(value ? 1 : 0, sessionId);
    const scope = this.getMemoryScope(sessionId);
    if (!scope.dream && !scope.inject && !scope.write) {
      this.p(`DELETE FROM dream_skip WHERE session_id = ?`).run(sessionId);
    }
  }
  /** 全部门控状态（client 全量对账用）。 */
  listMemoryScopes() {
    const rows = this.db.prepare(`SELECT session_id, skip_dream, skip_inject, skip_write FROM dream_skip
        WHERE skip_dream = 1 OR skip_inject = 1 OR skip_write = 1`).all();
    return rows.map((r) => ({ session_id: r.session_id, dream: r.skip_dream === 1, inject: r.skip_inject === 1, write: r.skip_write === 1 }));
  }
  /** 设置/清除某会话的跳过标记（v0.30.0 起委派门控表 dream 档；旧调用点/测试兼容）。 */
  setDreamSkip(sessionId, skip) {
    this.setMemoryScopeField(sessionId, "dream", skip);
  }
  /** 该会话是否被跳过自动 dream（只挡定时器自动触发；手动触发不受限）。 */
  isDreamSkipped(sessionId) {
    return this.getMemoryScope(sessionId).dream;
  }
  /** 全部被跳过的会话 id（client 全量对账用，v0.30.0 起为 dream 档子集）。 */
  listDreamSkips() {
    return this.listMemoryScopes().filter((s) => s.dream).map((s) => s.session_id);
  }
  // ── 全局检查门（dream 定时器防叠加） ─────────────────────────────────────
  // 根因：插件热重载/多实例并存时，dispose 未必清理旧 setInterval → 多个定时器
  // 叠加 → 检查频率远高于 checkMinutes，同一窗口被反复 start。检查动作本身
  // 必须幂等：DB 原子抢占"检查窗口"（minIntervalMs 内只有一个实例通过），
  // 与 startWindowDream 的 claimDream（start 幂等）+ recoverInterruptedDream
  // （中断自愈）组成三层防重复闭环。
  /** 原子抢占一次检查窗口：minIntervalMs 内只有一个调用方返回 true。 */
  claimCheckGate(minIntervalMs) {
    this.p(`INSERT OR IGNORE INTO dream_meta (key, value) VALUES ('last_check', 0)`).run();
    const now = Date.now();
    return this.db.prepare(`UPDATE dream_meta SET value = ? WHERE key = 'last_check' AND value <= ?`).run(now, now - minIntervalMs).changes === 1;
  }
  getWindow(sessionId) {
    return this.p(`SELECT * FROM windows WHERE session_id = ?`).get(sessionId);
  }
  listWindows() {
    return this.p(`SELECT * FROM windows ORDER BY last_event_time DESC`).all();
  }
  /** 本窗口建立的全部条目 id（dream 收尾：updated_at 批量写入用）。 */
  idsBySession(sessionId) {
    const out = [];
    for (const level of LEVELS) {
      const rows = this.p(`SELECT id FROM ${level} WHERE source_session = ?`).all(sessionId);
      for (const r of rows) out.push({ level, id: r.id });
    }
    return out;
  }
  /** 批量写记忆时间戳（dream 收尾：本窗口条目 updated_at = 窗口最后对话时间 T；
   *   MAX 防止覆盖 T 之后的 memory_update 刷新）。 */
  stampDream(sessionId, time) {
    let n = 0;
    for (const { level, id } of this.idsBySession(sessionId)) {
      n += this.p(`UPDATE ${level} SET updated_at = MAX(updated_at, ?) WHERE id = ?`).run(time, id).changes;
    }
    return n;
  }
  fromRow(level, r) {
    let keywords = [];
    try {
      keywords = JSON.parse(String(r.keywords ?? "[]"));
    } catch {
      keywords = [];
    }
    return {
      id: String(r.id),
      level,
      title: r.title == null ? null : String(r.title),
      content: String(r.content),
      importance: Number(r.importance ?? 1),
      keywords,
      status: String(r.status),
      corrected: Number(r.corrected ?? 0),
      project: r.project == null ? null : String(r.project),
      subcategory: r.subcategory == null ? null : String(r.subcategory),
      goal: r.goal == null ? null : String(r.goal),
      source_session: r.source_session == null ? null : String(r.source_session),
      hit_count: Number(r.hit_count ?? 0),
      // [macro-fusion 0.4.0] 真被 memory_read 打开过几次。老库补列前是 undefined → 0，
      // 所以「0 次」在这里永远是「没记过」，不是「记过但没读」——体检的 unused 靠这条区分。
      read_count: Number(r.read_count ?? 0),
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
      last_accessed_at: r.last_accessed_at == null ? null : Number(r.last_accessed_at)
    };
  }
};
var dbCache = /* @__PURE__ */ new Map();
function getDb(workspace, dir = ".dsh-meow") {
  const key = `${workspace}\0${dir}`;
  let db = dbCache.get(key);
  if (!db) {
    const path = memoryDbPath(workspace, dir);
    const creating = !existsSync4(path);
    db = new MemoryDb(path);
    if (creating) registerCreatedWorkspace(workspace, dir);
    dbCache.set(key, db);
  }
  return db;
}
function closeAllDbs() {
  for (const db of dbCache.values()) db.close();
  dbCache.clear();
}
function backupMemoryDb(workspace, dir = ".dsh-meow") {
  try {
    const dbPath = memoryDbPath(workspace, dir);
    if (!existsSync4(dbPath)) return false;
    const bakPath = `${dbPath}.bak`;
    let dataMtime = statSync(dbPath).mtimeMs;
    const walPath = `${dbPath}-wal`;
    if (existsSync4(walPath)) dataMtime = Math.max(dataMtime, statSync(walPath).mtimeMs);
    if (existsSync4(bakPath) && statSync(bakPath).mtimeMs >= dataMtime) return false;
    const tmp = `${bakPath}.tmp`;
    getDb(workspace, dir).vacuumInto(tmp);
    renameSync3(tmp, bakPath);
    return true;
  } catch {
    return false;
  }
}
var dreamWorkspace = null;
function getDreamWorkspace() {
  return dreamWorkspace;
}

// src/delegate.ts
function parseModelSpec(spec) {
  const trimmed = spec?.trim();
  if (!trimmed) return void 0;
  const idx = trimmed.indexOf("/");
  if (idx > 0 && idx < trimmed.length - 1) {
    return { provider: trimmed.slice(0, idx), model: trimmed.slice(idx + 1) };
  }
  return { model: trimmed };
}
var REFLECT_DELEGATE_MARKER = "\u3010\u8BB0\u5FC6\u53CD\u601D\u6807\u8BB0\u3011";
var DREAM_DELEGATE_MARKER = "\u3010\u8BB0\u5FC6\u6574\u7406\u6807\u8BB0\u3011";
var REFLECT_DONE_DELEGATE_MARKER = "\u3010\u8BB0\u5FC6\u53CD\u601D\u5B8C\u6210\u6807\u8BB0\u3011";

// src/defaults.ts
var DEFAULT_RULES_REVIEW_DAYS = 2;
var CONFIG_DEFAULTS = {
  enabled: true,
  projectDir: ".dsh-meow",
  hitTopK: 2,
  titleMax: 40,
  reflect: true,
  reflectTurns: 7,
  autoMigrate: true,
  /** 全局目录选择：''=默认（平台用户主目录）；预设标记或绝对路径见 home-dir.ts。
   *  恢复默认写入 ''（而非删字段）=回落平台默认目录。 */
  homeDir: "",
  dream: {
    enabled: true,
    idleMinutes: 180,
    suppressWindows: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }],
    suppressLeadMinutes: 15,
    checkMinutes: 15,
    timeZone: "Asia/Shanghai",
    rulesReviewDays: DEFAULT_RULES_REVIEW_DAYS
  },
  delegate: { model: "", effort: "" },
  /** 记忆库自动备份（#37 增量②，默认关）：开启后每次 dream 收尾把 memory.db
   *  快照轮转到 memory.db.bak（VACUUM INTO 一致性备份）。 */
  backup: { enabled: false },
  /** 工作区停用名单（#28）：列出的工作区（cwd 归一匹配）完全停用记忆——读/整理/写
   *  全部拒绝（含手动 /dream）。用于一次性任务的工作区，避免污染记忆库。 */
  disabledWorkspaces: []
};
function factoryDefaultOf(spec) {
  const scope = spec.sub === void 0 ? CONFIG_DEFAULTS : CONFIG_DEFAULTS[spec.sub];
  if (scope === void 0 || scope === null || typeof scope !== "object") return void 0;
  return scope[spec.key];
}

// src/migrate-v0.ts
import { zstdCompressSync, zstdDecompressSync, constants } from "node:zlib";
import { readdirSync as readdirSync3, readFileSync as readFileSync4, writeFileSync as writeFileSync3, existsSync as existsSync5, mkdirSync as mkdirSync4, copyFileSync, renameSync as renameSync4, statSync as statSync2 } from "node:fs";
import { join as join5, relative, dirname as dirname4 } from "node:path";
import { homedir as homedir2 } from "node:os";
var PLUGIN = "meow-memory";
var META_SECTION_NAME = "__meta__";
var PLUGIN_MARKER = `"plugin":"${PLUGIN}"`;
var MEMORY_KEY = '"memory":';
var SECTIONS_KEY = '"sections":[';
var STATE_FILE = "migrate-v0-state.json";
var ZSTD_MAGIC = 4247762216;
var CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
function statePath() {
  return join5(activeHomeDir(), STATE_FILE);
}
function readMigrateState() {
  try {
    return JSON.parse(readFileSync4(statePath(), "utf8"));
  } catch {
    return {};
  }
}
function writeMigrateState(state) {
  const p = statePath();
  mkdirSync4(dirname4(p), { recursive: true });
  writeFileSync3(p, JSON.stringify(state, null, 1), "utf8");
}
function scanFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    const start = offset;
    if (buf.length - offset < 4) throw new Error("torn frame header");
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buf.length) throw new Error("torn frame after magic");
    const descriptor = buf.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error("reserved frame-header bit");
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buf.length - offset < remainingHeaderBytes) throw new Error("torn frame header fields");
    offset += remainingHeaderBytes;
    for (; ; ) {
      if (buf.length - offset < 3) throw new Error("torn block header");
      const blockHeader = buf.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = blockHeader >>> 1 & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error("reserved block type");
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buf.length - offset < payloadBytes) throw new Error("torn block payload");
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buf.length - offset < 4) throw new Error("torn checksum");
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}
function decompressAllFrames(buf) {
  const frames = scanFrames(buf);
  const parts = [];
  for (const f of frames) parts.push(zstdDecompressSync(buf.subarray(f.start, f.end)));
  return Buffer.concat(parts);
}
var compressFrame = (input) => zstdCompressSync(input, CHECKSUM_OPTIONS);
function collectPluginMemories(node, hits) {
  if (Array.isArray(node)) {
    for (const v of node) collectPluginMemories(v, hits);
    return;
  }
  if (node && typeof node === "object") {
    const o = node;
    if (o.kind === "plugin" && o.plugin === PLUGIN && Object.prototype.hasOwnProperty.call(o, "memory")) {
      hits.push({ form: o.form, memory: o.memory });
    }
    for (const k of Object.keys(o)) collectPluginMemories(o[k], hits);
  }
}
function balancedObjectAt(line, fromIdx) {
  const objStart = line.lastIndexOf("{", fromIdx);
  if (objStart < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = objStart; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return { objStart, objText: line.slice(objStart, i + 1) };
    }
  }
  return null;
}
function balancedValueEnd(text, valueStart) {
  let depth = 0, inStr = false, esc = false;
  for (let i = valueStart; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      if (depth === 0) return i;
      depth--;
      if (depth === 0) return i + 1;
    } else if (ch === "," && depth === 0) return i;
  }
  return -1;
}
function locateNextMemory(out) {
  let searchFrom = 0;
  for (let guard = 0; guard < 50; guard++) {
    const pluginIdx = out.indexOf(PLUGIN_MARKER, searchFrom);
    if (pluginIdx < 0) return null;
    searchFrom = pluginIdx + 1;
    const obj = balancedObjectAt(out, pluginIdx);
    if (!obj) continue;
    let parsedObj;
    try {
      parsedObj = JSON.parse(obj.objText);
    } catch {
      continue;
    }
    if (!parsedObj || parsedObj.plugin !== PLUGIN || !Object.prototype.hasOwnProperty.call(parsedObj, "memory")) continue;
    const memKeyRel = obj.objText.indexOf(MEMORY_KEY);
    if (memKeyRel < 0) continue;
    const valStartRel = memKeyRel + MEMORY_KEY.length;
    const valEndRel = balancedValueEnd(obj.objText, valStartRel);
    if (valEndRel < 0) continue;
    const valueText = obj.objText.slice(valStartRel, valEndRel);
    const hasSections = Array.isArray(parsedObj.sections);
    let sectionsInsertAt = -1;
    let sectionsEmpty = false;
    if (hasSections) {
      const sKeyRel = obj.objText.indexOf(SECTIONS_KEY, valEndRel);
      if (sKeyRel < 0) return { memoryStart: -1, memoryEnd: -1, valueText: "", hasSections, sectionsInsertAt: -1, sectionsEmpty, refusal: "sections-array-but-no-key-after-memory" };
      sectionsInsertAt = obj.objStart + sKeyRel + SECTIONS_KEY.length;
      sectionsEmpty = out[sectionsInsertAt] === "]";
      if (sectionsInsertAt < obj.objStart + valEndRel) return { memoryStart: -1, memoryEnd: -1, valueText: "", hasSections, sectionsInsertAt: -1, sectionsEmpty, refusal: "sections-before-memory" };
    }
    return { memoryStart: obj.objStart + memKeyRel, memoryEnd: obj.objStart + valEndRel, valueText, hasSections, sectionsInsertAt, sectionsEmpty, form: parsedObj.form };
  }
  return null;
}
function removeMemberAt(line, memStart, memEnd) {
  if (line[memEnd] === ",") return line.slice(0, memStart) + line.slice(memEnd + 1);
  if (line[memStart - 1] === ",") return line.slice(0, memStart - 1) + line.slice(memEnd);
  return line.slice(0, memStart) + line.slice(memEnd);
}
function migrateLine(line) {
  if (!line.includes(PLUGIN_MARKER) || !line.includes(MEMORY_KEY)) return { line, changed: 0 };
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { line, changed: 0, note: "unparsable-line" };
  }
  const pre = [];
  collectPluginMemories(parsed, pre);
  if (pre.length === 0) return { line, changed: 0 };
  const preCanons = new Set(pre.map((p) => JSON.stringify(p.memory)));
  let out = line;
  let changed = 0;
  for (let guard = 0; guard < 10; guard++) {
    const loc = locateNextMemory(out);
    if (!loc) break;
    if (loc.refusal) return { line, changed, note: "refused:" + loc.refusal };
    let memVal;
    try {
      memVal = JSON.parse(loc.valueText);
    } catch {
      return { line, changed, note: "memory-value-unparsable" };
    }
    if (!preCanons.has(JSON.stringify(memVal))) return { line, changed, note: "byte-structure-mismatch" };
    if (loc.hasSections) {
      if (loc.form !== "snapshot") return { line, changed, note: "sections-with-form-" + loc.form };
      const metaSection = `{"name":"${META_SECTION_NAME}","text":${JSON.stringify(loc.valueText)}}`;
      out = out.slice(0, loc.sectionsInsertAt) + metaSection + (loc.sectionsEmpty ? "" : ",") + out.slice(loc.sectionsInsertAt);
      out = removeMemberAt(out, loc.memoryStart, loc.memoryEnd);
    } else if (loc.form === "notice") {
      out = removeMemberAt(out, loc.memoryStart, loc.memoryEnd);
    } else {
      return { line, changed, note: "unsupported-form-" + loc.form };
    }
    changed++;
  }
  if (changed === 0) return { line, changed: 0, note: "located-but-not-migrated" };
  let reparsed;
  try {
    reparsed = JSON.parse(out);
  } catch {
    return { line, changed: 0, note: "post-parse-failed" };
  }
  const leftover = [];
  collectPluginMemories(reparsed, leftover);
  if (leftover.length > 0) return { line, changed: 0, note: "post-memory-remains" };
  return { line: out, changed };
}
function listSessionFiles(home) {
  const files = [];
  for (const rootName of ["sessions", "archived-sessions"]) {
    const root = join5(home, rootName);
    if (!existsSync5(root)) continue;
    for (const proj of readdirSync3(root)) {
      const projDir = join5(root, proj);
      let st;
      try {
        st = statSync2(projDir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      for (const sid of readdirSync3(projDir)) {
        const f = join5(projDir, sid, "session.jsonl.zstd");
        if (existsSync5(f)) files.push(f);
      }
    }
  }
  return files;
}
function backupPathFor(home, file) {
  const rel = relative(home, file);
  if (rel.startsWith("..")) return file + ".pre-migrate.bak";
  return join5(home, "pre-migrate-backup", rel);
}
function processFile(home, file, log) {
  const rawBuf = readFileSync4(file);
  const raw = decompressAllFrames(rawBuf).toString("utf8");
  if (!raw.includes(PLUGIN_MARKER) || !raw.includes(MEMORY_KEY)) return { migrated: 0 };
  const lines = raw.split("\n");
  let changed = 0;
  const notes = [];
  const outLines = lines.map((l) => {
    if (!l.includes(PLUGIN_MARKER) || !l.includes(MEMORY_KEY)) return l;
    try {
      const r = migrateLine(l);
      if (r.note) notes.push(r.note);
      if (r.changed > 0) {
        changed += r.changed;
        return r.line;
      }
      return l;
    } catch (e) {
      notes.push("line-error: " + (e instanceof Error ? e.message : String(e)));
      return l;
    }
  });
  if (changed === 0) return { migrated: 0, note: notes.join(";") };
  const backup = backupPathFor(home, file);
  mkdirSync4(dirname4(backup), { recursive: true });
  if (!existsSync5(backup)) copyFileSync(file, backup);
  const headerLine = outLines[0] ?? "";
  const bodyText = outLines.length > 1 ? outLines.slice(1).join("\n") : "";
  const headerFrame = compressFrame(Buffer.from(headerLine + "\n", "utf8"));
  const frames = [headerFrame];
  if (bodyText.length > 0) frames.push(compressFrame(Buffer.from(bodyText, "utf8")));
  const outBuf = Buffer.concat(frames);
  const tmpOut = file + ".migrated.tmp.zst";
  writeFileSync3(tmpOut, outBuf);
  renameSync4(tmpOut, file);
  log(`migrated ${changed} line(s) in ${file}`);
  return { migrated: changed };
}
async function ensureV0SessionsMigrated(projectDir, log) {
  const state = readMigrateState();
  if (state.migrated === true) return { ran: false, reason: "already-migrated" };
  const home = process.env.DSH_HOME || join5(homedir2(), ".dsh");
  if (!existsSync5(home)) {
    log("meow-memory migrate-v0: DSH_HOME not found, skip");
    return { ran: false, reason: "no-home" };
  }
  const report = { ran: true, scanned: 0, filesMigrated: 0, linesMigrated: 0, errors: [] };
  let files;
  try {
    files = listSessionFiles(home);
  } catch (e) {
    return { ran: false, reason: "list-failed: " + (e instanceof Error ? e.message : String(e)) };
  }
  report.scanned = files.length;
  for (const f of files) {
    try {
      const r = processFile(home, f, log);
      if (r.migrated > 0) {
        report.filesMigrated = (report.filesMigrated ?? 0) + 1;
        report.linesMigrated = (report.linesMigrated ?? 0) + r.migrated;
      }
    } catch (e) {
      report.errors.push({ file: f, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if ((report.errors?.length ?? 0) === 0) {
    writeMigrateState({
      migrated: true,
      migratedAt: (/* @__PURE__ */ new Date()).toISOString(),
      files: report.filesMigrated,
      lines: report.linesMigrated
    });
  } else {
    log(`meow-memory migrate-v0: ${report.errors.length} file(s) failed; NOT setting migrated flag (will retry next boot)`);
  }
  log(`meow-memory migrate-v0: done. scanned=${report.scanned} filesMigrated=${report.filesMigrated} linesMigrated=${report.linesMigrated} errors=${report.errors.length}`);
  return report;
}

// src/dream.ts
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { appendFileSync, existsSync as existsSync6, readdirSync as readdirSync4, readFileSync as readFileSync6 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join7 } from "node:path";

// src/inject.ts
import { mkdirSync as mkdirSync5, readFileSync as readFileSync5, writeFileSync as writeFileSync4 } from "node:fs";
import { dirname as dirname5, join as join6 } from "node:path";

// src/bm25.ts
var CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3005\u30fc]/u;
var WORD = /[\p{L}\p{N}]/u;
function classify(cp) {
  if (CJK.test(cp)) return "cjk";
  if (WORD.test(cp)) return "word";
  return "skip";
}
// [macro-fusion 0.2.119] 词法归一的开关以前挂在「会话提示词语言」上：只有 promptLang 是 en 时
// 才走 normalizeEn（英文停用词 + Porter 词干）。而 DEFAULT_LANG 就是 zh —— 于是中文用户存下的
// 英文记忆永远不归一：researching 和 research 在索引里是两个词，camping 和 camp 也是，
// BM25 各算各的 idf，两条本该互相命中的记忆彼此看不见（LoCoMo 实测：问「What did Caroline
// research?」，记忆里写的是 Researching adoption agencies，零词交集，直接不进候选）。
// 语言该由这段文本自己说，不是由谁在问：拉丁字母占多数的文本照样归一，中日韩二元组原样保留。
function isMostlyLatin(tokens) {
  if (tokens.length === 0) return false;
  let latin = 0;
  for (const t of tokens) if (/^[a-z]+$/.test(t)) latin += 1;
  return latin * 2 >= tokens.length;
}
function tokenize(text) {
  const cps = Array.from(text.normalize("NFKC"));
  const out = [];
  let i = 0;
  while (i < cps.length) {
    const cls = classify(cps[i]);
    if (cls === "skip") {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < cps.length && classify(cps[j]) === cls) j++;
    const run = cps.slice(i, j);
    if (cls === "cjk") {
      if (run.length >= 2) {
        for (let k = 0; k + 1 < run.length; k++) out.push(run[k] + run[k + 1]);
      }
    } else {
      out.push(run.join("").toLowerCase());
    }
    i = j;
  }
  return isMostlyLatin(out) ? normalizeEn(out) : out;
}
var EN_STOPWORDS = /* @__PURE__ */ new Set([
  "a",
  "about",
  "above",
  "after",
  "again",
  "against",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can",
  "cannot",
  "could",
  "d",
  "did",
  "do",
  "does",
  "doing",
  "don",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "hers",
  "herself",
  "him",
  "himself",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "itself",
  "just",
  "ll",
  "m",
  "me",
  "more",
  "most",
  "my",
  "myself",
  "no",
  "nor",
  "not",
  "now",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "ought",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "re",
  "s",
  "same",
  "she",
  "should",
  "so",
  "some",
  "such",
  "t",
  "than",
  "that",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "ve",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "whom",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
  "yours",
  "yourself",
  "yourselves"
]);
function normalizeEn(tokens) {
  const out = [];
  for (const t of tokens) {
    if (EN_STOPWORDS.has(t)) continue;
    out.push(/^[a-z]+$/.test(t) ? stemEn(t) : t);
  }
  return out;
}
var PORTER_STEP2 = {
  ational: "ate",
  tional: "tion",
  enci: "ence",
  anci: "ance",
  izer: "ize",
  bli: "ble",
  alli: "al",
  entli: "ent",
  eli: "e",
  ousli: "ous",
  ization: "ize",
  ation: "ate",
  ator: "ate",
  alism: "al",
  iveness: "ive",
  fulness: "ful",
  ousness: "ous",
  aliti: "al",
  iviti: "ive",
  biliti: "ble",
  logi: "log"
};
var PORTER_STEP3 = {
  icate: "ic",
  ative: "",
  alize: "al",
  iciti: "ic",
  ical: "ic",
  ful: "",
  ness: ""
};
var CONS = "[^aeiou]";
var VOW = "[aeiouy]";
var CONS_SEQ = `${CONS}[^aeiouy]*`;
var VOW_SEQ = `${VOW}[aeiou]*`;
var MGR0 = new RegExp(`^(${CONS_SEQ})?${VOW_SEQ}${CONS_SEQ}`);
var MEQ1 = new RegExp(`^(${CONS_SEQ})?${VOW_SEQ}${CONS_SEQ}(${VOW_SEQ})?$`);
var MGR1 = new RegExp(`^(${CONS_SEQ})?${VOW_SEQ}${CONS_SEQ}${VOW_SEQ}${CONS_SEQ}`);
var HAS_VOWEL = new RegExp(`^(${CONS_SEQ})?${VOW}`);
function stemEn(word) {
  let w = word;
  if (w.length <= 2) return w;
  if (/(ss|i)es$/.test(w)) w = w.replace(/(ss|i)es$/, "$1");
  else if (/([^s])s$/.test(w)) w = w.replace(/([^s])s$/, "$1");
  if (/eed$/.test(w)) {
    const stem = w.slice(0, -3);
    if (MGR0.test(stem)) w = w.slice(0, -1);
  } else if (/(ed|ing)$/.test(w)) {
    const stem = w.replace(/(ed|ing)$/, "");
    if (HAS_VOWEL.test(stem)) {
      w = stem;
      if (/(at|bl|iz)$/.test(w)) w += "e";
      else if (/([^aeiouylsz])\1$/.test(w)) w = w.slice(0, -1);
      else if (new RegExp(`^${CONS_SEQ}${VOW}[^aeiouwxy]$`).test(w)) w += "e";
    }
  }
  if (/y$/.test(w)) {
    const stem = w.slice(0, -1);
    if (HAS_VOWEL.test(stem)) w = `${stem}i`;
  }
  for (const [suffix, repl] of Object.entries(PORTER_STEP2)) {
    if (w.endsWith(suffix)) {
      const stem = w.slice(0, -suffix.length);
      if (MGR0.test(stem)) w = stem + repl;
      break;
    }
  }
  for (const [suffix, repl] of Object.entries(PORTER_STEP3)) {
    if (w.endsWith(suffix)) {
      const stem = w.slice(0, -suffix.length);
      if (MGR0.test(stem)) w = stem + repl;
      break;
    }
  }
  const step4 = /(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;
  if (step4.test(w)) {
    const stem = w.replace(step4, "");
    if (MGR1.test(stem)) w = stem;
  } else if (/(s|t)(ion)$/.test(w)) {
    const stem = w.replace(/(s|t)(ion)$/, "$1");
    if (MGR1.test(stem)) w = stem;
  }
  if (/e$/.test(w)) {
    const stem = w.slice(0, -1);
    if (MGR1.test(stem) || MEQ1.test(stem) && !new RegExp(`^${CONS_SEQ}${VOW}[^aeiouwxy]$`).test(stem)) w = stem;
  }
  if (/ll$/.test(w) && MGR1.test(w)) w = w.slice(0, -1);
  return w;
}
// [macro-fusion 0.6.6] keywords 的形态不止一种：真数组、逗号/顿号分隔的一整串、甚至 JSON 字符串。
// 引擎里凡是「把 keywords 当词表用」的地方都必须走这一个入口——形态不同不该等于这条记忆不存在。
function kwList(d) {
  const raw = d?.keywords;
  if (Array.isArray(raw)) return raw.filter((w) => typeof w === "string" && w.length > 0);
  if (typeof raw !== "string") return [];
  const s = raw.trim();
  if (s === "") return [];
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.filter((w) => typeof w === "string" && w.length > 0);
    } catch {
      // 不是合法 JSON 就按分隔符切，别把整串丢掉
    }
  }
  return s.split(/[,，、;；]/).map((w) => w.trim()).filter((w) => w.length > 0);
}
// [macro-fusion 0.6.7] 库是一条条记录的集合，其中一条是 null/undefined/标量（坏行、半写行、调用方拼错），
// 不该让整次检索抛异常：入口把非对象元素筛掉。原数组本来就干净时**返回同一个引用**，
// 索引缓存（按数组身份判等）不会被这次过滤悄悄打掉。
function liveDocs(docs) {
  if (!Array.isArray(docs)) return [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    if (!d || typeof d !== "object") {
      return docs.filter((x) => x && typeof x === "object");
    }
  }
  return docs;
}
function docText(d) {
  // [macro-fusion 0.6.6] 一条脏记忆不许把整次检索打成异常：老库里 keywords 可能是 null / undefined /
  // 逗号串（导入的行、别的插件写的行、调用方自己拼的 docs），而这里原来直接 `...d.keywords`——
  // 一条缺字段的条目就让 verbatimInputs 在遍历时抛 TypeError，整个 search 变异常而不是「少一条」。
  return [d.title ?? "", d.content ?? "", kwList(d).join(" ")].join(" ");
}
// [macro-fusion 0.2.131] 会话主题扩展：一条 20 字的短条目接不住问句的三四个实词——数据侧证据是
// omni33/34/35（LoCoMo 649 题同题配对）：把「这一段对话里 tf-idf 最高的 12 个实词」补给条目，
// 准确率 39.3% → 46.7%（净 +48，p<0.0001）；同样 12 个「全局高频词」只值 +10（p=0.1986）；
// 把这条要求写进写入提示词让模型自己写，只值 +2（p=0.9310，关键词 4.87→5.95 也没用）。
// 也就是说：主题词必须从语料算出来，不能靠纪律。这里在检索时按 source_session 现算，
// 不落盘、不进回执、不改一条记忆的正文。
const SESS_TOPIC_MIN = 3;
const SESS_TOPIC_TERMS = 12;
function sessionTopicTerms(docs, docToks) {
  const bySess = /* @__PURE__ */ new Map();
  for (let i = 0; i < docs.length; i++) {
    const s = docs[i]?.source_session;
    if (!s) continue;
    if (!bySess.has(s)) bySess.set(s, []);
    bySess.get(s).push(i);
  }
  if (bySess.size === 0) return null;
  const total = bySess.size;
  const sessDf = /* @__PURE__ */ new Map();
  for (const [, idxs] of bySess) {
    const seen = /* @__PURE__ */ new Set();
    for (const i of idxs) for (const t of docToks[i]) seen.add(t);
    for (const t of seen) sessDf.set(t, (sessDf.get(t) ?? 0) + 1);
  }
  const out = /* @__PURE__ */ new Map();
  for (const [sess, idxs] of bySess) {
    if (idxs.length < SESS_TOPIC_MIN) continue;
    const tf = /* @__PURE__ */ new Map();
    for (const i of idxs) for (const t of docToks[i]) tf.set(t, (tf.get(t) ?? 0) + 1);
    const ranked = [...tf.entries()].filter(([t]) => t.length >= 2 && !EN_STOPWORDS.has(t)).map(([t, f]) => [t, f * Math.log(1 + total / (sessDf.get(t) ?? 1))]).sort((a, b) => b[1] - a[1]).slice(0, SESS_TOPIC_TERMS).map(([t]) => t);
    if (ranked.length > 0) out.set(sess, ranked);
  }
  return out.size > 0 ? out : null;
}
function recencyWeight(ageMs) {
  const days = ageMs / 864e5;
  if (days < 1) return 1;
  if (days < 2) return 0.9;
  if (days < 4) return 0.8;
  if (days < 7) return 0.65;
  if (days < 15) return 0.5;
  if (days < 30) return 0.35;
  if (days < 60) return 0.25;
  if (days < 180) return 0.15;
  return 0.08;
}
// [macro-fusion 0.2.122] 实体先验：问句里的专有名词（"What did Caroline research?" 里的 Caroline）
// 是这条记忆到底在不在讲那件事的最硬信号，而 BM25 把它和别的词一样对待——一个提到 Caroline 五次、
// 却没提到 research 的近邻条目会输给一个只提到 research 的无关段落。离线台实测（LoCoMogit 1,540 题）：
// hit@20 0.7331 → 0.7513、MRR 0.4551 → 0.4784。只做乘性加成、不改候选集，问句里没有专有名词时
// 一个字节都不动（中文问句就是这种情况：CJK 没有大小写，这条先验天然不生效）。
const EN_INITIAL_SKIP = /* @__PURE__ */ new Set(["what", "who", "when", "where", "why", "how", "which", "whose", "did", "does", "do", "is", "are", "was", "were", "can", "could", "would", "should", "will", "shall", "may", "might", "must", "the", "a", "an", "my", "our", "his", "her", "their", "your", "please", "tell", "show", "find", "list", "give", "get", "also", "and", "but", "if", "in", "on", "at", "for", "from", "to", "of", "it", "this", "that", "these", "those", "there", "here", "then", "now", "last", "next", "first", "second"]);
function queryEntities(query) {
  const out = [];
  for (const m of String(query ?? "").matchAll(/\b([A-Z][a-z]{2,})\b/g)) {
    if ((m.index ?? 0) === 0) continue;
    const low = m[1].toLowerCase();
    if (EN_INITIAL_SKIP.has(low) || EN_STOPWORDS.has(low)) continue;
    if (!out.includes(low)) out.push(low);
  }
  return out;
}
// [macro-fusion 0.2.140] 状态不进打分的后果：stale（已完结 / 被取代）和 archived（作废）的条目
// 只靠"status 过滤是检索前二值"这一条挡着——默认 status=null 时它们**全都参与**检索，
// 而且分数只由 bm25 × 重要度 × 新鲜度决定。于是一条刚被你标 stale 的旧结论，只要措辞更贴，
// 会稳稳排在接手它的那条前面，回执上只差一个 `（stale）` 字样。准确性不是"能召回"，是
// "召回的是现在还对的那条"：这里给状态一个统一的权重，两个打分器（BM25 与关键词）同口径。
// 只降权、不隐藏——历史仍可召回（可追溯性），只是不许压过在用的结论。
var STATUS_WEIGHT = { active: 1, stale: 0.6, archived: 0.35 };
function statusWeight(status) {
  const s = String(status ?? "active");
  return STATUS_WEIGHT[s] ?? 1;
}
// [macro-fusion 0.2.146] 噪声地板：中文没有停用词表（英文靠 normalizeEn 的 EN_STOPWORDS），
// 于是「怎么 / 那个 / 现在 / 一下」这类词在 BM25 里照样有分数、照样进覆盖度分母。
// 后果不是「排得差一点」而是**候选集被噪声撑大**：库里三分之一条目都含「怎么」时，
// 问「怎么把延迟调下来」，那些只沾了「怎么」的条目会一起被召回，回执上看起来「都沾点边」。
// 这里改用数据说话——出现在**一半以上**条目里的查询词，就是这一问里的噪声，直接不参与打分。
// 三条护栏：①库小（<8 条）时 df 不可信，一条都不剔；②剔完一个词不剩就整段回退（宁可噪声，不许空）；
// ③`noiseFloor:false` 一键回到旧口径，便于对照。
var NOISE_DF_RATIO = 0.5;
var NOISE_MIN_DOCS = 8;
function noiseTermsOf(qTerms, df, n) {
  if (n < NOISE_MIN_DOCS) return [];
  const gate = Math.ceil(n * NOISE_DF_RATIO);
  const out = [];
  for (const t of qTerms) if ((df.get(t) ?? 0) >= gate) out.push(t);
  return out.length >= qTerms.length ? [] : out;
}
// [macro-fusion 0.2.151] 问句里的虚词不算证据。
// 0.2.146 的噪声地板只认「到处都是」的词（df ≥ 一半），它治不了另一半噪声：**哪都没有、却毫无信息**
// 的虚词碎片。实测问「高铁票怎么改签」，`怎么` 在本库 df=1、idf 高得离谱，于是一条只沾「怎么」的
// 条目就上了桌（4.76 分）；十四条与记忆库毫无关系的问句里，十条都这样硬凑出回执——沉默被当成了失职，
// 回执被当成了业绩。英文早就靠 EN_STOPWORDS 把这类词挡在外面，中文这边一直空着（0.2.146 注释里写着
// 「中文没有停用词表」），这一刀把这张表补上。
// 三条护栏：①只对中文虚词生效，标识符与英文词一个不动；②剔完一个词不剩就整段回退（问句只由虚词组成时，
// 宁可照旧打分，不许凭空空手）；③`funcFloor:false` 一键回到旧口径，便于对照。
var CJK_FUNC_WORDS = new Set([
  // 单字
  "的", "了", "是", "在", "和", "与", "及", "或", "而", "但", "也", "都", "就", "还", "又", "再",
  "才", "只", "把", "被", "给", "让", "对", "从", "向", "到", "为", "以", "之", "其", "此", "这",
  "那", "哪", "谁", "什", "怎", "几", "我", "你", "他", "她", "它", "们", "个", "些", "吗", "呢",
  "吧", "啊", "呀", "哦", "嗯", "么", "嘛", "着", "过", "得", "地", "该", "咋",
  // 双字虚词与问句骨架
  "怎么", "什么", "为什", "么样", "怎样", "如何", "为何", "哪些", "哪个", "哪里", "哪儿", "哪些",
  "多少", "是否", "可否", "可以", "应该", "需要", "已经", "现在", "时候", "一个", "这个", "那个",
  "这样", "那样", "这些", "那些", "我们", "你们", "他们", "它们", "自己", "一下", "一次", "一点",
  "一些", "一段", "还是", "就是", "也是", "都是", "不是", "不要", "没有", "要不", "能不", "会不", "是不", "有没",
  "到底", "究竟", "那么", "这么", "多么", "然后", "接着", "因此", "于是", "不过", "其实", "好像",
  "之前", "之后", "以后", "以前", "因为", "所以", "但是", "而且", "或者", "如果", "虽然", "即使",
  "并且", "以及", "关于", "对于", "由于", "除了", "而是", "不是", "就是", "只是", "还要", "还会",
  // 分词跨界的碎片：这些两字组本身没有意义，却常常在文档里出现
  "用的", "的天", "的时", "的上", "的一", "了一", "了个", "上个", "上一", "下一", "来的", "去的",
  "有的", "没的", "是的", "了的", "么一", "送为", "为什", "么办", "么样", "能怎", "样才", "么才",
]);
function funcTermsOf(qTerms) {
  const out = [];
  for (const t of qTerms) if (CJK_FUNC_WORDS.has(t)) out.push(t);
  return out.length >= qTerms.length ? [] : out;
}
// [macro-fusion 0.2.170] 疑问框架整段剥掉：0.2.151 那张虚词表治的是「双字虚词」，治不了**跨界碎片**。
// 中文按 bigram 切，「什么时候」会变成 `什么 / 么时 / 时候`——表里挡掉了「什么」「时候」，
// 「么时」这种没有意义的碎片漏了网，于是谁的内容里写着「什么时候」，谁就能靠碎片赢下榜首：
// 真库 554 条、换说池 13 题里，#3（什么时候才轮到把代码放到远端仓库）与 #7（它自己什么时候该回头
// 反省一次）的榜首都是同一条『JS 正则里的 \b 对中文不成立……「什么时候」这类中文闸门词必须……』，
// 它靠一个「么时」拿了 9.24 / 9.41 分，而正解只有 5.84 / 3.61。手工表列不完所有碎片，
// 所以在分词**之前**把整段疑问框架剥成空格（空格切断 bigram，不会把前后两个字粘成一个假词）。
// 读数（真库 554 条）：换说池首位 4/13 → 5/13（#3 第 2→第 1、#9 第 1→第 1），命中 11/13 不变，
// 平均回执 4.23 → 4.15 条；自找池（问句=关键词拼接，天然不含疑问词）525/554 · 首位 509 · 2.65 条 一位不动。
// 三条护栏：①剥完不到 4 个字符就整句回退（宁可带噪声，不许凭空空手）；②只作用于问句，不动索引；
// ③`questionStrip:false` 一键回到旧口径。
var QUESTION_FRAME = /什么时候|多久|怎么办|怎么|为什么|为啥|是不是|能不能|会不会|有没有|该不该|哪些|哪个|多少|是否|如何|是什么/g;
var QUESTION_FRAME_MIN = 4;
function stripQuestionFrame(text) {
  const raw = String(text ?? "");
  if (raw.length === 0) return { text: raw, stripped: [] };
  const matched = raw.match(/什么时候|什么时间|多长时间|多久|怎么办|怎么样|怎么|为什么|为啥|要不要|是不是|能不能|会不会|有没有|可不可以|需不需要|该不该|哪些|哪个|哪一|多少|是否|如何|什么叫|什么是|是什么/g) ?? [];
  if (matched.length === 0) return { text: raw, stripped: [] };
  const out = raw.replace(QUESTION_FRAME, " ").replace(/\s+/g, " ").trim();
  if (out.length < QUESTION_FRAME_MIN) return { text: raw, stripped: [] };
  // 同一段词被剥两次只报一次；顺序按首次出现，读者照着读得出来。
  return { text: out, stripped: [...new Set(matched)] };
}
// [macro-fusion 0.2.147] 标识符原样匹配：问句里真正决定答案的，常常是「原样才算数」的东西——
// 版本号（0.2.146）、路径（D:\dsh-home\vendor\...）、文件名（tools/probe-words.mjs）、
// 短 id（0mwq5zzv）、commit（c12e4f6）。分词会把它们打碎：0.2.146 -> 0 / 2 / 146，
// memory.db -> memori / db，tools/probe-words.mjs -> tools / probe / words / mjs。碎掉之后
// 问「0.2.146 改了什么」，参加打分的只剩「改了 / 什么」——回执上全是噪声，真正讲 0.2.146 的那条
// 根本不在榜上。所以在**原始字符串**这一层再认一次：只做加法补分、不改候选集也不改词口径。
// 四件事说明白：
//   ① 短于 4 个字符的不算标识符（`a/b`、`1.5` 太容易误中）；一条问句最多认 6 个。
//   ② 同一处证据不许记两遍：`tools/probe-words.mjs` 已经包含 `probe-words`，后者不再独立计分。
//   ③ 路径越短越可能是巧合：全串命中算 1，只命中 basename 算 0.7，再退到去掉扩展名的词干算 0.5。
//   ④ 命中的是这条记忆的 **id** 时，那不是「相关」，是**指认**——权重给到一个半最高分。
// 加法还顺带补了 BM25 的一个洞：原样命中但一个词都没接上的条目，先前连候选集都进不去。
var IDENT_MIN = 4;
var IDENT_MAX = 6;
// [macro-fusion 0.2.178] 时间状语里的标识符是「坐标」，不是「主语」。
// 「0.2.148 的时候基线收敛了两轮吗」——这里 0.2.148 只是把时间限定到那一天，答案可以是
// 任何讲基线收敛的条目；但 bandize 有一条特权通道：主语位命中标识符直接进第 -1 档。
// 于是谁正文里提到 0.2.148 谁就进第一档（实测：真正讲「基线至少收敛两轮」的 lesson
// bm25 22.29 排第二，被 bm25 8.54 / cover 0.13 的一行交付记录压住）。
// 但「0.2.147 那一版交付了什么」里的标识符不是坐标，是真在指认那一条——所以这条衰减
// 只对「X 的时候 / 在那天 / 那会儿」这类时间状语结构生效。判据放在结构词上，不放泛词上
//（跟 0.2.176 的局面词同一条道理）。
var ANCHOR_COORD_RE = /的时候|那会儿|那阵|那时候|当时|那天|那天的|那个时间点/;
var IDENT_W = 0.6;
var IDENT_ID_W = 1.5;
var IDENT_BAND_W = 0.8;
// [macro-fusion 0.2.172] 库里所有条目 title 都是空串（宏记忆写入时不落标题），所以「标题指认」这一刀没有着力点；
// 真正有指认力的是「这条记忆的主语就是它」——正文以问句点名的标识符开头。
var IDENT_SUBJ_W = 0;

// [macro-fusion 0.2.173] 问句的语法形态在说「我要哪一类东西」：问「要不要 / 该不该」是在问准则，
// 问「改了什么 / 交付态」是在问事实，问「怎么跑」是在问经验。层级（rules/fact/lesson/topic）本来
// 就是宏记忆自己分的类；问句意图和层级对不上时，让对得上的那条在竞争里往前挪一点。
// 只乘 _raw（分档读的那个数），默认权重 0——先量，量出来有用再给值。
var LEVEL_INTENT_W = 0.3;
var LEVEL_INTENT_RATIO = 0.5;
// [macro-fusion 0.2.174] 求值型问句要一条断言，不要一段背景：「publishTimestamp 该写什么值」
// 的正解是「必须是过去的秒级时间戳」，压在它上面的那条讲的是「有两套时间戳、别只改一处」——
// 词分都够，差的是「答的是不是问的那个」。断言词是「结论」的形状（必须/一律/只认/至少/只有），
// 背景叙述里没有它。只在问句是求值型（该写/该填/几个/几轮/多少）时开，且只抬不在榜首的条目：
// 榜首本来就是它要说的话，再抬一次只会把别处的正解压得更深。
var TIP_ASSERT_W = 1.2;
// [macro-fusion 0.2.176] 状态问句直通「现状仓」：问「现在到哪一版」时，答案不在字面里——
// 问句是「主线/推进/哪一版」，条目写的是「项目现状（0.2.175）…HEAD dcbebbe」，一个词都不重合。
// 实测真库 581 条池里那条 pos=-1（连候选都不是），读者拿到的是「分级放行」这种阶段偏好。
// 做法不是加大同义词表（那是拿一题一题喂出来的），而是承认这类问法问的是「当前局面」，
// 由 project 层里标记为现状/待办的那条按 updated_at 最新者直答。
// 两道自限：问句点了标识符（有 verbHay）就交回词法；问句在问原因/方法（为什么/怎么/要不要）
// 就不是问状态，不干预——否则「现在这个参数为什么是 0.25」会被塞一条项目现状。
var STATUS_RE = /到哪一版|推进到|进展到|主线停在哪|当前待办|现在待办|项目现状|现状如何|现状是什么|现在什么情况|截至|最近一次|最新版本/;
var STATUS_OFF_RE = /为什么|怎么|如何|缘由|踩过|技巧|办法|该不该|要不要|能不能|可不可以|是否/;
var STATUS_TODO_RE = /待办|todo/i;
var STATUS_NOW_RE = /项目现状|到哪一版|进展|推进到|最新版本|截至|最近一次/;
var STATUS_DIGEST_MAX = 3;
function statusDigestOf(docs, query, hasIdent, opts) {
  if (opts.statusDigest === false) return null;
  if (hasIdent) return null;
  const q = String(query ?? "");
  if (!STATUS_RE.test(q) || STATUS_OFF_RE.test(q)) return null;
  // 问哪个仓就只翻哪个仓：问「待办」时拿「项目现状」那条来答，读起来像答非所问。
  const wants = [];
  if (STATUS_TODO_RE.test(q)) wants.push(/待办/);
  if (STATUS_NOW_RE.test(q)) wants.push(/项目现状/);
  if (wants.length === 0) return null;
  const picked = [];
  for (let di = 0; di < docs.length; di++) {
    const d = docs[di];
    if (String(d?.level ?? "") !== "project") continue;
    const kw = Array.isArray(d.keywords) ? d.keywords.join(" ") : "";
    const hay = kw + " " + String(d.content ?? "").slice(0, 40);
    if (!wants.some((re) => re.test(hay))) continue;
    const t = Number(d.updated_at ?? d.created_at ?? 0) || 0;
    picked.push({ di, t });
  }
  if (picked.length === 0) return null;
  // 同一个仓往往有多条（「当前待办」按日期整理过几版），只抬一条会让读者看到旧的；
  // 按 updated_at 降序取前 STATUS_DIGEST_MAX 条一起上浮，都是这一仓的东西，不越权。
  picked.sort((a, b) => b.t - a.t);
  return picked.slice(0, STATUS_DIGEST_MAX).map((x) => x.di);
}
var TIP_RE = /该写|该填|写什么值|要改几个|改几个|要改几条|改几条|几轮|要跑几|几条要改|哪个值/;
var ASSERT_RE = /必须是|一律|只认|只有|至少|一定|不许|绝不|禁止|都要|全都|统一|固定为|只能是|必须|务必/g;
function tipAssertOn(text) {
  return TIP_RE.test(String(text ?? ""));
}
function assertRatioOf(text) {
  // [0.2.174] 只看开头：断言是「结论」的形状，结论在首句；背景叙述的断言词散在后半段，
  // 拿全文计数会把「有两套时间戳、别只改一处」这种铺垫也算成答案。
  const head = String(text ?? "").slice(0, 60);
  const n = (head.match(ASSERT_RE) || []).length;
  return Math.min(1, n / 2);
}
var LEVEL_INTENT_RULES = /要不要|该不该|能不能|可不可以|需不需要|是否要|允不允许|准不准|该由|应该由|由什么触发|规定/;
var LEVEL_INTENT_FACT = /改了什么|改了哪些|做了什么|做了哪些|加了什么|加了哪些|交付态|什么版本|哪个版本|几条|多少条|几点/;
var LEVEL_INTENT_TOPIC = /来龙去脉|为什么|缘由|经过|怎么来的/;
var LEVEL_INTENT_LESSON = /怎么跑|怎么写|怎么做|怎么办|怎么能|如何|技巧|办法|踩过|经验/;
// [macro-fusion 0.2.179] 「还在不在用」不是「该不该」：问句带存在性/残存性状语时，答案是现状仓
// （project）里的那条记录，不是规矩仓里那条「禁止无预算花 key」——问「评测台还能跑吗」，
// 正解是「2026-11-21 已封存，烧了 ¥100」，压住它的却是同库那条 imp=4 的规矩（词面全是 key/评测台/预算）。
// 判据只放「存在性」措辞（还能用/还能跑/还用不用/封存/下线/停用/退役/现状/到哪一版），
// 不放「要不要/该不该」——那类问的是决策，答案本来就该在规矩里。
var LEVEL_INTENT_SITUATION = /还能用|还能跑|还能不能|还用不用|还在不在|有没有在用|还在用|已停|封存|下线|停用|退役|现状|到哪一版|推进到|进展到/;
function intentLevelsOf(text) {
  const q = String(text ?? "");
  const out = new Set();
  // [macro-fusion 0.2.180] 「为什么封存」问的是当初，不是当下：带缘由词的一律归缘由问句。
  // [macro-fusion 0.2.180] 缘由词优先：「评测台为什么封存」里的「封存」是状态词，但问的是当初。
  const situation = LEVEL_INTENT_SITUATION.test(q) && LEVEL_INTENT_TOPIC.test(q) === false;
  if (LEVEL_INTENT_RULES.test(q) && situation === false) out.add("rules");
  if (LEVEL_INTENT_FACT.test(q)) out.add("fact");
  if (LEVEL_INTENT_TOPIC.test(q)) out.add("topic");
  if (LEVEL_INTENT_LESSON.test(q)) out.add("lesson");
  if (situation) out.add("project");
  return out.size === 0 ? null : out;
}
// [macro-fusion 0.2.171] 历史补录上限：点了名的标识符只活在过期条目里时，最多翻几条出来。
var HIST_LIFT_MAX = 3;
var IDENT_BASE_CREDIT = 0.7;
var IDENT_STEM_CREDIT = 0.5;
// [macro-fusion 0.2.150] 证据先分档，档内才谈权重。
// IMP_BAND —— 相邻两条记忆的词分差不到 17%（raw ≥ 0.85 × 上一档锚点）才算「同一档」，
//   权重（importance / 新鲜度 / 状态）只能在这一档里改判顺序，不能把一个证据差两倍的条目
//   抬成榜首（实测「0.2.147 改了什么」：总览 bm25 3.833 靠 impW 1.75 压过 bm25 7.02 的正解）。
// RECENCY_FLOOR —— 时间折扣有下限：旧记忆最多折到 0.6，不该因为旧就从榜上消失
//   （实测「评测台为什么封存」：正解 w=0.08，词分 6.869 却掉到第 5）。
// 这两个数跟 recency 豁免用的是同一个 85% 带——口径本来就该是一件事。
var IMP_BAND = 0.85;
var RECENCY_FLOOR = 0.6;
// [macro-fusion 0.2.165] 回执按置信档裁剪：bandize 早就把候选按「和榜首是一个量级吗」分好了档，
// 可回执一条不看它，照样按死 k 往回捞——真库 150 问上返回均值 9.80 条，而**正解 100% 落在
// band <= 0**（照抄池 95.5%、换说法 84.6%、锚点 90%），band0 平均只有 1.08 条。
// 也就是说默认回 10 条时，八条是同一批「沾边但不该看」的尾货，却要照价付 token。
// 这里只做一件事：回执 = 与榜首同档的那几条，但最少 RESULT_MIN_KEEP 条（免得一句话都没有）。
// 不改分数、不改排序、不改分档门槛；`opts.bandKeep:false` 或 `opts.minKeep:0` 一键回旧口径。
// 实测 minKeep=5：五池 hit@1 与 top5 与 k=10 **完全一致**（42/44、10/13、8/10、148/150、5/11），
// 回执均值 9.80 → 4.97（真库）、6.13 → 4.40（照抄）——省一半，一条不丢。
// minKeep=3 会更省（2.99）但真库换说池掉 2 条（11 → 9），所以 5 是「零损失」的那一格。
var RESULT_MIN_KEEP = 5;

// [macro-fusion 0.2.159] 时间锚：问句自己指了一个具体时刻（版本号 / 日期），它问的就是
// 「那一刻发生了什么」。这类问句上，新鲜度折扣与 stale 惩罚是在帮倒忙——被取代的是「现在的
// 准则」，不是「那一次交付的记录」。实测「0.2.146 加了什么」：正解是那条已 stale 的交付记录
// （bm25 4.864 对 4.849，本来就同档），stale 折扣 0.6 把它从榜首摁到第二。
// 只管这一件事：锚点上不折时间、不折状态。分档门槛、词分、覆盖度一个都不动（都量过，见 INTERNAL 9.166）。
var TIME_ANCHOR_RE = /\d+\.\d+\.\d+|20\d\d[-/.年]\d{1,2}([-/.月]\d{1,2})?/;
function anchorListOf(q) {
  const out = [];
  for (const m of String(q ?? "").matchAll(new RegExp(TIME_ANCHOR_RE.source, "g"))) out.push(m[0]);
  return out;
}
function timeAnchorOf(q, opts) {
  if (opts && opts.timeAnchor === false) return false;
  return TIME_ANCHOR_RE.test(String(q ?? ""));
}

// [macro-fusion 0.2.160] 弱命中：榜首「只是沾到」的时候要说得出来。
// 覆盖度不足 = 这条问句的词只命中一小块；几乎并列 = 两个候选说得一样像。
// 两个判据都只决定「回执里多不多一句话」，不参与打分、不改排序、不动 min_rel：
// 真库 59 问上量过——触发 25 条里 18 条确实没中（覆盖 75%），误报 7 条。
var WEAK_COVER = 0.2;
var WEAK_GAP = 0.95;
// [macro-fusion 0.2.163] 覆盖度是「问句里那些词，这条到底占了几成」，属于内容证据；
// 而它此前只在协调因子里按 0.35 轻轻乘一下（缺一半词只掉 17%），挡不住「长文档靠词频
// 堆积压过精准短文档」。这里把它抬起来，缺口越大掉得越狠；分档门槛、词分一个字不动。
// [macro-fusion 0.2.164] 口径纠正：0.2.163 那组真库读数是错的——读数脚本把 db 行原样喂进
// search，而行里的 keywords 是 JSON 文本，引擎三处都按 Array.isArray 判空（kwToks / kwSets /
// 索引签名），于是关键词通道整条没生效：真库 150 问自找回被读成 0.867，实际是 0.987。
// 语料改回 db.listSearchable（keywords 是数组）之后，幂次带来的收益全部消失：
// 0.5/1.2 在 14 条换说法问句上只进 top5 9 条，比旧的 0.35/1（10 条）还退一条。
// 干净读数上的平台是 0.45 且线性：top5 10 → 12（远端仓库、反省 各进前五），一条 3→4 仍在
// 前五；照抄 42/44、换说法 10/13、锚点 8/10 一位不动。幂次留着当旋钮，默认给 1。
var COORD_W_DEF = 0.45;
// 幂次默认 1（线性）。0.2.163 曾按「缺口越大越该疼」给它 1.2，但那是踩在坏读数上做的决定：
// 干净语料上 1.2 会让真库换说法池少进一条 top5。除非将来有干净读数支撑，别再往上抬。
var COORD_POW_DEF = 1;
// [macro-fusion 0.2.179] 覆盖满的条目不该被长度稀释。BM25 的长度归一化假设是「长文里出现一个词
// 不稀奇」，可当一条记忆把问句的每个实词都盖住了（cover = 1.0），它不是在泛泛地谈这个话题，
// 它就是这个问题的那条记录；此时还能赢的短条目，赢在「短」，不在「答得全」。实测「评测台为什么封存」：
// 正解 611 字、cover 1.00、bm25 10.757；压制它的规则 102 字、cover 0.638、bm25 18.451——
// 词项覆盖满的那条反而被长度罚掉 71%。这里按 cover 线性打折长度惩罚（b 有效值 = b×(1-relief×cover)），
// cover 满 → 惩罚减半，cover 低 → 几乎不动。不改 k1、不改 idf、不改 n 与 df。
var COVER_LEN_RELIEF = 0.5;
// [macro-fusion 0.2.179] 缘由问句的回答仓是叙述层，不是规矩层。
// 问「评测台为什么封存」，答案是「2026-11-21 已封存、一晚烧了 ¥100」这条 project 记录；
// 压住它的是一条 imp=4 的 rules（「评测台禁止无预算花 key」）——它讲的是「该怎么做」，
// 一个字都没答「为什么」。词面高度重合是因为同一个实体，不是同一个问题。
// 两件事一起做：①缘由问句下规矩层折价 CAUSE_RULE_FOLD；②缘由问句不折新鲜度（问的是当初
// 为什么那样，旧是自然的，与 0.2.159 时间锚同源）。`causeAware:false` 一键回旧口径。
var CAUSE_RULE_FOLD = 0.6;
// [macro-fusion 0.2.180] 「这台机器还能不能用」问的是存在性，规矩条答的是「该怎么做」，折得比缘由问句更狠。
var SITUATION_RULE_FOLD = 0.3;
// [macro-fusion 0.2.161] 关键词字段被低估：真库 569 条 title 全空，keywords 是唯一的结构化桥，
// 而它只按 0.25 倍词频、+0.35 加成参与打分。抬到 0.35 / 0.6——读数与 tf 0.5/0.6 完全相同，
// 但 0.5 会把「只在 keywords 里提到的条目」压过「正文命中的条目」，破坏 0.2.152 立下的「标签不是正文」。
// 同读数选不破老规矩的那一个；tf 再往下（0.3/0.6）换说法池就掉回 0.429。
// [macro-fusion 0.2.162] 同义词桥：中文二元组这一层没有词形变化，「反省」与「反思」、「推送」与
// 「远端」在词面上就是零交集——换说法池 hit@1 卡在 0.500 的根本原因，不是排序不聪明，是**根本没有
// 可比的词**。这里补一条问句侧的单向扩词通道：
//   ① 表是手工的，只收「问句里常说、正文里常换个说法」的二字词；每条必须与 tokenize() 的二元组对齐，
//      三字以上的词要被切成二元组，所以表里不出现它们。
//   ② 只扩问句，不动文档；扩出来的词单独计分、权重 SYN_W < 1——换个说法能帮忙，但不能顶替原话。
//   ③ 覆盖度分母一个字节不动：扩词只加分，不进 qIdfSum，否则「问句更难满足」，会把真相关的条目一起裁掉。
//   ④ 倒排候选集必须把同义词的 postings 并进来，否则被剪掉的条目连分数都算不到。
//   ⑤ `synBridge:false` 一键回到旧口径。
// [macro-fusion 0.2.180] 「开个小门」是讲例外，不是讲筛掉。同一个词放进两组会把两道题一起搅坏：
// 它原来在噪声组里，问「要不要给接班的那条开个小门」被拽向「筛掉/噪声」那些条目；
// 挪进例外组（例外/豁免/放行/破例）之后，这一题直接翻成第一。两组不许有交集。
var SYN_GROUPS = [
  ["反省", "反思", "回味"],
  ["自测", "测试", "校验", "断言", "自检", "体检", "验证", "测到"],
  ["推送", "远端", "仓库", "上传", "发布", "提交"],
  ["拆开", "拆分", "重构", "改造"],
  ["接班", "取代", "接任", "移交"],
  ["筛掉", "过滤", "剔除", "噪声", "噪音", "口子", "让步"],
  ["评测", "榜单", "基准", "跑分"],
  ["例外", "豁免", "特例", "放行", "破例", "小门"],
  ["验收", "确认", "核对"],
  ["毛病", "缺陷", "问题", "踩坑"],
  ["省钱", "成本", "预算", "花钱"],
  ["线索", "来源", "出处"],
  ["吵架", "冲突", "矛盾"],
  ["耗时", "卡顿", "拖慢", "变慢"],
  ["学会", "记住", "记下"],
  ["封存", "冻结", "归档", "下线", "停用"],
  ["底线", "下限", "地板", "门槛"],
  ["口径", "说法", "叫法", "定义"],
  // [macro-fusion 0.4.0 · P5] 查询扩展第二段：口语 → 术语、中文 → 英文技术名词、常见错写。
  // 三条纪律不变：只扩问句不扩库、扩出来的词必须 df>0（没人命中就白算）、权重仍走 SYN_W < 1。
  // 与上面 18 组一样，组内互扩、组间不许有重复词（G21 的表形态判据会当场打红）。
  // 英文词按整词 tokenize（不受中文二元组限制），所以这里允许 2 字符以上的小写英文。
  ["卡住", "阻塞", "挂起", "卡死"],
  ["崩了", "崩溃", "报错", "出错", "失败"],
  ["令牌", "token"],
  ["缓存", "cache"],
  ["配置", "config"],
  ["索引", "index"],
  ["接口", "api", "端点"],
  ["字段", "field"],
  ["备份", "快照", "存档"],
  ["回滚", "还原", "恢复"],
  ["接线", "挂载", "接入", "拼装"],
  ["提速", "变快", "加速"],
  ["省下", "节省", "少花"],
  ["修好", "修复", "修掉", "补回"],
  ["日志", "log"],
  ["文档", "readme", "手册"],
  ["词表", "同义", "近义"],
  ["切片", "分片", "chunk"],
  ["向量", "vector"],
  ["超时", "timeout", "逾时"],
];
var SYN_W = 0.6;
// [macro-fusion 0.4.0 · P5] 扩词还有一道高频门：df 占全库三成以上的词，扩了只是把噪声撒到每一条上
// （idf 本来就低，收益≈0，却能把不相关条目抬进榜）。0.35 是「够常见但不至于到处都有」的分界，
// 判据量两件事：①df 超过 35% 的词一个都不许扩；②照抄池/锚点池逐条零漂移（扩表不能改老读数）。
// 第三参 n 缺省时这道门关着——老调用方（探针/外部脚本）行为一字不变。
var SYN_MAX_DF_RATIO = 0.35;
// 每个问句词最多扩几个：手工表一组平均 3~4 个，自学习最多 6 个，合流后按 6 截断。
// 截断是为了防「一个高频问句词被扩成一串，把整条 query 稀释掉」——扩词是桥，不是主力。
var SYN_MAX_PER_TERM = 6;
var SYN_MAP = null;
function synMapOf() {
  if (SYN_MAP !== null) return SYN_MAP;
  SYN_MAP = new Map();
  for (const group of SYN_GROUPS) {
    for (const t of group) {
      const cur = SYN_MAP.get(t);
      const add = group.filter((x) => x !== t);
      SYN_MAP.set(t, cur === void 0 ? add.slice() : [.../* @__PURE__ */ new Set([...cur, ...add])]);
    }
  }
  return SYN_MAP;
}
// [macro-fusion 0.4.0 · P5] 两个来源合流：手工表是种子（管「人已经确定的等价说法」），
// 共现表是自学习（管「新领域、新术语、新缩写——从来没人告诉过我它们是一回事」）。
// 第四参 cooc 缺省 null 时，行为与 0.3.0 一字不差：老探针和外部脚本调三个参数照样跑。
function synExpandOf(qTerms, df, n, cooc, forms) {
  const map = synMapOf();
  const cap = Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n * SYN_MAX_DF_RATIO)) : Infinity;
  const out = /* @__PURE__ */ new Map();
  const usable = (a, list) => !qTerms.includes(a) && !list.includes(a) && (df.get(a) ?? 0) > 0 && (df.get(a) ?? 0) <= cap;
  // 名额按**碎片**算（就是打分用的那个坐标系）。试过放宽到两倍、试过按整词算名额，两版在冷域
  // 十题上都更差（hit@3 0.90 → 0.60）：多出来的名额被同项目层的邻居占走（番茄/整枝/蚜虫），
  // 它们能命中别的条目，把答文档从第三挤到第四。扩词是桥，桥要窄。
  // [macro-fusion 0.5.0 · P1] 碎片只在**第二遍（桥那一遍）**投：第一遍必须与 0.4.1 逐位一致，
  // 连分数都不许漂（probe-cost 的 C5 快照守的就是这条），而把整词切碎会多命中一批碎片、
  // 把分数抬高（实测 40.096866 → 42.811168，名次不变但数字变了）。碎片是桥自己的词形，
  // 就该留在桥那一遍；第一遍只按 0.4.1 的老坐标系说话。
  const fragOk = forms instanceof Map;
  const push = (use, a) => {
    if (typeof a !== "string" || a.length === 0) return;
    if (usable(a, use)) use.push(a);
    if (!fragOk) return;
    // 邻居是整词，正文里是碎片：把整词切开的碎片算候选，否则「二甲双胍」永远匹配不上「二甲/甲双/双胍」。
    for (const f of tokenize(a)) {
      if (f.length < 2 || f === a || !usable(f, use)) continue;
      use.push(f);
    }
  };
  for (const t of qTerms) {
    const use = [];
    for (const a of map.get(t) ?? []) push(use, a);
    if (cooc instanceof Map) {
      for (const a of cooc.get(t) ?? []) push(use, a);
      // 问句里的碎片先落回整词，再查那个整词的邻居：降糖 → 降糖药 → 二甲双胍。
      if (forms instanceof Map) {
        for (const w of forms.get(t) ?? []) {
          if (w === t) continue;
          for (const a of cooc.get(w) ?? []) push(use, a);
        }
      }
    }
    if (use.length > 0) out.set(t, use.slice(0, SYN_MAX_PER_TERM));
  }
  return out.size > 0 ? out : null;
}
// [macro-fusion 0.5.0 · P1] 词形桥的第二遍怎么并回第一遍：
// FORM_MERGE_W 是第二遍的权重（第一遍恒为 1），FORM_RRF_K 是 RRF 的平滑常数（取 60 是 RRF 惯例）。
// 实测：整份替换会把第一遍排第一的挤下去（财务「发票丢了还能报销吗」0 → 1）；权重 0.5 的 RRF
// 只补位不翻盘——第一遍第 1 名仍是第 1 名，第二遍捞回来的条目填进第 2、第 3 位
// （冷域十题 hit@3 0.40 → 0.80；宽池换说法两档 1.000 / 0.956 与第一遍逐位相同）。
var FORM_MERGE_W = 0.5;
var FORM_RRF_K = 60;
var KW_TF_W = 0.35;
var FIELD_KW_W_DEF = 0.6;
function hintWordsOf(hit, query) {
  const raw = hit && hit.keywords;
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === "string" && raw.trim().length > 0) {
    const t = raw.trim();
    if (t.startsWith("[")) {
      try {
        const j = JSON.parse(t);
        list = Array.isArray(j) ? j : t.split(/[,，、]/);
      } catch {
        list = t.split(/[,，、]/);
      }
    } else list = t.split(/[,，、]/);
  }
  const q = String(query ?? "");
  const out = [];
  for (const w of list) {
    const one = String(w ?? "").trim();
    if (one.length < 2 || one.length > 12) continue;
    if (/^[0-9.\-/\s]+$/.test(one)) continue;
    if (q.includes(one)) continue;
    if (out.includes(one)) continue;
    out.push(one);
    if (out.length >= 3) break;
  }
  return out;
}
function weakHitOf(hits, opts) {
  const list = Array.isArray(hits) ? hits.filter((h) => h && typeof h === "object") : [];
  const o = opts ?? {};
  const coverMax = Number.isFinite(o.cover) ? o.cover : WEAK_COVER;
  const gapMax = Number.isFinite(o.gap) ? o.gap : WEAK_GAP;
  if (list.length === 0) return { weak: false, why: "", cover: 0, gap: 0, words: [] };
  const top = list[0];
  const second = list[1] ?? null;
  if (top.anchored === true) return { weak: false, why: "anchor", cover: typeof top.cover === "number" ? top.cover : 0, gap: 0, words: [] };
  const cover = typeof top.cover === "number" && Number.isFinite(top.cover) ? top.cover : null;
  const topScore = Number(top.score) || 0;
  const gapRaw = second !== null && topScore > 0 ? (Number(second.score) || 0) / topScore : 0;
  const gap = gapRaw > 1 ? 1 : gapRaw;
  const lowCover = cover !== null && cover < coverMax;
  const nearTie = second !== null && gap >= gapMax;
  const why = lowCover && nearTie ? "cover+near" : lowCover ? "cover" : nearTie ? "near" : "";
  return {
    weak: lowCover || nearTie,
    why,
    cover: cover === null ? 0 : Math.round(cover * 1e3) / 1e3,
    gap: Math.round(gap * 1e3) / 1e3,
    words: lowCover || nearTie ? hintWordsOf(top, o.query) : []
  };
}
function weakNoteOf(hits, opts) {
  const w = weakHitOf(hits, opts);
  if (!w.weak) return "";
  const pct = Math.round(w.cover * 100);
  const gapPct = Math.round((1 - w.gap) * 100);
  const whyText = w.why === "cover+near"
    ? safeKeyed("search.weakBoth", "榜首只覆盖了这条问句的 {pct}%，与第二名只差 {gap}%", { pct: String(pct), gap: String(gapPct) })
    : w.why === "near"
      ? (gapPct <= 1
        ? safeKeyed("search.weakTie", "榜首与第二名几乎同分")
        : safeKeyed("search.weakNear", "榜首与第二名只差 {gap}%", { gap: String(gapPct) }))
      : safeKeyed("search.weakCover", "榜首只覆盖了这条问句的 {pct}%", { pct: String(pct) });
  const words = w.words.length === 0 ? "" : safeKeyed("search.weakWords", "库里是这么说的：{words}。", { words: w.words.join("、") });
  return safeKeyed("search.weak", "这次弱命中：{why}。它可能只沾了一两个词，先看正文确认，别直接当结论。{words}要更准就换个词，或者收窄 level / project / days。", { why: whyText, words });
}

// 按证据分档：先按词分排，再从头扫，凡是掉到本档锚点 85% 以下就开新档。
// 档号升序即证据强度降序；权重只在同档内比较，跨档永远不许越级。
// [macro-fusion 0.2.165] 回执裁剪的唯一落点：按 band 收口，最少 RESULT_MIN_KEEP 条。
// 单独成函数是为了「词法一路」和「稠密融合一路」用同一个口径——两条路各裁一次会变成两套规矩。
// hits 必须已 bandize（每条带 _band）；返回前把 _raw / _ident / _band 一并摘掉，别漏进回执。
function trimByBand(hits, k, opts = {}) {
  const minKeep = Number.isFinite(opts.minKeep) && opts.minKeep >= 0 ? Math.round(opts.minKeep) : RESULT_MIN_KEEP;
  const want = Number.isFinite(k) && k > 0 ? Math.round(k) : hits.length;
  const sliced = hits.slice(0, want);
  const keepAll = opts.bandKeep === false || minKeep === 0;
  let sameBand = 0;
  for (const h of sliced) if (!(h._band > 0)) sameBand++;
  const keep = keepAll ? sliced.length : Math.min(sliced.length, Math.max(minKeep, sameBand));
  const out = sliced.slice(0, keep);
  for (const h of out) {
    delete h._raw;
    delete h._ident;
    delete h._band;
    delete h._dense;
  }
  // [macro-fusion 0.2.167] 折掉的条数要跟着回执走：0.2.165 那道收口一直在切，
  // 但切完什么都不说——读者只看到「只给了 5 条」，不知道自己还少看了几条，
  // 也判断不出该不该要全量。挂在数组上的非枚举属性：JSON.stringify 看不见它，
  // Object.keys / for...of 也不受影响，旧调用方一个字节都不用改。
  // [macro-fusion 0.2.169] 上游已经折过一批时（语义补位那条路会折掉词法尾部），这里要**累加**：
  // 0.2.167 只报「这一刀折了几条」，上游折的全被这一层的 slice 悄悄抹平——于是救援路径
  // 明明折了 1 条，回执里一个字都不提。
  const upstreamTrim = Number(hits.trimmed) || 0;
  const dropped = sliced.length - out.length + upstreamTrim;
  if (dropped > 0) {
    try {
      Object.defineProperty(out, "trimmed", { value: dropped, enumerable: false, configurable: true });
    } catch {
    }
  }
  const upstreamRescue = Number(hits.rescueAdded) || 0;
  if (upstreamRescue > 0) {
    try {
      Object.defineProperty(out, "rescueAdded", { value: upstreamRescue, enumerable: false, configurable: true });
    } catch {
    }
  }
  const upstreamRescueTrim = Number(hits.rescueTrimmed) || 0;
  if (upstreamRescueTrim > 0) {
    try {
      Object.defineProperty(out, "rescueTrimmed", { value: upstreamRescueTrim, enumerable: false, configurable: true });
    } catch {
    }
  }
  return out;
}

// [macro-fusion 0.6.12] 定序只排前 k。
//
// 症状（`E:\Temp\cmp\prof012b.mjs` + `--cpu-prof`，10,000 条 / 300 问，单次 `search` 27.4ms）：
// 三个调用点（`search`、`literalFallback`、`keywordHitScore`）都是「bandize 全量 → 取前 k」，
// 而 bandize 内部把**全量**排了两遍：先按 `_raw` 排一遍定档（16.5% + 7.7% 采样），
// 再按 (档, 分数, 时间, id) 排一遍定序（16.1%）——加起来占一次热检索的四成，
// 全部花在「注定被 trimByBand 的 slice(0, k) 丢掉的那些条目」上。
//
// 处方两条，都不改口径：
//  ① 档位不再挂 Map<对象, 档>：算出来直接写在条目自己身上（`_bandTmp`），定序比较读属性而不是查表。
//     同一个 Map 在瓶颈里既是 set 热点（bandize 自证 4.9ms）又是 comparator 里的 get 热点。
//  ② 定序改成**有界堆选前 k**：档位仍按全量算（档是「相对榜首 85%」定义的，跳不掉），
//     但排序只对入选的 k 条做一次。传入 `limit`（= 调用点接下来要取的 k）时 hits 会被截到 k 条，
//     与 `trimByBand` 的 `slice(0, want)` / `keepBand` 的 `slice(0, k)` 逐位一致。
//
// 为什么截断是安全的：三个调用点在 bandize 之后**只**碰前 k 条（`trimByBand` 里
// `sliced.length - out.length` 用的也是 min(k, hits.length)），没有任何一处回头读第 k 条以后的东西。
// 判据 `tools/probe-order.mjs` O1–O8：与「全量排序再取前 k」的参考实现在 500 组随机语料上逐位对拍。
// [macro-fusion 0.6.13] 定档不再靠「全量对象排序」。
//
// 症状（0.6.12 之后复测 `E:\Temp\cmp\prof012b.mjs` + `--cpu-prof`，10,000 条 / 300 问）：
// bandize 仍占一次热检索的 21.5%，而其中大头是 `hits.slice().sort((a, b) => b[rawKey] - a[rawKey])`
// 那把**只为定档**的全量排序——为一堆注定进不了前 k 的条目，逐对调比较器、逐对读对象字段。
//
// 处方：档号其实只由「排序后的不同 raw 值」决定，于是
//  ① 把 raw 抄进 `Float64Array`，用 TypedArray 原生 `.sort()`（无比较器、纯数值排序）；
//  ② 按降序走一遍阈值链（`a_0 = max`、`a_{i+1} = 最大的 < 0.85·a_i`），得到锚点表；
//  ③ 每条用自己的 v 在锚点表上二分，档号 = 该锚点之后的锚点数（`m - 1 - lo`）——一次 log m 比较，不再排序。
//
// 退回路：raw 不是有限非负数（NaN / undefined / 负数）时阈值链「锚点严格下降」的前提不成立
// （负数时 `0.85·a_i > a_i`），此时退回 `setBandsBySort` 的老全量排序，口径一字不改。
// 指认（`_ident` / `_subj === 1`）照旧恒 -1 档，且不进阈值链（与老代码 `continue` 同义）。
function setBandsByThreshold(hits, rawKey) {
  const total = hits.length;
  let plain = 0;
  for (let i = 0; i < total; i++) {
    const h = hits[i];
    if (h._ident === true || h._subj === 1) {
      h._bandTmp = -1;
      continue;
    }
    const r = h[rawKey];
    if (typeof r !== "number" || !Number.isFinite(r) || r < 0) return false;
    plain += 1;
  }
  if (plain === 0) return true;
  const vals = new Float64Array(plain);
  for (let i = 0, j = 0; i < total; i++) {
    const h = hits[i];
    if (h._ident === true || h._subj === 1) continue;
    vals[j++] = h[rawKey];
  }
  vals.sort();
  const anchors = []; // 先降序压进来，再翻成升序给二分用
  let anchor = -1;
  for (let i = plain - 1; i >= 0; i--) {
    const v = vals[i];
    if (anchors.length === 0 || v < IMP_BAND * anchor) {
      anchors.push(v);
      anchor = v;
    }
  }
  anchors.reverse();
  const m = anchors.length;
  for (let i = 0; i < total; i++) {
    const h = hits[i];
    if (h._ident === true || h._subj === 1) continue;
    const v = h[rawKey];
    let lo = 0;
    let hi = m;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid] >= v) hi = mid;
      else lo = mid + 1;
    }
    h._bandTmp = m - 1 - lo;
  }
  return true;
}

/** 退回路：老的全量对象排序定档（0.6.12 及以前的做法，逐位保留）。 */
function setBandsBySort(hits, rawKey) {
  const byRaw = hits.slice().sort((a, b) => b[rawKey] - a[rawKey]);
  let band = -1;
  let anchorRaw = 0;
  for (const h of byRaw) {
    // [macro-fusion 0.2.150] 指认（问的正是这条 id）是最强证据形态，词分为 0 也不许被扫到最后一档。
    if (h._ident === true || h._subj === 1) {
      h._bandTmp = -1;
      continue;
    }
    const r = h[rawKey];
    if (band < 0 || r < IMP_BAND * anchorRaw) {
      band += 1;
      anchorRaw = r;
    }
    h._bandTmp = band;
  }
}

function bandize(hits, rawKey, limit = Infinity) {
  const total = hits.length;
  if (total < 2) return hits;
  if (!setBandsByThreshold(hits, rawKey)) setBandsBySort(hits, rawKey);
  // [macro-fusion 0.6.3] 并列时不许「谁先进语料谁在前」：同一问句在两种插入顺序下会给出两套前十，
  // 而 docs 的顺序在生产里是存储层给的（更新会改 rowid、VACUUM/分页会改顺序），于是「同一问句同一答案」
  // 这条产品承诺就不成立，所有对外读数也变成「抽到的那一次」。定序改成 分档 → 分数 → 记忆更新得更晚的
  // 在前 → id 字典序，四个键全是数据本身的属性，与语料顺序无关（`probe-determinism` 钉住）。
  const orderOf = (a, b) => (a._bandTmp - b._bandTmp) || (b.score - a.score) ||
    (stampOf(a) < stampOf(b) ? 1 : stampOf(a) > stampOf(b) ? -1 : 0) || cmpText(a.id, b.id);
  // limit<=0 不许走有界路：`trimByBand` 在 k<=0 时 want=hits.length，等于要全序。
  const want = Number.isFinite(limit) && limit > 0 ? Math.round(limit) : total;
  if (want >= total) {
    hits.sort(orderOf);
  } else {
    // 有界堆：根是「当前入选里最差」的那条（orderOf 更大 = 更靠后）。
    const heap = [];
    const swap = (i, j) => { const t = heap[i]; heap[i] = heap[j]; heap[j] = t; };
    const siftUp = (i) => {
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (orderOf(heap[i], heap[p]) <= 0) break;
        swap(i, p);
        i = p;
      }
    };
    const siftDown = (i) => {
      for (;;) {
        const l = i * 2 + 1;
        if (l >= heap.length) break;
        const r = l + 1;
        let m = i;
        if (orderOf(heap[l], heap[m]) > 0) m = l;
        if (r < heap.length && orderOf(heap[r], heap[m]) > 0) m = r;
        if (m === i) break;
        swap(i, m);
        i = m;
      }
    };
    for (const h of hits) {
      if (heap.length < want) {
        heap.push(h);
        siftUp(heap.length - 1);
      } else if (orderOf(h, heap[0]) < 0) {
        heap[0] = h;
        siftDown(0);
      }
    }
    heap.sort(orderOf);
    hits.length = heap.length;
    for (let i = 0; i < heap.length; i++) hits[i] = heap[i];
  }
  const kept = hits.length;
  for (let i = 0; i < kept; i++) {
    const h = hits[i];
    h._band = h._bandTmp;
    if (h.explain !== void 0) h.explain.band = h._band;
    delete h._bandTmp;
  }
  return hits;
}

/** 两条记忆谁排前面：更新得更晚的在前，同刻按 id 自然序（下标版，给只拿得到 docs 下标的排序用）。 */
function laterFirst(docs, x, y) {
  const sx = stampOf(docs[x]);
  const sy = stampOf(docs[y]);
  if (sx !== sy) return sx > sy ? -1 : 1;
  return cmpText(docs[x].id, docs[y].id);
}

/** 记忆的「更新时刻」按毫秒数比：数字原样、ISO 字符串解析、其余算 0（缺字段的共同起跑线）。 */
function stampOf(h) {
  const v = h === null || h === void 0 ? void 0 : h.updated_at;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string" && v !== "") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

/** 字典序比较：按码元，不按 locale（locale 会随机器变，定序也就跟着变）；数字段按数值比，
 *  这样 `D1:2` 排在 `D1:10` 前面——纯码元序会把 10 排到 2 前面，与「时间先后」正好相反。 */
function cmpText(a, b) {
  const x = a === null || a === void 0 ? "" : String(a);
  const y = b === null || b === void 0 ? "" : String(b);
  if (x === y) return 0;
  const xa = x.match(/\d+|\D+/g) ?? [];
  const ya = y.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(xa.length, ya.length); i++) {
    const p = xa[i];
    const q = ya[i];
    if (p === q) continue;
    const pd = p.charCodeAt(0) >= 48 && p.charCodeAt(0) <= 57;
    const qd = q.charCodeAt(0) >= 48 && q.charCodeAt(0) <= 57;
    if (pd && qd) {
      const pn = Number(p);
      const qn = Number(q);
      if (pn !== qn) return pn < qn ? -1 : 1;
      if (p.length !== q.length) return p.length < q.length ? -1 : 1;
      continue;
    }
    return p < q ? -1 : 1;
  }
  return xa.length === ya.length ? 0 : xa.length < ya.length ? -1 : 1;
}
var IDENT_RES = [
  /[A-Za-z]:\\[^\s，。；、）)\]】]+/g,
  /(?:[\w.@-]+\/){2,}[\w.@-]+/g,
  /[\w.-]+\.(?:js|mjs|cjs|ts|tsx|json|md|db|py|ps1|yml|yaml|toml|txt|zip|exe|dll|log)\b/gi,
  /\b\d+\.\d+\.\d+\b/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b0m[a-z0-9]{5,}\b/gi,
  /\b[0-9a-f]{7,40}\b/gi,
  /\b[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+\b/gi,
  /\b[a-z][a-z0-9-]*\/[a-z][a-z0-9.-]+\b/gi
];
function identsOf(query) {
  const src = String(query ?? "");
  const out = [];
  if (src.length === 0) return out;
  for (const re of IDENT_RES) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      const t = String(m[0]).toLowerCase();
      if (t.length < IDENT_MIN) continue;
      if (!out.includes(t)) out.push(t);
    }
  }
  const kept = out.filter((t) => !out.some((u) => u !== t && u.length > t.length && u.includes(t)));
  return kept.slice(0, IDENT_MAX);
}
function identCreditOf(ident, hay) {
  if (hay.includes(ident)) return 1;
  const parts = ident.split(/[\\/]+/);
  const base = parts[parts.length - 1] ?? "";
  if (base !== ident && base.length >= IDENT_MIN && hay.includes(base)) return IDENT_BASE_CREDIT;
  const stem = base.replace(/\.[a-z0-9]+$/, "");
  if (stem !== base && stem.length >= IDENT_MIN && hay.includes(stem)) return IDENT_STEM_CREDIT;
  return 0;
}
function verbatimOf(idents, hay) {
  let sum = 0;
  const matched = [];
  for (const t of idents) {
    const c = identCreditOf(t, hay);
    if (c > 0) {
      sum += c;
      matched.push(c >= 1 ? t : t + "(局部)");
    }
  }
  return { ratio: idents.length === 0 ? 0 : Math.min(1, sum / idents.length), matched };
}
// [macro-fusion 0.6.11] 「库里有什么」的那一半，不该每问一次重拼一遍。
// 读数（`E:\Temp\cmp\scale011.mjs` / `scale011b.mjs`，660 / 2,000 / 5,000 / 10,000 条同构语料）：
// 问句里带标识符时（英文问句基本都带），原样匹配通道占一次热检索的 **35.7% / 50.6% / 42.7% / 42.9%**；
// 这一块里「逐条拼 haystack + toLowerCase」占 **5.78ms / 10.49ms ≈ 55%**，真正的逐条比标识符只要 0.51ms。
// 也就是钱全花在「把每条记忆重新拼成一个字符串」——而这件事跟问什么毫无关系，只跟库有什么有关，
// 它本来就该跟切词表、倒排表一起待在索引里。
// 三条命门（和 0.6.10 同一个道理，但落点不同）：
//   ① haystack 只由「这条记忆的字段」决定：id + project + docText（标题/正文/关键词），全小写。
//   ② 它待在索引里，就必须被签名覆盖：project 原先不在签名里——这是 0.6.10 没暴露的洞，
//      因为老实现每问现拼所以看不出来，一旦搬进索引，「改 project 不重建」就成了拿旧串答新库。
//   ③ 懒建 + 记账：没有标识符的问句一条 haystack 都不许建（中文问句占绝大多数），
//      有标识符时只建真正参与比较的条目，且同一张库连问多次只付一次钱。
const verbStats = { calls: 0, built: 0, reused: 0 };
function verbatimHayStats() {
  return { ...verbStats };
}
function resetVerbatimHayStats() {
  verbStats.calls = 0;
  verbStats.built = 0;
  verbStats.reused = 0;
}
function verbatimInputs(query, docs, opts, textOf, hayFor = null, identsIn = null) {
  verbStats.calls++;
  const idents = identsIn ?? (opts.verbatim === false ? [] : identsOf(query));
  return {
    idents,
    // 语义与老实现逐字相同（`docs.map((d) => textOf(d).toLowerCase())` 的下标版）：
    // 给了 `hayFor`（索引里的懒建访问器）就用它，否则退回现拼——keywordHitScore 走的就是后者，
    // 它的 haystack 少 id/project、只含标题/正文/关键词。
    hayOf: idents.length === 0 ? null : (hayFor ?? ((di) => textOf(docs[di]).toLowerCase())),
    rawVerbatim: docs.map(() => null),
    subjRatio: docs.map(() => 0)
  };
}
// [macro-fusion 0.2.153] 检索的固定开销：以前每问一次就把整库重新切一遍词、重建 tf/df——
// 1200 条记忆时单问 108ms，其中切词 30ms、建表 36ms、打分 42ms。可这三样里，
// 前两样跟「问什么」毫无关系：库没变，切出来的词和表也不会变。
// 所以把「跟问句无关的那一半」提出来做成一张索引：同一次会话里连问五个问题，
// 只该付一次切词的钱。索引带签名（条数 + 每条 id/更新时间/正文长度的哈希），
// 签名不对就重建——宁可多花 30ms，也不许拿旧表答新库。
//
// [macro-fusion 0.6.10] 签名自己也要记账：签名是**每问一次**都要算的固定开销，
// 而它算的东西（「库还是不是上一张库」）绝大多数时候答案是「没变」。
// 实测（660 / 2,000 / 5,000 / 10,000 条同构语料，`E:\Temp\cmp\scale010.mjs`）：
// 签名占一次热检索的 **28.8%–30.6%**，且随条数线性涨（0.96 / 2.84 / 7.04 / 14.16ms）。
// 钱花在两处：①每条都要切头 40、切尾 40、把关键词 join 成串——三次分配；
// ②逐字符 Math.imul 的 FNV 混算。既然「同一条记忆、字段没动」就该给出同一个数，
// 那就按**条**记账：WeakMap 以 doc 对象为键，存「上次算出的条级哈希 + 参与计算的字段快照」，
// 下次来先做值比较（字符串 === 在原生侧是 memcmp，比 JS 逐字符混算便宜一个量级），
// 全等就直接复用条级哈希。三条命门：
//   ① 比较的必须是**值**不是对象身份：同一对象就地改 content / 就地改 keywords 数组，
//      对象还是那个对象，值已经变了——签名必须跟着变，否则「拿旧表答新库」。
//   ② 条级哈希必须**与外部状态无关**才能缓存：老实现把每条一路 XOR/imul 进同一个滚动值里，
//      同一条的贡献随「前面有谁」变化，天然不可缓存。改成「每条先算自己的 32 位哈希，
//      再折进总账」，条级值就只由这条自己决定。
//   ③ 不参与缓存的形状（字段是对象、keywords 元素不是标量）走直算路径：缓存只许接
//      「值比较就能判断有没有变」的条目，判不了就别猜。
const SIG_DOC_CACHE = new WeakMap();
const sigStats = { calls: 0, hashed: 0, reused: 0, rebuilt: 0 };
function indexSignatureStats() {
  return { ...sigStats };
}
function resetIndexSignatureStats() {
  sigStats.calls = 0;
  sigStats.hashed = 0;
  sigStats.reused = 0;
  sigStats.rebuilt = 0;
}
function sigPrim(v) {
  const t = typeof v;
  return v === null || v === undefined || t === 'string' || t === 'number' || t === 'boolean';
}
// 条级哈希：字段、顺序、分隔符与 0.2.153 那版逐字相同（探针拿参考实现横比），只是不再共享滚动值。
function sigDocHash(d, kw) {
  let h = 2166136261 >>> 0;
  const put = (s) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
  };
  const sep = () => {
    h ^= 0x7c;
    h = Math.imul(h, 16777619) >>> 0;
  };
  // 只看长度会把「同一秒内等长改写」当成同一张库：字数一样、头尾一动就漏。
  // 取「长度 + 头 40 + 尾 40 + 标题全文 + 关键词全文 + 会话」——比全量哈希便宜一个量级，
  // 又把「等长改写」压到几乎不可能（真要撞上，得同时保住字数、首尾 80 字与标题关键词）。
  put(String(d?.id ?? '')); sep();
  put(String(d?.updated_at ?? d?.updatedAt ?? '')); sep();
  const content = String(d?.content ?? '');
  put(String(content.length)); sep();
  put(content.slice(0, 40)); sep();
  put(content.slice(-40)); sep();
  put(String(d?.title ?? '')); sep();
  // [macro-fusion 0.6.6] 关键词也走 kwList：字符串形态的词表换了内容同样是「另一张库」，
  // 只认数组会让「逗号串被改写」漏过签名、拿旧索引答新库。
  for (let i = 0; i < kw.length; i++) {
    if (i > 0) put('\u0001');
    put(String(kw[i] ?? ''));
  }
  sep();
  put(String(d?.source_session ?? '')); sep();
  // [macro-fusion 0.6.11] project 也进签名：它不进切词表，但进「原样匹配」那份 haystack。
  // 索引里存了 haystack 之后，project 一改而签名不变，就等于拿旧 haystack 答新库
  // （探针 `probe-verbatim` V4 就是拿这一条当红样本：去掉这行立刻红）。
  put(String(d?.project ?? '')); sep();
  return h >>> 0;
}
function sigKwSame(raw, store) {
  if (Array.isArray(raw)) {
    if (!Array.isArray(store)) return false;
    if (raw.length !== store.length) return false;
    for (let i = 0; i < raw.length; i++) if (raw[i] !== store[i]) return false;
    return true;
  }
  return raw === store;
}
function sigDocOf(d) {
  sigStats.hashed++;
  const obj = d !== null && typeof d === 'object';
  const cacheable = obj && sigPrim(d.id) && sigPrim(d.updated_at) && sigPrim(d.updatedAt) &&
    sigPrim(d.content) && sigPrim(d.title) && sigPrim(d.source_session) && sigPrim(d.project);
  if (!cacheable) {
    sigStats.rebuilt++;
    return sigDocHash(d, kwList(d));
  }
  // 关键词元素也得是标量才敢缓存：元素是对象时 String() 可能随它自己的状态变，值比较判不出来。
  const rawKw = d.keywords;
  const kwOk = Array.isArray(rawKw) ? rawKw.every(sigPrim) : sigPrim(rawKw);
  const prev = kwOk ? SIG_DOC_CACHE.get(d) : void 0;
  if (prev !== void 0 && prev.id === d.id && prev.u1 === d.updated_at && prev.u2 === d.updatedAt &&
      prev.c === d.content && prev.t === d.title && prev.s === d.source_session && prev.p === d.project &&
      prev.kwOk === kwOk && sigKwSame(rawKw, prev.kw)) {
    sigStats.reused++;
    return prev.h;
  }
  const kw = kwList(d);
  const h = sigDocHash(d, kw);
  sigStats.rebuilt++;
  if (!kwOk) return h;
  SIG_DOC_CACHE.set(d, {
    id: d.id, u1: d.updated_at, u2: d.updatedAt, c: d.content, t: d.title, s: d.source_session, p: d.project,
    kwOk, kw: Array.isArray(rawKw) ? rawKw.slice() : rawKw, h
  });
  return h;
}
function indexSignature(docs) {
  sigStats.calls++;
  let h = 2166136261 >>> 0;
  h ^= docs.length;
  h = Math.imul(h, 16777619) >>> 0;
  for (const d of docs) {
    h ^= sigDocOf(d);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${docs.length}:${h >>> 0}`;
}

// [macro-fusion 0.4.0 · P5] 自学习扩词：等价说法不再只靠手工表。
// 手工表（SYN_GROUPS）管「我已经知道的说法」，新领域、新术语、新缩写它一概不认识；
// 而库里每一条记忆都带着人写的 keywords——那就是一份随库更新的真词表。
// 于是共现从 keywords 上统计，而不是从 tokenize 出来的 bigram 上统计：
// bigram 里混着「名空/置面/地全/门读」这类跨词边界的碎片（真库里 223 个有扩词的词几乎全是碎片），
// keywords 里则全是真词（实测 2,866 个词、2,845 个有扩词，抽样 `推送→push/发版/github`、
// `基线→阴性对照/量具/doctor`、`预算→key/花钱/评测` 全是真语义关联）。
// 两级证据：同一条记忆里两个关键词同时出现 = 强（+2）；同一个 project 里两条记忆各自的词 = 弱（+1）。
// 剪枝两道（都在判据里量）：
//   ① 次数 ≥ 2，偶发一次不算关联；
//   ② 条件概率 cooc(a,b)/df(a) ≥ 0.25——a 出现十次只有一次带 b，那不算 a 的另一种说法。
// 共享汉字的词对（自测/自检、切片/片段）只记弱证据：它们可能是真同义，也可能是字面撞车，
// 一律排除会丢掉「自测≡自检」这种真桥，一律算强又会把字面族噪声顶上来，所以降到 +1 让它自己争。
var COOC_W_SAME = 2;
// 同 project 那层只算「跨文档」：一条记忆的关键词与同项目里**别的**记忆的关键词相交才算，
// 同一条内部的词对不重复计——否则「同一条 + 同 project」会自动凑到 2 分，
// 共享汉字的降权就等于没降。实现上每条记忆与「本项目所有词的并集减掉自己」交叉，
// 双向各记一次，所以一对词「在两条记忆里各出现一次」净得 2 分，正好够线；
// 「只出现在同一条里」得 0 分（那是同条层的活，权重 2）。
var COOC_W_PROJ = 1;
var COOC_SHARE_HAN_W = 1;
var COOC_MIN_COUNT = 2;
var COOC_MIN_RATIO = 0.25;
var COOC_TOP_PER_TERM = 6;

// keywords 字段有两种形态：真数组，或者一整串（逗号/顿号分隔，个别是 JSON 字符串）。
// 这里要的是原词，不是 tokenize 出来的 bigram——「阴性对照」必须保持四个字。
function coocWordsOf(d) {
  const raw = d && d.keywords;
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === "string" && raw.trim().length > 0) {
    const t = raw.trim();
    if (t.startsWith("[")) {
      try {
        const j = JSON.parse(t);
        list = Array.isArray(j) ? j : t.split(/[,，、;；]/);
      } catch {
        list = t.split(/[,，、;；]/);
      }
    } else list = t.split(/[,，、;；]/);
  }
  const out = [];
  for (const w of list) {
    const s = String(w ?? "").trim();
    if (s.length < 2 || s.length > 8) continue;
    if (!/[\u4e00-\u9fff]/.test(s) && !/^[a-zA-Z][a-zA-Z0-9_.-]{2,}$/.test(s)) continue;
    if (/^[0-9.]+$/.test(s)) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

// [macro-fusion 0.5.0 · P1] 词形桥：keywords 里是多字词（二甲双胍 / 降糖药 / 叶子发黄），
// 而问句与正文都被 tokenize 切成二元组——两套词形不在同一个坐标系里。共现表记得再准，
// 问句那头用「降糖」也永远查不到「降糖药」这条键：跨领域换说法 hit@1 实测 0/10。
// 第一版的做法是把 keywords 先切碎再学（表里全是 降糖/糖药 这种碎片），桥是长出来了，
// 但整词的语义一起丢了：一条记忆的 8–13 个关键词切完变 20 多个 token，同条层每对都同分，
// 「每词最多带 6 个」一砍就把真正要的映射对砍掉了（实测园艺「不开」只连到「叶子/发黄」，
// 「氮肥/过量」被排在第七位直接丢掉）。所以改成：**表里存整词**（降糖药 ↔ 二甲双胍），
// 只在查表那一刻补一层「碎片 → 整词」的桥（见 buildCoocForms）。
// 纪律不变：只投 keywords，绝不 tokenize 正文——碎片是正文切出来的，keywords 是字与词。
function coocFormsOf(words) {
  const out = [];
  for (const w of words) {
    for (const u of tokenize(w)) {
      if (u.length < 2) continue;
      if (!out.includes(u)) out.push(u);
    }
  }
  return out;
}

// [macro-fusion 0.5.0 · P1] 碎片 → 整词的桥：共现表里存的是 keywords 的**原词**（降糖药 / 二甲双胍 / 缺氮），
// 而索引里的文档词、问句词都被 tokenize 切成二元组（降糖/糖药、二甲/甲双/双胍）。两套词形不在一个
// 坐标系，表再准也接不上：查「降糖/糖药」得到 (无)，共现表里有降糖药带的一串邻居也白搭。
// 这张表就是坐标系之间的翻译：碎片 → 它属于哪几个整词（整词必须真的是共现表的键，否则查它也没邻居）。
// 一个碎片最多挂 4 个整词：挂太多说明这碎片本身没信息量（如「我们」「一直」），宁可不桥。
// 只在 searchAdaptive 那一层启用（第二遍），常规打分路径一律不开——宽池实测（106 条真库快照）
// 这一层常开会把两题换说法从第 1 挤到第 2，只有「补位」时才值。
var COOC_FORM_WORDS = 4;
function buildCoocForms(docs, cooc) {
  if (!(cooc instanceof Map)) return null;
  const out = new Map();
  for (const d of docs) {
    for (const w of coocWordsOf(d)) {
      const word = String(w ?? "").trim();
      if (word.length < 3 || !cooc.has(word)) continue;
      for (const f of coocFormsOf([word])) {
        if (f === word) continue;
        const list = out.get(f);
        if (!list) out.set(f, [word]);
        else if (!list.includes(word) && list.length < COOC_FORM_WORDS) list.push(word);
      }
    }
  }
  return out.size > 0 ? out : null;
}

function coocShareHan(a, b) {
  if (!/[\u4e00-\u9fff]/.test(a) || !/[\u4e00-\u9fff]/.test(b)) return false;
  for (const ch of a) if (b.includes(ch)) return true;
  return false;
}

function buildCoocSyn(docs, n, opts) {
  const pairs = new Map();
  // 两级证据分别记账：同条层（强）与项目层（弱）各一张表，最后按「强在前、弱补位」合流。
  // 混在一张表里按比例排序的话，项目层的词会把同条层的桥词挤出前六——实测宽池换说法因此从
  // 14/14 掉回 13/14（救回来的那一题正是被项目层顶掉的）。
  const projPairs = new Map();
  const bumpIn = (map, a, b, w) => {
    const cur = map.get(a);
    if (cur === void 0) map.set(a, /* @__PURE__ */ new Map([[b, w]]));
    else cur.set(b, (cur.get(b) ?? 0) + w);
  };
  const pairUp = (list, w) => {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a === b) continue;
        const ww = coocShareHan(a, b) ? Math.min(w, COOC_SHARE_HAN_W) : w;
        bumpIn(pairs, a, b, ww);
        bumpIn(pairs, b, a, ww);
      }
    }
  };
  const kwDf = new Map();
  // 表里一律存原词（不切碎）：语义与「每词几个邻居」的名额都靠原词撑住，碎片桥在查表时补（buildCoocForms）。
  const wordsOf = (d) => coocWordsOf(d);
  for (const d of docs) {
    const words = wordsOf(d);
    if (words.length === 0) continue;
    for (const w of words) kwDf.set(w, (kwDf.get(w) ?? 0) + 1);
    pairUp(words, COOC_W_SAME);
  }
  const byProject = new Map();
  for (const d of docs) {
    const words = wordsOf(d);
    if (words.length === 0) continue;
    const p = String(d.project ?? "全局");
    if (!byProject.has(p)) byProject.set(p, []);
    byProject.get(p).push(words);
  }
  for (const [, list] of byProject) {
    if (list.length < 2) continue;
    const union = new Set();
    for (const ws of list) for (const w of ws) union.add(w);
    const unionArr = [...union];
    for (const ws of list) {
      const self = new Set(ws);
      const others = unionArr.filter((w) => !self.has(w));
      if (others.length === 0) continue;
      for (const a of ws) {
        for (const b of others) {
          const ww = coocShareHan(a, b) ? Math.min(COOC_W_PROJ, COOC_SHARE_HAN_W) : COOC_W_PROJ;
          bumpIn(projPairs, a, b, ww);
          bumpIn(projPairs, b, a, ww);
        }
      }
    }
  }
  // 一张表的门与排序：次数、条件概率、比例降序。
  const pickFrom = (map, a, dfa) => {
    const others = map && map.get(a);
    if (!others || dfa <= 0) return [];
    const keep = [];
    for (const [b, c] of others) {
      if (c < COOC_MIN_COUNT) continue;
      const ratio = c / dfa;
      if (ratio < COOC_MIN_RATIO) continue;
      keep.push([b, ratio]);
    }
    keep.sort((x, y) => y[1] - x[1]);
    return keep.map(([b]) => b);
  };
  const out = new Map();
  const terms = /* @__PURE__ */ new Set([...pairs.keys(), ...projPairs.keys()]);
  for (const a of terms) {
    const dfa = kwDf.get(a) ?? 0;
    if (dfa <= 0) continue;
    const strong = pickFrom(pairs, a, dfa);
    const weak = pickFrom(projPairs, a, dfa);
    if (strong.length === 0 && weak.length === 0) continue;
    const seen = new Set();
    const list = [];
    for (const w of strong.concat(weak)) {
      if (seen.has(w)) continue;
      seen.add(w);
      list.push(w);
    }
    out.set(a, list.slice(0, COOC_TOP_PER_TERM));
  }
  return out.size > 0 ? out : null;
}

function buildSearchIndex(docs, opts = {}, sig = null) {
  const n = docs.length;
  const useField = opts.fieldBoost !== false;
  const kwTfW = Number.isFinite(opts.kwTfW) && opts.kwTfW >= 0 ? opts.kwTfW : KW_TF_W;
  const dText = opts.kwSeparate === false
    ? docText
    : (d) => [String(d.title ?? ''), String(d.content ?? '')].join(' ');
  const plainToks = docs.map((d) => tokenize(dText(d)));
  const sessTopics = opts.sessionTopic === false ? null : sessionTopicTerms(docs, plainToks);
  const docToks = sessTopics ? docs.map((d, i) => {
    const extra = sessTopics.get(d.source_session);
    return extra ? plainToks[i].concat(extra) : plainToks[i];
  }) : plainToks;
  const avgdl = docToks.reduce((s2, t) => s2 + t.length, 0) / n || 1;
  const bodyLen = docs.map((d) => {
    const t = tokenize(String(d.content ?? ''));
    return t.length > 0 ? t.length : 1;
  });
  const avgBody = bodyLen.reduce((s2, x) => s2 + x, 0) / n || 1;

  const df = new Map();
  const tf = [];
  const kwToks = opts.kwSeparate === false ? null : docs.map((d) => kwList(d).flatMap((w) => tokenize(String(w ?? ''))));
  // 倒排：词 → 出现过它的条目下标。打分只碰「问句里那几个词真的出现过」的条目，
  // 而不是把整库每条都乘一遍。opts.inverted === false 可关掉，用于阴性对照。
  const postings = opts.inverted === false ? null : new Map();
  for (let di = 0; di < docToks.length; di++) {
    const m = new Map();
    const seen = new Set();
    for (const t of docToks[di]) {
      m.set(t, (m.get(t) ?? 0) + 1);
      if (!seen.has(t)) {
        seen.add(t);
        df.set(t, (df.get(t) ?? 0) + 1);
        const p = postings?.get(t);
        if (p) p.push(di);
        else postings?.set(t, [di]);
      }
    }
    if (kwToks !== null) {
      for (const t of kwToks[di]) {
        m.set(t, (m.get(t) ?? 0) + kwTfW);
        if (!seen.has(t)) {
          seen.add(t);
          df.set(t, (df.get(t) ?? 0) + 1);
          const p = postings?.get(t);
          if (p) p.push(di);
          else postings?.set(t, [di]);
        }
      }
    }
    tf.push(m);
  }
  const titleSets = useField ? docs.map((d) => new Set(tokenize(String(d.title ?? '')))) : null;
  const kwSets = useField ? docs.map((d) => new Set(kwList(d).flatMap((w) => tokenize(String(w ?? ''))))) : null;
  // [macro-fusion 0.4.0 · P5] 共现表跟索引一起建（库一变就重算，不需要额外失效逻辑）。
  // coocLearn:false 一键回到「只有手工表」的旧口径，用来做开/关对照。
  const coocSyn = opts.coocLearn === false ? null : buildCoocSyn(docs, n, opts);
  // [macro-fusion 0.5.0 · P1] 碎片 → 整词的桥（opts.coocForms === false 可单独关掉，用来量这一层值多少分）。
  const coocForms = opts.coocForms === false ? null : buildCoocForms(docs, coocSyn);
  // [macro-fusion 0.6.11] 原样匹配的 haystack：懒建、随索引缓存（账在 `verbStats` 上方）。
  // 只在「问句里有标识符」时才被碰到；没碰过的条目一个字节都不占。
  const hayArr = new Array(n);
  const hayAt = (di) => {
    const got = hayArr[di];
    if (got !== void 0) {
      verbStats.reused++;
      return got;
    }
    const d = docs[di];
    const s = (String(d?.id ?? '') + ' ' + String(d?.project ?? '') + ' ' + docText(d)).toLowerCase();
    hayArr[di] = s;
    verbStats.built++;
    return s;
  };
  return {
    __n: n,
    __sig: sig ?? indexSignature(docs),
    __opts: `${useField ? 1 : 0}${opts.kwSeparate === false ? 0 : 1}${opts.sessionTopic === false ? 0 : 1}${kwTfW}${opts.coocLearn === false ? 0 : 1}${opts.coocForms === false ? 0 : 1}`,
    plainToks, docToks, avgdl, bodyLen, avgBody, df, tf, kwToks, kwTfW, titleSets, kwSets, postings, useField, coocSyn, coocForms,
    hayAt
  };
}

// 索引缓存：同一张库连问五个问题，只付一次切词的钱。
// 键是「签名 + 影响切词的那几个开关」，所以库一改（哪怕只改正文长度、只换 updated_at）
// 就是另一个键，旧表再也取不到——不靠调用方记得清缓存，也不许拿旧表答新库。
// 最多留 4 张（本机同时活跃的工作区通常 1–2 个），超出按最久未用淘汰。
const SEARCH_INDEX_CACHE_MAX = 4;
const searchIndexCache = new Map();

function indexPathKey(docs, opts) {
  return `${indexSignature(docs)}|${opts.fieldBoost === false ? 0 : 1}${opts.kwSeparate === false ? 0 : 1}${opts.sessionTopic === false ? 0 : 1}${Number.isFinite(opts.kwTfW) && opts.kwTfW >= 0 ? opts.kwTfW : KW_TF_W}${opts.inverted === false ? 0 : 1}${opts.coocLearn === false ? 0 : 1}${opts.coocForms === false ? 0 : 1}`;
}

// 调用方也可以直接传 opts.index（自己缓存那张表）；签名或口径对不上就自己重建——
// 传错表比慢更要命，所以这里宁可多算一次签名，也不"信任调用方"。
function searchIndexOf(docs, opts) {
  const key = indexPathKey(docs, opts);
  const given = opts.index;
  if (given && given.__n === docs.length && given.__sig === indexSignature(docs) &&
      given.__opts === `${opts.fieldBoost === false ? 0 : 1}${opts.kwSeparate === false ? 0 : 1}${opts.sessionTopic === false ? 0 : 1}${Number.isFinite(opts.kwTfW) && opts.kwTfW >= 0 ? opts.kwTfW : KW_TF_W}${opts.coocLearn === false ? 0 : 1}${opts.coocForms === false ? 0 : 1}`) {
    return given;
  }
  if (opts.cache === false) return buildSearchIndex(docs, opts, key);
  const hit = searchIndexCache.get(key);
  if (hit !== void 0) {
    searchIndexCache.delete(key);
    searchIndexCache.set(key, hit);
    return hit;
  }
  const built = buildSearchIndex(docs, opts, key);
  searchIndexCache.set(key, built);
  while (searchIndexCache.size > SEARCH_INDEX_CACHE_MAX) {
    const oldest = searchIndexCache.keys().next().value;
    searchIndexCache.delete(oldest);
  }
  return built;
}

// 缓存的自述与清空：探针要能问「现在几张表、键是什么」，也要能在量具里把状态归零。
// 不给外部改表的入口——只读条数与键，动表只允许 clear。
function searchIndexCacheInfo() {
  return { max: SEARCH_INDEX_CACHE_MAX, size: searchIndexCache.size, keys: [...searchIndexCache.keys()] };
}

function clearSearchIndexCache() {
  const n = searchIndexCache.size;
  searchIndexCache.clear();
  return n;
}

// ═══════════ [macro-fusion 0.6.0 · P1] 规模自适应 idf：库变大时，idf 在自己的簇里再算一遍 ═══════════
// 问题不是「排序算法不准」，而是**同一个词的稀有度会随库变大而失真**：40 条样张里「剂量」只在 1 条出现，
// 它几乎就是答案的指纹；578 条真库里「剂量」出现在 30 条、「医生」80 条——idf 一起掉下去，而十条各命中
// 五个常见词的干扰项分数累加起来就翻过了正解。实测这一层稀释值 −8.8pt（同批问句：冻结样张 hit@1 0.977 →
// 真库全量 0.889），掉的全是「邻居变多」，不是词听不懂。
// 修法不是「先筛掉不相关的东西」（分区会漏：正解落在区外就永远找不到），而是**让大家都参赛、但按谁的主场
// 算分**：第一遍照常用全库 idf 排，排完看前 M 名里哪些词「在候选里扎堆、在全库并不常见」——这些词才是
// 这一问的区分词；用区分词自长出一个簇（不引入 project / 标签 / 手工词表），再在簇里算一遍 idf，按 λ 混回去。
// 三条命门都是实测出来的，别省：
//   ① 簇内 df 必须往全库频率上做 Dirichlet 收缩（α≈20）。5 条小簇里「人人都有」的词 df=5/5 → idf≈0.087，
//      不收缩直接让照抄 hit@1 从 0.895 掉到 0.684（λ=1）、0.868（λ=0.5）——比不修还差。
//   ② 簇下限 8 条（不足按第一遍名次补），否则 df 统计只在 0/1 之间跳。
//   ③ λ 除了看榜首 margin，还必须有规模闸门 N≥300：只看 margin 时宽池 146 条换说法 hit@1 1.000→0.857
//      （2 题改判）——margin 小不等于被稀释，也可能只是两条本来就很像。
// 开关：opts.adaptiveIdf === true 才生效（默认关，关掉与改动前逐位相同）；产品入口 rankForSearch 打开它。
// 参数是量出来的、不是拍出来的（0.6.0 收口，660 条真库 / 照抄 38 + 换说法 12 + 锚 2）：
//   topM=8、cover=0（簇恒为 8 条）、α=100（强收缩）、λ 上限 0.3（只做保守微调）。
//   窗口 64 + cover 0.6 是「按设计意图」的写法，实测净负（照抄 0.868、换说法 0.250、误伤 2）：
//   候选窗口越大，区分词统计越接近全库比例，泛词与指纹词分不开，重扫反而把正解挤下去。
//   窗口 8 + α100 + cap0.3 是唯一同时满足「照抄 0.921 / 换说法 0.417 / hit@3 不动 / 误伤 0」的一档，
//   且 cap 0.25–0.40、α 50–100 连成平台（不是尖峰）——读数见 docs/PLAN-0.6.md §1。
const IDF_CLUSTER_TOP_M_DEF = 8;
const IDF_CLUSTER_MIN_DEF = 8;
const IDF_CLUSTER_COVER_DEF = 0;
const IDF_ALPHA_DEF = 100;
const IDF_SCALE_GATE_DEF = 300;
const IDF_MARGIN_HI_DEF = 0.15;
const IDF_MARGIN_LO_DEF = 0.05;
const IDF_LAM_CAP_DEF = 0.3;
// 榜首领先多少算「已经分得很开」（margin 大 → λ=0，不加局部 idf；margin 小 → λ=1，完全按簇算）
function adaptiveLamOf(top1, top2, opts) {
  const a = Number(top1) || 0;
  const b2 = Number(top2) || 0;
  const m = a > 0 ? (a - b2) / a : 0;
  const hi = Number.isFinite(opts.idfMarginHi) ? opts.idfMarginHi : IDF_MARGIN_HI_DEF;
  const lo = Number.isFinite(opts.idfMarginLo) ? opts.idfMarginLo : IDF_MARGIN_LO_DEF;
  const span = hi - lo;
  const cap = Number.isFinite(opts.idfLamCap) ? Math.min(1, Math.max(0, opts.idfLamCap)) : IDF_LAM_CAP_DEF;
  if (!(span > 0)) return Math.min(cap, m > hi ? 0 : 1);
  return Math.min(cap, Math.min(1, Math.max(0, (hi - m) / span)));
}
// 用「区分词」自长簇：输入第一遍的名次（raw 分降序的 di 列表）、逐条 tf、全库 df、n
function idfClusterOf(qToks, tf, df, n, order, raw, opts) {
  const M = Number.isFinite(opts.idfClusterTopM) && opts.idfClusterTopM > 0 ? Math.round(opts.idfClusterTopM) : IDF_CLUSTER_TOP_M_DEF;
  const minN = Number.isFinite(opts.idfClusterMin) && opts.idfClusterMin > 0 ? Math.round(opts.idfClusterMin) : IDF_CLUSTER_MIN_DEF;
  const cover = Number.isFinite(opts.idfClusterCover) ? Math.min(1, Math.max(0, opts.idfClusterCover)) : IDF_CLUSTER_COVER_DEF;
  const top = order.slice(0, M);
  if (top.length < minN) return null;
  // 区分词：在这批候选里出现的比例，明显高于它在全库的比例。比值≈1 是「到处都是」的泛词，
  // 比值远大于 1 才是「这一问的指纹」。dfG<2 的词没有统计意义，不当区分词。
  const w = new Map();
  for (const t of qToks) {
    const dfG = df.get(t) ?? 0;
    let dfT = 0;
    for (const di of top) if (tf[di].has(t)) dfT++;
    const rTop = dfT / top.length;
    const rG = n > 0 ? dfG / n : 0;
    const ratio = rG > 0 ? rTop / rG : rTop > 0 ? 3 : 0.5;
    w.set(t, ratio >= 1.5 && dfG >= 2 ? (ratio - 1) * Math.log(1 + dfG) : 0);
  }
  let anyDistinct = false;
  for (const v of w.values()) if (v > 0) anyDistinct = true;
  if (!anyDistinct) return null; // 一个区分词都没有：这一问对局部 idf 没有发言权，退全库
  const scored = [];
  for (const di of top) {
    let v = 0;
    for (const [t, ww] of w) if (ww > 0 && tf[di].has(t)) v += ww;
    if (v > 0) scored.push({ di, v });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.v - a.v);
  const total = scored.reduce((s, x) => s + x.v, 0);
  const pick = [];
  let acc = 0;
  for (const x of scored) {
    pick.push(x.di);
    acc += x.v;
    if (pick.length >= minN && (total <= 0 || acc / total >= cover)) break;
    if (pick.length >= M) break;
  }
  for (const di of top) {
    if (pick.length >= minN) break;
    if (!pick.includes(di)) pick.push(di);
  }
  if (pick.length < minN) return null;
  const dfL = new Map();
  for (const di of pick) for (const t of tf[di].keys()) dfL.set(t, (dfL.get(t) ?? 0) + 1);
  return { df: dfL, n: pick.length, terms: [...w].filter(([, v]) => v > 0).map(([t]) => t) };
}
// ═══════════════ [macro-fusion 0.6.4] 单字问句：切不出词 ≠ 库里没有 ═══════════════
// 症状：`tokenize` 只产出中日韩**二元组**（本文件 `if (run.length >= 2)`），一个汉字的问句切出来是
// 空数组，`search` 第一道门 `if (q.length === 0 && idents.length === 0) return []` 直接空手。
// 于是「读」「钱」「税」「梦」这类最直接的问法，库里明明写着，回执永远是空的——还是 0.6.2 那条
// 「把『有』说成『没有』」，只是那条治「剔词剔空」，这条治「压根切不出词」。两条是同一族病：
// 一个汉字进来，不该因为分词器的粒度而变成「没有」。
// 处方（窄到只治这一件事）：仅当**问句切不出任何词**、且问句就是**单个汉字**时，按原文子串在
// title/content/keywords 里找一次（NFKC + 小写），命中次数当分数，定序仍走 `bandize` 的四把钥匙。
// 为什么只放单字、不放任意短串：
//   · 两个汉字以上的中文问句本来就能切成二元组，走常规词法，不需要兜底；
//   · 英文问句一个字也能切（`run.join("").toLowerCase()`），而 `the`/`a` 这类被停用词表吃掉的
//     英文问句**绝不能**做子串——那才是真噪声，`probe-gold` G8「没有的事就空手」会当场判红。
//   · 所以这里的闸门是「一个汉字 + 标点」，不是「短」。
// [macro-fusion 0.6.5] 0.6.4 只认「正好一个码点」，于是 `读？` / `钱。` / `「花」` 又回到空手——
//   人打单字问题时几乎总带一个标点，闸门必须先把标点与空白剥掉再数汉字。剥法是「汉字之外只许标点
//   或空白」：字母/数字/符号（`读$`、`读1`）一律不放行，英文停用词照旧一个都不救（G8 仍要空手）。
//   同一个汉字重复（`读 读`）按一个算——问的是同一个字，不必造新口径。
function literalFallback(query, docs, opts = {}) {
  const needle = String(query ?? "").normalize("NFKC").trim().toLowerCase();
  const cps = Array.from(needle);
  const isHan = (c) => /[\u3400-\u9fff\uf900-\ufaff]/.test(c);
  const han = cps.filter(isHan);
  const rest = cps.filter((c) => !isHan(c));
  if (new Set(han).size !== 1) return [];
  if (!rest.every((c) => /[\s\p{P}]/u.test(c))) return [];
  const needle1 = han[0];
  const hits = [];
  for (const d of docs) {
    if (d === null || d === void 0 || typeof d !== "object") continue;
    const kw = Array.isArray(d.keywords) ? d.keywords.join(" ") : String(d.keywords ?? "");
    const hay = `${d.title ?? ""} ${d.content ?? ""} ${kw}`.normalize("NFKC").toLowerCase();
    let tf2 = 0;
    let at = hay.indexOf(needle1);
    while (at >= 0) {
      tf2 += 1;
      at = hay.indexOf(needle1, at + needle1.length);
    }
    if (tf2 === 0) continue;
    hits.push({ ...d, _raw: tf2, cover: 0, score: tf2, ...opts.explain === true ? { explain: { bm25: 0, literal: tf2, score: tf2 } } : {} });
  }
  if (hits.length === 0) return [];
  const k2 = opts.k ?? 5;
  // [macro-fusion 0.6.12] 只排前 k（下面只取前 k 条，全序没人读）。
  bandize(hits, "_raw", k2);
  if (opts.keepBand === true) return hits.slice(0, Number.isFinite(k2) && k2 > 0 ? Math.round(k2) : hits.length);
  return trimByBand(hits, k2, opts);
}
function search(query, docs, opts = {}) {
  // [macro-fusion 0.6.7] 一条 null 不许把整次检索打成异常（账在 `liveDocs` 上方）
  docs = liveDocs(docs);
  const k = opts.k ?? 5;
  const now = opts.now === void 0 ? Date.now() : opts.now;
  // [macro-fusion 0.2.170] 疑问框架先剥再切：`什么时候` 切成 `什么/么时/时候`，其中 `么时` 这类跨界碎片
  // 没有意义却能靠「文档里正好写着这个词」赢分（见 stripQuestionFrame 上方读数）。
  const qStrip = opts.questionStrip === false ? { text: query, stripped: [] } : stripQuestionFrame(query);
  const q = tokenize(qStrip.text);
  if (docs.length === 0) return [];
  // [macro-fusion 0.2.122] 实体先验的输入（问句里没有专有名词时为空数组，后面整段跳过）
  const entToks = opts.entityPrior === false
    ? []
    : queryEntities(query).map((e) => tokenize(e)).filter((t) => t.length === 1).map((t) => t[0]);
  const n = docs.length;
  // [macro-fusion 0.2.147] 标识符原样匹配的输入（问句里没有标识符时 hayOf 为 null，后面整段跳过）
  const idents = opts.verbatim === false ? [] : identsOf(query);
  // [macro-fusion 0.6.4] 切不出词不等于库里没有：单字问句交给原文子串兜底（账在 `literalFallback` 上方）。
  if (q.length === 0 && idents.length === 0) return literalFallback(query, docs, opts);
  // [macro-fusion 0.2.153] 切词与建表挪进索引：这部分跟「问什么」无关，只跟「库里有什么」有关。
  const index = searchIndexOf(docs, opts);
  // [macro-fusion 0.6.11] 原样匹配的 haystack 也走索引（懒建 + 随索引重建），这里只领一个访问器：
  // 老实现是 `docs.map((d) => textOf(d).toLowerCase())`——每问一次拼一遍整库，占热检索的四成。
  const { hayOf, rawVerbatim, subjRatio } = verbatimInputs(query, docs, opts, null, index.hayAt, idents);
  const verbOn = hayOf !== null;
  const { docToks, avgdl, bodyLen, avgBody, df, tf, kwToks, kwTfW, titleSets, kwSets, postings, coocSyn, coocForms } = index;
  const FIELD_TITLE_W = 0.6;
  const FIELD_KW_W = Number.isFinite(opts.fieldKwW) ? opts.fieldKwW : FIELD_KW_W_DEF;
  const COORD_W = Number.isFinite(opts.coordW) ? opts.coordW : COORD_W_DEF;
  const COORD_POW = Number.isFinite(opts.coordPow) && opts.coordPow > 0 ? opts.coordPow : COORD_POW_DEF;
  const k1 = 1.5;
  const b = 0.75;
  // 实体先验要逐条查「这条描述里有没有那个专名」——集合建在索引建立时最省，
  // 但 entToks 是问句决定的，只能每条两个词的量，留在 search 里。
  const entSets = entToks.length > 0 ? docToks.map((toks) => new Set(toks)) : null;
  const ENT_W = 0.8;
  // [macro-fusion 0.6.14] 一次 `df.get` 只管一个词（原来同一行里取两遍）。
  const idfGlobal = (t) => {
    const d0 = df.get(t) ?? 0;
    return Math.log(1 + (n - d0 + 0.5) / (d0 + 0.5));
  };
  // [macro-fusion 0.6.0 · P1] 第一遍用全库 idf；自适应开且 λ>0 时会被换成双尺度版，然后整个候选集重扫一遍。
  let idfOf = idfGlobal;
  // [macro-fusion 0.6.14] idf 只跟「这一趟用哪把尺子 + 词」有关，跟是哪条文档无关——可一问记一次。
  //
  // 症状（cpu-prof，10,000 条 / 300 问，MODE=search，总采样 5,671.8ms）：`scanDoc` 自证 17.8%，
  // `search` 自证 45.8%——两块里都有同一件事：每条候选对每个问句词重算一次 `Math.log`。
  // 覆盖度那圈 `for (const term of qKept) if (tf[di].has(term)) cover += idfOf(term);`、
  // 打分那圈 `const idf = idfOf(term);`、同义词那圈 `idfOf(a) * sat(f)`，全是「每条文档 × 每个词」。
  // 一个 5 词问句撞上 2,000 条候选 = 一万次 `Math.log`，而真正不同的词只有 5 个。
  //
  // 处方：加一层按词记忆化。值逐位相同（同一个 `Math.log` 的同一个入参，拿到的就是同一个双精度数），
  // 所以这不是「近似」，是纯省算。唯一要守的纪律：`idfOf` 被换掉时必须清缓存——自适应第二遍
  // （下面 `idfOf = (t) => …双尺度…`）换了尺子，老值一个都不许留。见 `idfCache = new Map();`。
  let idfCache = new Map();
  const idfAt = (t) => {
    const v = idfCache.get(t);
    if (v !== void 0) return v;
    const w = idfOf(t);
    idfCache.set(t, w);
    return w;
  };
  const qTerms = [...new Set(q)];
  // [macro-fusion 0.2.146] 噪声地板：剔掉的词既不进 BM25，也不进覆盖度分母——
  // 只剔分子不剔分母等于「问句更难满足」，会把真正相关的条目一起裁掉。
  const noiseDropped = opts.noiseFloor === false ? [] : noiseTermsOf(qTerms, df, n);
  // [macro-fusion 0.2.151] 虚词与噪声分开记账：噪声是「到处都是」，虚词是「哪都没有也不带信息」。
  const funcDropped = opts.funcFloor === false ? [] : funcTermsOf(qTerms);
  const stopOf = (t) => noiseDropped.includes(t) || funcDropped.includes(t);
  const stopAll = noiseDropped.length === 0 && funcDropped.length === 0;
  let qKept = stopAll ? qTerms : qTerms.filter((t) => !stopOf(t));
  let qLoop = stopAll ? q : q.filter((t) => !stopOf(t));
  if (qKept.length === 0) {
    qKept = qTerms;
    qLoop = q;
  }
  // [macro-fusion 0.6.2] 护栏②（「剔完一个词不剩就整段回退」）漏了同一件事的另一半：
  // **剔完还剩词，但剩的那些词库里一个都没有**（df=0）——那不是「宁可噪声」，是「必然空手」。
  // 读数（LoCoMo 10 段 / 1,531 问，`tools/bench-locomo.mjs`）：8 问回 0 条，全是这一支。
  // 例：`What Console does Nate own?` 切成 `consol`（库外，df=0）+ `nate`（629 条里 454 条有，
  // df 比 72% ≥ 一半）→ 噪声地板按设计剔掉 `nate`，留下 `consol`，于是候选择集里没有一条能命中。
  // 剔除「到处都是」的词本来是对的，错在**留下了一个不可能命中的词顶位**。
  // 处方：留下的词全都命中不了、而噪声地板确实剔过词时，把这些词「救回来」——它们是
  // df ≥ 一半的高频词，在本库里必然命中，救回来只会让回执从空变成「有」，不会开门给噪声。
  // 只救噪声地板剔的词（`noiseDropped`），不救虚词地板剔的（`funcDropped` 是「哪都没有也不带信息」，
  // 救回来就是硬凑；两层都剔掉的词按虚词算——`zzzz 什么` 不许因为语料里满是「什么」就凑出回执）：
  // 这一条是 G8「没有的事就空手」逼出来的——第一版把「问句里所有库里存在的词」
  // 都救回来，14 条无关问句里 `光合作用的暗反应发生在哪里`、`上一届世界杯冠军是谁` 立刻被
  // `合作/作用/反应`、`冠军/世界` 凑出回执（空手 10/14 → 8/14，G8 红）。救噪声词两件都满足：
  // 修掉「有却说没有」，且无关问句照旧空手（读数见 `docs/INTERNAL.md` 9.201，判据 `probe-empty` E1/E7）。
  const rescued = noiseDropped.filter((t) => !funcDropped.includes(t) && (df.get(t) ?? 0) > 0);
  if (rescued.length > 0 && !qKept.some((t) => (df.get(t) ?? 0) > 0)) {
    qKept = rescued;
    qLoop = q.filter((t) => rescued.includes(t));
  }
  let qIdfSum = opts.coord === false ? 0 : qKept.reduce((s2, t) => s2 + idfAt(t), 0) || 1;
  // [macro-fusion 0.6.15] 覆盖度与打分不再「每条 × 每个问句词」去 Map 里问一遍、也不每格再算一次 idf。
  // 两个问句数组一趟开头各记一次 idf（同一趟里 idf 只由词的 df 决定，是常量），覆盖度改成顺着倒排
  // 往回加：工作量从「候选数 × 问句词数」降到「这些词的出现次数之和」，加法的顺序仍是 qKept 原序，
  // 每条的浮点和逐位不变。倒排缺席（opts.inverted===false）时退回原来的逐条查表。
  let qKeptIdf = new Float64Array(qKept.length);
  let qLoopIdf = new Float64Array(qLoop.length);
  const refreshQidf = () => {
    for (let qi = 0; qi < qKept.length; qi++) qKeptIdf[qi] = idfAt(qKept[qi]);
    for (let qi = 0; qi < qLoop.length; qi++) qLoopIdf[qi] = idfAt(qLoop[qi]);
  };
  refreshQidf();
  const coverAcc = postings === null ? null : new Float64Array(docs.length);
  const buildCoverAcc = () => {
    if (coverAcc === null) return;
    coverAcc.fill(0);
    for (let qi = 0; qi < qKept.length; qi++) {
      const p = postings.get(qKept[qi]);
      if (p === void 0) continue;
      const w = qKeptIdf[qi];
      for (let pi = 0; pi < p.length; pi++) coverAcc[p[pi]] += w;
    }
  };
  buildCoverAcc();
  // 同义扩词只扩问句：表里没有的词、库里 df=0 的词都不进（扩了也没人能命中，白算一遍）。
  // [macro-fusion 0.4.0 · P5] 第四参是索引随库自建出来的共现表——手工表管「人确定过的说法」，
  // 共现表管「库里自己长出来的说法」。opts.coocLearn === false 时 index.coocSyn 为 null，
  // 这里就干净地退回只有手工表的老行为。
  // [macro-fusion 0.5.0 · P1] 第五参是「碎片 → 整词」的桥：问句里的碎片先落回整词，再去查共现表。
  // 少了这一层，表里存的降糖药/二甲双胍与索引里的 降糖/糖药 根本碰不到一起。
  const synOf = opts.synBridge === false ? null : synExpandOf(qKept, df, n, coocSyn, opts.synFormBridge === true ? coocForms : null);
  const synW = Number.isFinite(opts.synW) && opts.synW >= 0 ? opts.synW : SYN_W;
  // [macro-fusion 0.2.153] 打分只碰「问句里那几个词真的出现过」的条目。
  const coverLenRelief = Number.isFinite(opts.coverLenRelief) ? Math.min(1, Math.max(0, opts.coverLenRelief)) : COVER_LEN_RELIEF;
  // 倒排缺席（opts.inverted===false）或问句里有标识符（要逐条比原文）时退回全库扫描。
  const scanDoc = (di) => {
    let s = 0;
    // [macro-fusion 0.6.14] 每条的这几样在下面每一圈里都被重新取一遍：`tf[di]` 是数组索引 +
    // Map 载荷，`titleSets[di]`/`kwSets[di]` 同理。提到函数开头取一次——值逐位不变，只是少几万次属性访问。
    const tfi = tf[di];
    const titleSet = titleSets === null ? null : titleSets[di];
    const kwSet = kwSets === null ? null : kwSets[di];
    const len = opts.lengthOnBody === false ? docToks[di].length : bodyLen[di];
    const dl = opts.lengthOnBody === false ? avgdl : avgBody;
    // [macro-fusion 0.2.179] 覆盖度先算一步：它决定长度惩罚该不该打折（见 COVER_LEN_RELIEF）。
    let cvr = 0;
    if (qIdfSum > 0) {
      // [macro-fusion 0.6.15] 覆盖度走倒排账（coverAcc 已按 qKept 原序加好），没有倒排时退回逐条查表。
      if (coverAcc !== null) {
        coverOf[di] = Math.min(1, coverAcc[di] / qIdfSum);
      } else {
        let cover = 0;
        for (let qi = 0; qi < qKept.length; qi++) if (tfi.has(qKept[qi])) cover += qKeptIdf[qi];
        coverOf[di] = Math.min(1, cover / qIdfSum);
      }
      cvr = Math.pow(coverOf[di], COORD_POW);
    }
    const bEff = b * (1 - coverLenRelief * cvr);
    for (let qi = 0; qi < qLoop.length; qi++) {
      const term = qLoop[qi];
      const f = tfi.get(term);
      if (!f) continue;
      const idf = qLoopIdf[qi];
      let fw = 1;
      if (titleSet !== null && titleSet.has(term)) fw += FIELD_TITLE_W;
      if (kwSet !== null && kwSet.has(term)) fw += FIELD_KW_W;
      s += idf * fw * (f * (k1 + 1) / (f + k1 * (1 - bEff + bEff * len / dl)));
    }
    // 同义词只走一条窄通道：每个原始词最多取「最好的那个同义词」的一份分，不叠乘、不进覆盖度。
    if (synOf !== null) {
      const sat = (f) => f * (k1 + 1) / (f + k1 * (1 - bEff + bEff * len / dl));
      for (const alts of synOf.values()) {
        let best = 0;
        for (const a of alts) {
          const f = tfi.get(a);
          if (!f) continue;
          const v = idfAt(a) * sat(f);
          if (v > best) best = v;
        }
        s += synW * best;
      }
    }
    if (cvr > 0) s *= 1 - COORD_W + COORD_W * cvr;
    if (entSets) {
      let hit = 0;
      for (const t of entToks) if (entSets[di].has(t)) hit++;
      if (hit > 0) s *= 1 + ENT_W * (hit / entToks.length);
    }
    if (verbOn) {
      const vb = verbatimOf(idents, hayOf(di));
      if (vb.matched.length > 0) {
        rawVerbatim[di] = vb;
        const lead = String(docs[di].content ?? "").trimStart().toLowerCase();
        let sn = 0;
        for (const t of idents) if (lead.startsWith(t)) sn += 1;
        subjRatio[di] = idents.length === 0 ? 0 : Math.min(1, sn / idents.length);
      }
    }
    return s;
  
  };
  const raw = new Array(docs.length).fill(0);
  const coverOf = new Array(docs.length).fill(0);
  const candSet = postings === null || verbOn ? null : (() => {
    const set = new Set();
    for (const term of qLoop) {
      const p = postings.get(term);
      if (p) for (let pi = 0; pi < p.length; pi++) set.add(p[pi]);
    }
    if (synOf !== null) {
      for (const alts of synOf.values()) for (const a of alts) {
        const p = postings.get(a);
        if (p) for (let pi = 0; pi < p.length; pi++) set.add(p[pi]);
      }
    }
    return set;
  })();
  if (candSet === null) {
    for (let di = 0; di < docs.length; di++) raw[di] = scanDoc(di);
  } else {
    for (const di of candSet) raw[di] = scanDoc(di);
  }
  // [macro-fusion 0.6.0 · P1] 规模自适应 idf 的第二遍：先用全库 idf 排一遍（上面那次），
  // 再按「这一问自己的簇」重算 idf 重扫。小库（N<闸门）和关掉的路径连排序都不做，逐位保持原样。
  let adapt = null;
  if (opts.adaptiveIdf === true) {
    const gate = Number.isFinite(opts.idfScaleGate) && opts.idfScaleGate >= 0 ? opts.idfScaleGate : IDF_SCALE_GATE_DEF;
    if (n >= gate) {
      const order = [];
      for (let di = 0; di < docs.length; di++) if (raw[di] > 0) order.push(di);
      if (order.length >= 2) {
        // [macro-fusion 0.6.3] 原来并列按 `x - y`（语料下标）定序，等于「谁先进库谁说了算」：
        // 存储层换个顺序（更新改 rowid、VACUUM、分页）同一问句的簇就换了人，lam 与 top-M 跟着变。
        // 与 `bandize` 同一把梯子：更新得更晚的在前 → id 自然序。见 `tools/probe-determinism.mjs`。
        order.sort((x, y) => raw[y] - raw[x] || laterFirst(docs, x, y));
        const cl = idfClusterOf(qKept, tf, df, n, order, raw, opts);
        if (cl !== null) {
          const lam = adaptiveLamOf(raw[order[0]], raw[order[1]], opts);
          if (typeof process !== 'undefined' && process.env?.MEOW_IDF_DEBUG === '1') {
            try {
              console.error('[idf-debug] ' + JSON.stringify({ q: String(query), n, topM: Math.min(order.length, Number(opts.idfClusterTopM) || IDF_CLUSTER_TOP_M_DEF), cluster: cl.n, lam: Math.round(lam * 1e3) / 1e3, terms: cl.terms }));
            } catch {
              /* 诊断输出不许影响检索 */
            }
          }
          if (lam > 0) {
            const alpha = Number.isFinite(opts.idfAlpha) && opts.idfAlpha >= 0 ? opts.idfAlpha : IDF_ALPHA_DEF;
            // [macro-fusion 0.6.14] 换尺子先清账：上一趟记的是全库 idf，这一趟是双尺度 idf，值不同。
            idfCache = new Map();
            idfOf = (t) => {
              const g = idfGlobal(t);
              const pG = (df.get(t) ?? 0) / n;
              const p = (cl.df.get(t) ?? 0) + alpha * pG;
              const den = cl.n + alpha;
              const pr = den > 0 ? p / den : pG;
              if (!(pr > 1e-9)) return g;
              return (1 - lam) * g + lam * Math.log(1 + (1 - pr) / pr);
            };
            qIdfSum = opts.coord === false ? 0 : qKept.reduce((s2, t) => s2 + idfAt(t), 0) || 1;
            // [macro-fusion 0.6.15] 换完尺子，问句词的 idf 与覆盖度账都要按新尺子重记一遍。
            refreshQidf();
            buildCoverAcc();
            raw.fill(0);
            coverOf.fill(0);
            if (candSet === null) {
              for (let di = 0; di < docs.length; di++) raw[di] = scanDoc(di);
            } else {
              for (const di of candSet) raw[di] = scanDoc(di);
            }
            adapt = { lam, cluster: cl.n };
          }
        }
      }
    }
  }
  // [macro-fusion 0.2.148] 标识符补分挪到「加权之后」：补分以前进 raw，会被每条自己的
  // importance / 新鲜度 / 状态权重再乘一遍——于是一条 impW=1.75 的措辞命中能把「问的正是这条 id」
  // 压下去（实测问 0mwq5zzv：措辞那条 17.96，被指认那条只有 16.16）。指认是同义反复的最高形态，
  // 不该被别人的重要性稀释：先算完整分数，再按榜首的一个单位补上去（单位跟着榜走，不跟着词分走）。
  const identBandW = Number.isFinite(opts.identBandW) ? opts.identBandW : IDENT_BAND_W;
  const identSubjW = Number.isFinite(opts.identSubjW) ? opts.identSubjW : IDENT_SUBJ_W;
  const levelIntentW = Number.isFinite(opts.levelIntentW) ? opts.levelIntentW : LEVEL_INTENT_W;
  const lvRatio = Number.isFinite(opts.levelIntentRatio) ? opts.levelIntentRatio : LEVEL_INTENT_RATIO;
  const tipAssertW = Number.isFinite(opts.tipAssertW) ? opts.tipAssertW : TIP_ASSERT_W;
  // [macro-fusion 0.6.14] `explain` 关着的时候这份副本没人读——不问就别抄（10,000 条 × 每问一次）。
  const baseRaw = opts.explain === true ? raw.slice() : null;
  // [macro-fusion 0.6.14] `Math.max(...raw)` 把一万个数摊成实参再收回来，一圈循环就够（值逐位相同）。
  let maxRaw = 0;
  for (let di = 0; di < raw.length; di++) {
    const v = raw[di];
    if (!(v <= maxRaw)) maxRaw = v;
  }
  const hits = [];
  // [macro-fusion 0.6.14] 四个「先用后摘」的临时值以前挂在 hit 对象上，靠 `delete h._lv;` 收场。
  // `delete` 会把对象打进字典模式（V8 从此按哈希表存取），后面 bandize 每次读 `_raw` 都在付这笔账——
  // 行级读数（cpu-prof positionTicks，10,000 条 / 300 问，5,492ms 总采样）：`delete h._lv;` 一行
  // **791.5ms**，`delete h._vb;` + `delete h._sr;` 另 353ms，`delete h._tr;` 一起算进去接近两成。
  // 处方：这四样本来就不该出现在回执里，改成同下标平行数组（push 与 hits 同序，读它们的三个循环
  // 全在 bandize 之前跑，下标一直对得上），hit 对象上只留 `_raw` / `_subj` 这些真要参与定档的。
  const vbTmp = [];
  const srTmp = [];
  const lvTmp = [];
  const trTmp = [];
  // [macro-fusion 0.2.85] importance 以前只用来「豁免时间衰减」，从不进分数：一条 importance=4 的
  // 铁律和一条 importance=1 的随手记，只要 BM25 差一点点，顺序就由措辞决定而不是重要度决定
  // （实测：铁律 bm25=0.957 排在随手记 bm25=1.033 后面）。同一个引擎里 keywordHitScore 早就
  // 有 impW = 1 + (importance-1)*0.25——两个打分器口径不一致。这里对齐同一口径，并且只做加成、
  // 不做碾压：BM25 代表「说的是不是这件事」，重要度只该在同题竞争里把铁律抬上来，不该让一条
  // 沾边的 4 分压过高度相关的 1 分（0.15 级的加成永远翻不过 6 倍以上的 bm25 差）。
  const timeAnchor = timeAnchorOf(query, opts);
  const anchorToks = timeAnchor ? anchorListOf(query) : [];
  const anchorCoord = timeAnchor && ANCHOR_COORD_RE.test(String(query ?? ""));
  // 时间状语里的标识符是坐标：不进 bandize 的 -1 特权档（_ident / _subj 两条通道都关）。
  const identHardOk = !(anchorCoord && opts.anchorIdentBand !== true);
  const anchorSel = timeAnchor ? (di) => {
    const hay = String(docs[di].title ?? "") + " " + String(docs[di].content ?? "") + " " + String(docs[di].project ?? "");
    return anchorToks.some((t) => hay.includes(t));
  } : null;
  const impOf = (d) => {
    const v = Math.round(Number(d?.importance));
    return Number.isFinite(v) ? Math.min(4, Math.max(1, v)) : 1;
  };
  const lvIntent = intentLevelsOf(query);
  // [macro-fusion 0.2.179] 「X 还能跑吗」和「X 为什么封存」问的是同一件事：X 现在还在不在。
  // 两句的答案都在现状仓，都不该让「该怎么做」那条规矩顶上来。
  // [macro-fusion 0.2.180] 与 intentLevelsOf 同一把尺子：带缘由词的归缘由，不归现状。
  const situationQ = LEVEL_INTENT_SITUATION.test(String(query ?? "")) && LEVEL_INTENT_TOPIC.test(String(query ?? "")) === false;
  const causeQ = (situationQ || (lvIntent !== null && lvIntent.has("topic"))) && opts.causeAware !== false;
  const causeRuleFold = Number.isFinite(opts.causeRuleFold) ? Math.min(1, Math.max(0, opts.causeRuleFold)) : CAUSE_RULE_FOLD;
  const situationRuleFold = Number.isFinite(opts.situationRuleFold) ? Math.min(1, Math.max(0, opts.situationRuleFold)) : SITUATION_RULE_FOLD;
  const ruleFoldOf = (di) => causeQ && String(docs[di].level ?? "") === "rules" ? (situationQ ? situationRuleFold : causeRuleFold) : 1;
  const tipOn = tipAssertOn(query) && opts.tipAssert !== false;
  const statusDig = statusDigestOf(docs, query, verbOn, opts);
  for (let di = 0; di < docs.length; di++) {
    if (raw[di] <= 0 && rawVerbatim[di] === null && !(statusDig !== null && statusDig !== void 0 && statusDig.includes(di))) continue;
    // [macro-fusion 0.6.15] 这一条下面要读十来次同一条记录的字段：`docs[di]` 取一次，别每次重算下标。
    const dOf = docs[di];
    const lvHit = lvIntent !== null && lvIntent.has(String(dOf.level ?? "")) && raw[di] >= (lvRatio ?? 0.5) * maxRaw;
    let w = 1;
    // [macro-fusion 0.2.150] 近分带用同一个 85% 判据；衰减有下限，旧记忆不该被折成看不见。
    // [macro-fusion 0.2.179] 缘由问句不折：问的是当初为什么那样，旧是自然的（与时间锚同源）。
    const anchored = anchorSel === null ? false : anchorSel(di);
    if (!anchored && !causeQ && now !== null && dOf.importance < 3 && !(raw[di] >= IMP_BAND * maxRaw)) {
      w = Math.max(RECENCY_FLOOR, recencyWeight(now - (dOf.last_accessed_at ?? dOf.updated_at)));
    }
    const impW = 1 + (impOf(dOf) - 1) * 0.25;
    const stW = anchored ? 1 : statusWeight(dOf.status);
    // [macro-fusion 0.6.14] 这三样每条只算一次：`assertRatioOf` 原来在 `_tr` 与 `_raw` 里各算一遍，
    // `ruleFoldOf(di)` 原来在 `_raw`/`score`/`explain` 里各算一遍。算一次再引用，值逐位不变。
    const trOf = tipOn ? assertRatioOf(dOf.content) : 0;
    const foldOf = ruleFoldOf(di);
    const vbOf = rawVerbatim[di] === null ? void 0 : rawVerbatim[di];
    const srOf = subjRatio === void 0 ? 0 : subjRatio[di];
    vbTmp.push(vbOf);
    srTmp.push(srOf);
    lvTmp.push(lvHit && opts.levelIntent !== false ? 1 : 0);
    trTmp.push(trOf);
    hits.push({
      _subj: subjRatio === void 0 || opts.identSubjBand === false || !identHardOk ? 0 : srOf >= 0.5 ? 1 : 0,
      _raw: raw[di] * (1 + (vbOf === void 0 || opts.identBand === false || !identHardOk ? 0 : identBandW * vbOf.ratio) + (vbOf === void 0 || opts.identSubjBand === false || !identHardOk ? 0 : identSubjW * srOf) + (lvHit && opts.levelIntent !== false ? levelIntentW : 0) + (tipOn ? tipAssertW * trOf : 0)) * foldOf,
      cover: Math.round(coverOf[di] * 1e3) / 1e3,
      ...(anchored ? { anchored: true } : {}),
      id: dOf.id,
      level: dOf.level,
      title: dOf.title,
      content: dOf.content,
      importance: dOf.importance,
      updated_at: dOf.updated_at,
      // [macro-fusion 0.2.120] 命中对象以前只回 id/level/title/content/importance/updated_at/score，
      // keywords / project / created_at 被静默吞掉。后果不是「少个字段」：调用方拿不到这条记忆
      // 属于哪一天、哪个项目，只能自己按 id 回查一遍（OmniMemEval 的日期丢失就是这样，
      // temporal 类准确率因此卡在 0.2181，回查修好后到 0.7227）。这里原样透传，不改排序、不改分数。
      ...dOf.keywords === void 0 ? {} : { keywords: dOf.keywords },
      ...dOf.project === void 0 ? {} : { project: dOf.project },
      ...dOf.created_at === void 0 ? {} : { created_at: dOf.created_at },
      // [macro-fusion 0.6.0 · P4] status 以前不透传：回执里分不出这条是 active / stale / archived，
      // 调用方得为了一个字符串再 memory_read 一次（多一次往返，也容易干脆不查）。
      // 与上面 0.2.120 那批字段同规矩：原样透传，不参与打分、不改排序。
      ...dOf.status === void 0 ? {} : { status: dOf.status },
      ...dOf.source_session === void 0 ? {} : { source_session: dOf.source_session },
      score: raw[di] * w * impW * stW * foldOf,
      ...opts.explain === true ? { explain: { bm25: Math.round(baseRaw[di] * 1e3) / 1e3, importance: dOf.importance, importanceWeight: Math.round(impW * 1e3) / 1e3, entities: entToks.length, recencyWeight: Math.round(w * 1e3) / 1e3, statusWeight: Math.round(stW * 1e3) / 1e3, cover: Math.round(coverOf[di] * 1e3) / 1e3, ...(adapt === null ? {} : { adaptiveIdf: { lam: Math.round(adapt.lam * 1e3) / 1e3, cluster: adapt.cluster } }), ...(qStrip.stripped.length === 0 ? {} : { stripped: qStrip.stripped.slice() }), ...(noiseDropped.length === 0 ? {} : { noiseDropped: noiseDropped.slice() }), ...(funcDropped.length === 0 ? {} : { funcDropped: funcDropped.slice() }), ...(vbOf === void 0 ? {} : { verbatim: vbOf.matched.slice() }), ...(timeAnchor ? { timeAnchor: true } : {}), ...(anchored ? { anchorHit: true } : {}), score: Math.round(raw[di] * w * impW * stW * foldOf * 1e3) / 1e3 } } : {}
    });
  }
  // [macro-fusion 0.2.148] 补分在这里落地：单位是「榜首的实际分数」，不是词分——所以一条
  // importance 更高的措辞命中不会再把它压下去；摘掉临时挂的原样证据，别让它漏进回执。
  if (verbOn) {
    let topScore = 0;
    for (const h of hits) if (h.score > topScore) topScore = h.score;
    const unitScore = topScore > 0 ? topScore : 1;
    for (let hi = 0; hi < hits.length; hi++) {
      const h = hits[hi];
      const vb = vbTmp[hi];
      const srHit = Number(srTmp[hi]) || 0;
      if (vb === void 0 || vb === null) continue;
      const idHit = vb.matched.some((t) => String(h.id ?? "").toLowerCase().startsWith(t.replace(/\(局部\)$/, "")));
      const add = unitScore * vb.ratio * (idHit ? IDENT_ID_W : IDENT_W) * (identHardOk ? 1 : 0);
      h.score += add;
      if (idHit && identHardOk) h._ident = true;
      if (h.explain !== void 0) h.explain.identBonus = Math.round(add * 1e3) / 1e3;
      // [macro-fusion 0.2.172] 主语位指认：这条记忆的主语就是问句点名的那样东西，
      // 比「正文里顺带提过」更该排前面。
      if (srHit > 0 && identSubjW > 0 && opts.identSubj !== false) {
        const addS = unitScore * srHit * identSubjW;
        h.score += addS;
        if (h.explain !== void 0) h.explain.subjBonus = Math.round(addS * 1e3) / 1e3;
      }
    }
  }
  // [macro-fusion 0.2.150] 分档排序：权重只能改判同档内的顺序，跨档不许越级。
  // [macro-fusion 0.2.173] 层级意图是软偏好，分两处落地：_raw 那一侧（hits.push 时算好）
  // 决定「够不够格进这一档」，score 这一侧决定「进了这一档排多前」。只做前者会像这版
  // 第一次那样——条目进了第一档却还是第二名，因为档内仍按没抬过的 score 排。
  for (let hi = 0; hi < hits.length; hi++) {
    if (lvTmp[hi] !== 1) continue;
    const h = hits[hi];
    if (levelIntentW > 0 && opts.levelIntent !== false) {
      h.score *= 1 + levelIntentW;
      if (h.explain !== void 0) h.explain.levelIntent = true;
    }
  }
  // [macro-fusion 0.2.174] 断言密度也分两处：_raw 那侧决定「够不够进这一档」，
  // score 这侧决定「进了这一档排多前」——只做前者，同档里它一动也动不了。
  for (let hi = 0; hi < hits.length; hi++) {
    const tr = Number(trTmp[hi]) || 0;
    if (tr <= 0 || !tipOn || opts.tipAssert === false) continue;
    if (tipAssertW > 0) {
      const h = hits[hi];
      h.score *= 1 + tipAssertW * tr;
      if (h.explain !== void 0) h.explain.tipAssert = true;
    }
  }
  // [macro-fusion 0.2.176] 现状仓落地：分数跟「榜首的实际分数」走（不跟词分走，它词分可能就是 0），
  // 只高一头 15%——够进第一档排前面，又不至于把「同一次提问里真正命中标识符」的那条埋掉
  //（那种问句在 statusDigestOf 里已经被 hasIdent 挡回去了，这里只是不越权）。
  if (statusDig !== null && statusDig !== void 0) {
    let topScore = 0;
    let topRaw = 0;
    const digIds = new Set(statusDig.map((di) => String(docs[di].id)));
    for (const h of hits) {
      if (digIds.has(String(h.id))) continue;
      if (Number(h.score) > topScore) topScore = Number(h.score);
      if (Number(h._raw) > topRaw) topRaw = Number(h._raw);
    }
    for (let si = 0; si < statusDig.length; si++) {
      const di = statusDig[si];
      const digId = String(docs[di].id);
      const share = 1.15 - si * 0.03;
      const digScore = topScore > 0 ? topScore * share : share;
      const digRaw = topRaw > 0 ? topRaw * share : share;
      const exist = hits.find((h) => String(h.id) === digId);
      if (exist === void 0) {
        const d = docs[di];
        hits.push({
          ...d,
          _raw: digRaw,
          cover: 0,
          score: digScore,
          ...opts.explain === true ? { explain: { bm25: 0, statusDigest: true, score: Math.round(digScore * 1e3) / 1e3 } } : {}
        });
      } else {
        if (digRaw > Number(exist._raw)) exist._raw = digRaw;
        if (digScore > Number(exist.score)) exist.score = digScore;
        if (exist.explain !== void 0) {
          exist.explain.statusDigest = true;
          if (typeof exist.explain.score === "number") exist.explain.score = Math.round(Number(exist.score) * 1e3) / 1e3;
        }
      }
    }
  }
  // [macro-fusion 0.6.12] 只排前 k：keepBand / trimByBand 都只读前 k 条。
  bandize(hits, '_raw', k);
  // keepBand 只给 searchHybrid 用：融合要按 band 收口，就不能在这里先摘掉。
  if (opts.keepBand === true) return hits.slice(0, Number.isFinite(k) && k > 0 ? Math.round(k) : hits.length);
  return trimByBand(hits, k, opts);
}
// ═══════════════ [macro-fusion 0.5.0 · P1] 换场景检索：词形桥的第二遍 ═══════════════
// 问题不是「词库太死」，而是**两套词形不在一个坐标系**：共现表学的是 keywords 的原词
// （降糖药 / 二甲双胍 / 氮肥过量），索引与问句都被 tokenize 切成二元组（降糖/糖药、二甲/甲双/双胍、
// 氮肥/肥过/过量）。于是问「降糖药第一次吃多少量」时，表里明明有降糖药的邻居，查「降糖」却得到 (无)，
// 表再准也接不上——这就是「换个场景、换种叫法就查不到」的真正原因，不是词库小。
// 修法分两层：
//  ① 索引里多一张 碎片 → 整词 的桥（buildCoocForms），把两套词形接起来；
//  ② 但这条桥**不进常规打分**：宽池实测（106 条真库快照）常开会把两题换说法从第 1 挤到第 2
//    （1.000 → 0.857），因为它给两跳来的候选和真词一样的票。
// 所以桥只在这一层开，而且只「补位」不「翻盘」：第一遍照常听（老行为一字不改），听完再按桥听
// 第二遍，两遍用 RRF 并（第一遍权重 1、第二遍 FORM_MERGE_W）。第一遍排第一的仍是第一遍的答案，
// 桥捞回来的条目填进第 2、第 3 位——冷域实测 hit@3 0.40 → 0.80，hit@1 不动（0.10）。
// 桥接不上（问句里没有一个碎片能落回整词）就原样返回，不花第二遍的钱。
function searchAdaptive(query, docs, opts = {}) {
  const first = search(query, docs, opts);
  if (opts.formRescue === false || opts.synBridge === false || opts.coocForms === false) return first;
  if (first.length === 0) return first;
  let idx = null;
  try {
    idx = searchIndexOf(docs, opts);
  } catch {
    idx = null;
  }
  const forms = idx === null ? null : idx.coocForms;
  if (!(forms instanceof Map)) return first;
  // 桥得真接得上才值得再听一遍：问句里至少有一个碎片能落回某个整词（而且那个整词在表里）。
  // 接不上就原样返回——这一步是常数，不会因为多听一遍把内存检索拖慢。
  let bridged = false;
  for (const t of q0ToksOf(query)) {
    if (forms.has(t)) {
      bridged = true;
      break;
    }
  }
  if (!bridged) return first;
  // [macro-fusion 0.6.0 · P1] 第二遍（桥）不吃局部 idf：桥本来就只补第 2、第 3 位，
  // 给它双尺度 idf 会让「补位候选」按另一套稀有度重排，把补位的名额压掉。第一遍按簇算、第二遍按全库算。
  // 第二遍（词形桥）只吃全局 idf：实测双遍并不比单遍更好（换说法 hit@3 的微小差异只有 1 题，
  // 却把改动面翻倍），所以定稿为「只有第一遍按簇重排」。
  const alt = search(query, docs, { ...opts, synFormBridge: true, adaptiveIdf: false });
  if (alt.length === 0) return first;
  // 融合而不是替换：第一遍的排序是主（权重 1），第二遍按名次补位（权重 FORM_MERGE_W）。
  // 为什么不用「第二遍更确定就整份替换」：实测替换会把第一遍排第一的挤下去（财务「发票丢了
  // 还能报销吗」0 → 1），而两份名单里各占第一的条目会打平。RRF 只做「补位」，不做「翻盘」：
  // 第一遍的第 1 名仍然是第 1 名，除非第二遍把它排到很后面（此时它本来也没听懂）。
  const k = Number.isFinite(opts.k) && opts.k > 0 ? Math.round(opts.k) : first.length;
  const score = /* @__PURE__ */ new Map();
  const keep = /* @__PURE__ */ new Map();
  const w = Number.isFinite(opts.formMergeW) ? opts.formMergeW : FORM_MERGE_W;
  const add = (list, weight) => {
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      const id = String(h.id);
      const rr = weight / (FORM_RRF_K + i);
      score.set(id, (score.get(id) ?? 0) + rr);
      const prev = keep.get(id);
      if (prev === void 0 || weight >= 1) keep.set(id, h);
    }
  };
  add(first, 1);
  add(alt, w);
  const ordered = [...keep.keys()].sort((a, b) => {
    const d = score.get(b) - score.get(a);
    if (Math.abs(d) > 1e-12) return d;
    const ra = Number(keep.get(a)._raw ?? keep.get(a).score) || 0;
    const rb = Number(keep.get(b)._raw ?? keep.get(b).score) || 0;
    return rb - ra;
  });
  // [macro-fusion 0.5.0 · P1] 「只补位」的硬边界：合并完如果**名次一个字都没变**，就把第一遍原样
  // 返回，连分数都不动。理由有两层：① 用户看得见的是分数，桥没改变结论时不该让数字漂
  // （probe-cost 的快照 C5 就是这么守的：只许变快，不许变答案）；② 顺序没变时合并纯属白算。
  const merged = ordered.slice(0, Number.isFinite(k) && k > 0 ? k : ordered.length).map((id) => keep.get(id));
  const sameOrder = merged.length === first.length && merged.every((h, i) => String(h.id) === String(first[i].id));
  if (sameOrder) return first;
  return merged;
}
function q0ToksOf(query) {
  const out = [];
  for (const t of tokenize(String(query ?? ""))) if (t.length >= 2) out.push(t);
  return out;
}
function keywordHitScore(query, docs, opts = {}) {
  // [macro-fusion 0.6.7] 与 search 同口径：坏行先筛掉，别让一条 null 引到 `d.content` 上抛
  docs = liveDocs(docs);
  const k = opts.k ?? 2;
  const now = opts.now === void 0 ? Date.now() : opts.now;
  const keep = (ts) => ts.filter((t) => t.length >= 2);
  const q = keep(tokenize(query));
  if (docs.length === 0) return [];
  const timeAnchor = timeAnchorOf(query, opts);
  const anchorToks = timeAnchor ? anchorListOf(query) : [];
  const anchorCoord = timeAnchor && ANCHOR_COORD_RE.test(String(query ?? ""));
  const identHardOk = !(anchorCoord && opts.anchorIdentBand !== true);
  const anchorSel = timeAnchor ? (di) => {
    const hay = String(docs[di].title ?? "") + " " + String(docs[di].content ?? "") + " " + String(docs[di].project ?? "");
    return anchorToks.some((t) => hay.includes(t));
  } : null;
  // [macro-fusion 0.2.151] 与 search() 同口径：虚词不进证据（两个打分器不许两套词表）
  const funcDropped = opts.funcFloor === false ? [] : funcTermsOf([...new Set(q)]);
  const qUse = funcDropped.length === 0 ? q : q.filter((t) => !funcDropped.includes(t));
  const qTf = /* @__PURE__ */ new Map();
  for (const t of qUse) qTf.set(t, (qTf.get(t) ?? 0) + 1);
  const n = docs.length;
  // [macro-fusion 0.2.147] 与 search() 同口径：标识符原样命中也在这里补分（两个打分器不许两套口径）
  const { idents, hayOf, rawVerbatim } = verbatimInputs(query, docs, opts, (d) => String(d.id ?? "") + " " + String(d.title ?? "") + " " + String(d.content ?? "") + " " + (Array.isArray(d.keywords) ? d.keywords.join(" ") : ""));
  // [macro-fusion 0.6.4] 单字问句在这里也照同一口径兜底：词法切不出 ≠ 关键词里没有。
  if (q.length === 0 && idents.length === 0) return literalFallback(query, docs, opts);
  const docToks = docs.map((d) => keep(tokenize([d.content, d.title ?? ""].join(" "))));
  const df = /* @__PURE__ */ new Map();
  const tf = [];
  for (const toks of docToks) {
    const m = /* @__PURE__ */ new Map();
    const seen = /* @__PURE__ */ new Set();
    for (const t of toks) {
      m.set(t, (m.get(t) ?? 0) + 1);
      if (!seen.has(t)) {
        seen.add(t);
        df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
    tf.push(m);
  }
  const idf = (t) => Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
  const raw = docs.map((_, di) => {
    let s = 0;
    for (const [t, f] of qTf) {
      if (tf[di].has(t)) s += idf(t) * f;
    }
    if (hayOf !== null) {
      const vb = verbatimOf(idents, hayOf(di));
      if (vb.matched.length > 0) rawVerbatim[di] = vb;
    }
    return s;
  });
  // [macro-fusion 0.2.148] 补分挪到加权之后（同 search 口径：指认不该被重要性稀释）
  const maxRaw = Math.max(...raw);
  const out = [];
  for (let di = 0; di < docs.length; di++) {
    if (raw[di] <= 0 && rawVerbatim[di] === null) continue;
    const len = docToks[di].length;
    let overlap = 0;
    for (const t of qTf.keys()) if (tf[di].has(t)) overlap++;
    const coverage = len > 0 ? overlap / len : 0;
    let w = 1;
    // [macro-fusion 0.2.150] 近分带用同一个 85% 判据；衰减有下限，旧记忆不该被折成看不见。
    const anchored = anchorSel === null ? false : anchorSel(di);
    if (!anchored && now !== null && docs[di].importance < 3 && !(raw[di] >= IMP_BAND * maxRaw)) {
      w = Math.max(RECENCY_FLOOR, recencyWeight(now - (docs[di].last_accessed_at ?? docs[di].updated_at)));
    }
    const impW = 1 + (docs[di].importance - 1) * 0.25;
    const stW = anchored ? 1 : statusWeight(docs[di].status);
    const titleHit = tokenize(docs[di].title ?? "").some((t) => qTf.has(t));
    out.push({
      _vb: rawVerbatim[di] === null ? void 0 : rawVerbatim[di],
      _raw: raw[di],
      id: docs[di].id,
      level: docs[di].level,
      title: docs[di].title,
      content: docs[di].content,
      importance: docs[di].importance,
      updated_at: docs[di].updated_at,
      score: raw[di] * coverage * w * impW * stW * (titleHit ? 1.2 : 1)
    });
  }
  // [macro-fusion 0.2.148] 与 search 同口径：单位取榜首实际分数，补完再排序。
  if (hayOf !== null) {
    let topScore = 0;
    for (const h of out) if (h.score > topScore) topScore = h.score;
    const unitScore = topScore > 0 ? topScore : 1;
    for (const h of out) {
      const vb = h._vb;
      delete h._vb;
      if (vb === void 0 || vb === null) continue;
      const idHit = vb.matched.some((t) => String(h.id ?? "").toLowerCase().startsWith(t.replace(/\(局部\)$/, "")));
      h.score += unitScore * vb.ratio * (idHit ? IDENT_ID_W : IDENT_W);
      if (idHit && identHardOk) h._ident = true;
    }
  }
  // [macro-fusion 0.2.150] 与 search 同口径：分档排序。
  // [macro-fusion 0.6.12] 只排前 k（下面只 slice(0, k)）。
  bandize(out, '_raw', k);
  for (const h of out) {
    delete h._raw;
    delete h._ident;
  }
  return out.slice(0, k);
}
function tfVector(toks) {
  const m = /* @__PURE__ */ new Map();
  for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const [k, v] of small) {
    const w = big.get(k);
    if (w) dot += v * w;
  }
  return dot / Math.sqrt(na * nb);
}
// [macro-fusion 0.2.90] 「相似」在这个库里有两把尺子，以前只报了一把：
//   ① cosine（tf 向量余弦）——本函数一直用的排序尺子，对长文宽容（长文里嵌一句同文也能到 0.7），
//      回答的是「话题/用词重叠多少」，适合排序；
//   ② overlapOfSets（词集 Jaccard）——写侧 similarity() 用的去重尺子，逐字级严格，
//      回答的是「是不是同一句话」，memory_remember 的 80% 合并门槛量的就是它。
// 实测同一对内容，两把尺子能差出一个量级：长条目里嵌着一模一样的短句，cosine 0.715 / Jaccard 0.35；
// 近重复（改几个字）则 0.944 / 0.81。只报 cosine，读者会把「同话题」当成「同一句」，
// 也没法跟 memory_remember 回执里的「重复度 N%」对上号。所以两个都算、都报。
// 输入也必须同源：写侧合并判的是 similarity(r.content, content)——**纯正文**，不含标题和 keywords。
// 所以 repeat 也只比正文（cosine 照旧用 docText，关键词参与排序）；否则同一对内容写侧报 81%、读侧报 71%，
// 两个数对不上号，等于又造了一把新尺子。
function overlapOfSets(sa, sb) {
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}
function findSimilar(target, docs, k = 5, targetContent) {
  const targetToks = tokenize(target);
  const targetVec = tfVector(targetToks);
  if (targetVec.size === 0) return [];
  // repeat 的基准侧：优先用调用方给的纯正文（写侧口径），没给就退回 target 本身
  const repeatSet = new Set(tokenize(targetContent === undefined ? target : targetContent));
  const scored = [];
  for (const d of docs) {
    const toks = tokenize(docText(d));
    const s = cosine(targetVec, tfVector(toks));
    if (s <= 0) continue;
    scored.push({
      id: d.id,
      level: d.level,
      title: d.title,
      content: d.content,
      similarity: Math.round(s * 1e3) / 1e3,
      repeat: Math.round(overlapOfSets(repeatSet, new Set(tokenize(d.content ?? ""))) * 1e3) / 1e3
    });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, k);
}
var DRIFT_THRESHOLD = 0.3;
function topicDrift(turnText, topics) {
  if (topics.length === 0) return { topTopic: null, topScore: 0, suggestsNew: false, coldStart: true };
  const coldStart = topics.length < 3;
  const q = tfVector(tokenize(turnText));
  if (q.size === 0) return { topTopic: null, topScore: 0, suggestsNew: false, coldStart };
  let best = null;
  let bestScore = 0;
  for (const t of topics) {
    const v = tfVector(tokenize(docText(t)));
    const s = cosine(q, v);
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
  }
  return {
    topTopic: best,
    topScore: bestScore,
    suggestsNew: !coldStart && bestScore < DRIFT_THRESHOLD,
    coldStart
  };
}

// src/inject.ts
var DEFAULT_OPTS = { hitTopK: 2, titleMax: 40 };
function sessionsFile(workspace, sessionId, dir = ".dsh-meow") {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  return join6(workspace, dir, "sessions", `${safe}.json`);
}
var MAX_REINJECT_PROJECTS = 8;
var MAX_REINJECT_WRITTEN = 20;
function readSeenFile(workspace, sessionId, dir) {
  try {
    const text = readFileSync5(sessionsFile(workspace, sessionId, dir), "utf8");
    const parsed = JSON.parse(text);
    return {
      injected: Array.isArray(parsed.injected) ? parsed.injected.filter((x) => typeof x === "string") : [],
      searched: Array.isArray(parsed.searched) ? parsed.searched.filter((x) => typeof x === "string") : [],
      accessed: Array.isArray(parsed.accessed) ? parsed.accessed.filter((x) => typeof x === "string") : [],
      written: Array.isArray(parsed.written) ? parsed.written.filter((x) => typeof x === "string") : [],
      projectsQueried: Array.isArray(parsed.projectsQueried) ? parsed.projectsQueried.filter((x) => typeof x === "string") : [],
      reinjectPending: parsed.reinjectPending === true,
      currentProject: typeof parsed.currentProject === "string" && parsed.currentProject.length > 0 ? parsed.currentProject : null
    };
  } catch {
    return { injected: [], searched: [], accessed: [], written: [], projectsQueried: [], reinjectPending: false, currentProject: null };
  }
}
function writeSeenFile(workspace, sessionId, seen, dir) {
  const file = sessionsFile(workspace, sessionId, dir);
  mkdirSync5(dirname5(file), { recursive: true });
  writeFileSync4(file, JSON.stringify({
    injected: seen.injected,
    searched: seen.searched,
    accessed: seen.accessed,
    written: seen.written,
    projectsQueried: seen.projectsQueried,
    reinjectPending: seen.reinjectPending,
    currentProject: seen.currentProject
  }), "utf8");
}
function readInjected(workspace, sessionId, dir = ".dsh-meow") {
  return readSeenFile(workspace, sessionId, dir).injected;
}
function markInjected(workspace, sessionId, ids, dir = ".dsh-meow") {
  if (ids.length === 0) return;
  const seen = readSeenFile(workspace, sessionId, dir);
  const set = new Set(seen.injected);
  for (const id of ids) set.add(id);
  seen.injected = [...set];
  writeSeenFile(workspace, sessionId, seen, dir);
}
function readSeen(workspace, sessionId, dir = ".dsh-meow") {
  const s = readSeenFile(workspace, sessionId, dir);
  return /* @__PURE__ */ new Set([...s.injected, ...s.searched, ...s.accessed]);
}
function markSearched(workspace, sessionId, ids, dir = ".dsh-meow") {
  if (ids.length === 0) return;
  const seen = readSeenFile(workspace, sessionId, dir);
  const set = new Set(seen.searched);
  for (const id of ids) set.add(id);
  seen.searched = [...set];
  writeSeenFile(workspace, sessionId, seen, dir);
}
function markAccessed(workspace, sessionId, ids, dir = ".dsh-meow") {
  if (ids.length === 0) return;
  const seen = readSeenFile(workspace, sessionId, dir);
  const set = new Set(seen.accessed);
  for (const id of ids) set.add(id);
  seen.accessed = [...set];
  writeSeenFile(workspace, sessionId, seen, dir);
}
function markWritten(workspace, sessionId, ids, dir = ".dsh-meow") {
  if (ids.length === 0) return;
  const seen = readSeenFile(workspace, sessionId, dir);
  const ordered = seen.written.filter((id) => !ids.includes(id));
  ordered.push(...ids);
  seen.written = ordered.slice(-MAX_REINJECT_WRITTEN);
  writeSeenFile(workspace, sessionId, seen, dir);
}
function readWritten(workspace, sessionId, dir = ".dsh-meow") {
  return readSeenFile(workspace, sessionId, dir).written;
}
function markProjectQueried(workspace, sessionId, project, dir = ".dsh-meow") {
  const names = project.split(",").map((p) => p.trim()).filter((p) => p.length > 0 && !isGlobalProject(p));
  if (names.length === 0) return;
  const seen = readSeenFile(workspace, sessionId, dir);
  const ordered = seen.projectsQueried.filter((p) => !names.includes(p));
  ordered.push(...names);
  seen.projectsQueried = ordered.slice(-MAX_REINJECT_PROJECTS);
  writeSeenFile(workspace, sessionId, seen, dir);
}
function readProjectQueried(workspace, sessionId, dir = ".dsh-meow") {
  return readSeenFile(workspace, sessionId, dir).projectsQueried;
}
function markReinjectPending(workspace, sessionId, dir = ".dsh-meow") {
  const seen = readSeenFile(workspace, sessionId, dir);
  if (seen.reinjectPending) return;
  seen.reinjectPending = true;
  writeSeenFile(workspace, sessionId, seen, dir);
}
function clearReinjectPending(workspace, sessionId, dir = ".dsh-meow") {
  const seen = readSeenFile(workspace, sessionId, dir);
  if (!seen.reinjectPending) return;
  seen.reinjectPending = false;
  writeSeenFile(workspace, sessionId, seen, dir);
}
function isReinjectPending(workspace, sessionId, dir = ".dsh-meow") {
  return readSeenFile(workspace, sessionId, dir).reinjectPending;
}
function releaseSeen(workspace, sessionId, dir = ".dsh-meow") {
  const seen = readSeenFile(workspace, sessionId, dir);
  seen.injected = [];
  seen.searched = [];
  writeSeenFile(workspace, sessionId, seen, dir);
}
function getCurrentProject(workspace, sessionId, dir = ".dsh-meow") {
  return readSeenFile(workspace, sessionId, dir).currentProject;
}
function setCurrentProject(workspace, sessionId, project, dir = ".dsh-meow") {
  const seen = readSeenFile(workspace, sessionId, dir);
  seen.currentProject = project;
  writeSeenFile(workspace, sessionId, seen, dir);
}
function toDocs(rows) {
  return rows.map((r) => ({
    id: r.id,
    level: r.level,
    title: r.title,
    content: r.content,
    keywords: r.keywords,
    importance: r.importance,
    created_at: r.created_at,
    updated_at: r.updated_at,
    last_accessed_at: r.last_accessed_at
    // #91：衰减按最后使用时间
  }));
}
function buildInjectionBody(db, o) {
  const lbl3 = (key, params) => fillTemplate(keyedValue("labels", key), params);
  const soul = db.list("soul", { status: "active" });
  const user = db.list("user", { status: "active" });
  const lines = [lbl3("inject.title"), ""];
  const injected = [];
  const pushEntries = (label, rows) => {
    if (rows.length === 0) return;
    lines.push(lbl3("inject.sectionFormat", { label }));
    for (const r of rows) {
      lines.push(`- ${r.content}`);
      injected.push(r.id);
    }
    lines.push("");
  };
  pushEntries(lbl3("inject.aboutYou"), soul);
  pushEntries(lbl3("inject.aboutUser"), user);
  const globalRules = db.list("rules", { status: "active" }).filter((r) => isGlobalScope(r.project) && r.importance >= 2);
  pushEntries(lbl3("inject.rules"), globalRules);
  const projectNames = db.listProjectNames();
  if (projectNames.length > 0) {
    const max = o.titleMax;
    const shown = projectNames.map((n) => n.length > max ? n.slice(0, max) + "\u2026" : n);
    lines.push(lbl3("inject.sectionFormat", { label: lbl3("inject.guide") }));
    lines.push(lbl3("inject.guideSearchLine"));
    lines.push(lbl3("inject.guideProjectLine"));
    lines.push(lbl3("inject.guideProjects", { list: shown.join(" / ") }));
    lines.push("");
  }
  if (lines.length <= 2) return null;
  lines.push(lbl3("inject.end"));
  lines.push(lbl3("inject.boundary"));
  return { body: lines.join("\n").trimEnd(), injectedIds: injected };
}
function buildInjection(db, workspace, sessionId, _firstUserText = "", opts = {}, dir = ".dsh-meow") {
  const o = { ...DEFAULT_OPTS, ...opts };
  const built = buildInjectionBody(db, o);
  if (built === null) return null;
  const text = built.body;
  if (built.injectedIds.length > 0) markInjected(workspace, sessionId, built.injectedIds, dir);
  return { text, injectedIds: built.injectedIds };
}
var lbl2 = (key, params) => fillTemplate(keyedValue("labels", key), params);
var sectionTitle = (sub) => lbl2(`project.section.${sub}`);
function sortByUpdatedAt(list) {
  return [...list].sort((a, b) => (a.updated_at ?? 0) - (b.updated_at ?? 0) || a.created_at - b.created_at);
}
function fmtProjectRow(r) {
  const abs = new Date(r.updated_at).toISOString().slice(0, 16).replace("T", " ");
  return `[${projectLabel(r.project)} : ${r.level}] [${r.id}] ${abs} [${relativeTime(r.updated_at)}]
${r.content}`;
}
function buildProjectSection(db, workspace, project, dir) {
  const rows = db.list("project").filter((r) => projectList(r.project).includes(project));
  const ids = [];
  const render = (list) => {
    for (const r of list) ids.push(r.id);
    return list.map(fmtProjectRow).join("\n");
  };
  const active2 = rows.filter((r) => r.status === "active");
  const done = sortByUpdatedAt(
    rows.filter((r) => r.subcategory === "todo" && r.status === "stale" && r.updated_at !== null).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)).slice(0, 5)
  );
  const bySub = /* @__PURE__ */ new Map();
  for (const r of active2) {
    const sub = r.subcategory ?? "overview";
    const list = bySub.get(sub) ?? [];
    list.push(r);
    bySub.set(sub, list);
  }
  const sections = [];
  const projectRules = sortByUpdatedAt(
    db.list("rules").filter((r) => projectList(r.project).includes(project) && r.status === "active")
  );
  if (projectRules.length > 0) {
    sections.push(`${lbl2("inject.rules")}
${render(projectRules)}`);
  }
  for (const sub of PROJECT_SUBCATEGORIES) {
    if (sub === "todo") {
      const todos = sortByUpdatedAt(bySub.get("todo") ?? []);
      if (todos.length === 0 && done.length === 0) continue;
      const lines = [sectionTitle("todo")];
      if (done.length > 0) {
        lines.push(lbl2("project.todoDone"));
        for (const r of done) {
          ids.push(r.id);
          lines.push(fmtProjectRow(r));
        }
      }
      if (todos.length > 0) {
        lines.push(lbl2("project.todoOpen"));
        for (const r of todos) {
          ids.push(r.id);
          lines.push(fmtProjectRow(r));
        }
      }
      sections.push(lines.join("\n"));
    } else {
      const list = sortByUpdatedAt(bySub.get(sub) ?? []);
      if (list.length === 0) continue;
      sections.push(`${sectionTitle(sub)}
${render(list)}`);
    }
  }
  if (sections.length === 0) return null;
  const dbPath = memoryDbPath(workspace, dir);
  const text = [
    lbl2("project.header", { name: project }),
    "",
    sections.join("\n\n"),
    "",
    "\u2014\u2014",
    "\u8BF4\u660E\uFF1A\u6B64\u5904\u53EA\u63D0\u4F9B active \u7684\u8BB0\u5FC6\u3002",
    `\u5982\u679C\u4F60\u60F3\u770B\u975E active \u6761\u76EE\uFF08archived=\u5220\u9664 / stale=\u5B8C\u7ED3\uFF09\uFF0C\u6216\u67D0\u6761\u8BB0\u5FC6\u7684\u5177\u4F53\u65F6\u95F4\u6233\uFF08\u8BB0\u5FC6\u65F6\u95F4\u6233=\u8BE5\u7A97\u53E3 dream \u5C01\u5B58\u65F6\u523B\uFF09\u3001\u8BB0\u5FC6\u6765\u6E90\uFF08source_session\uFF09\u3001\u91CD\u8981\u6027\u3001\u5173\u952E\u8BCD\u7B49\u5143\u6570\u636E\uFF0C\u53EF\u4EE5\u76F4\u63A5\u53BB\u641C\u8BB0\u5FC6\u5E93 SQLite\uFF1A${dbPath}`,
    "\uFF08\u5E93\u5185\u7ED3\u6784\uFF1A\u4E03\u5C42\u8868 soul/user/project/fact/lesson/topic/rules\uFF0C\u5B57\u6BB5\u542B id/title/content/importance/keywords/status/corrected/project/subcategory/goal/source_session/created_at/updated_at\uFF08\u8BB0\u5FC6\u65F6\u95F4\u6233=\u6700\u540E\u66F4\u65B0\u65F6\u95F4\uFF09/last_accessed_at\uFF1B\u53E6\u6709 dream_log \u6574\u7406\u7559\u75D5\u8868\u3001windows \u7A97\u53E3\u65F6\u95F4\u8868\uFF1B\u4E5F\u53EF\u6309 id \u7528 memory_read \u770B\u5355\u6761\u5B8C\u6574\u5143\u6570\u636E\uFF09",
    `\u5982\u679C\u4F60\u60F3\u4E86\u89E3\u672A\u88AB\u8BB0\u5F55\u7684\u66F4\u591A\u7EC6\u8282\uFF0C\u53EF\u4EE5\u76F4\u63A5\u53BB\u641C\u4F1A\u8BDD\u5386\u53F2\u76EE\u5F55\uFF08dsh \u7684 session \u65E5\u5FD7\uFF0C\u4F4D\u7F6E\u7531 DSH_HOME \u51B3\u5B9A\uFF0C\u9ED8\u8BA4 ~/.dsh/sessions\uFF0C\u55B5\u7248\u4E3A dsh-home/sessions\uFF09\uFF0C\u6309\u4F1A\u8BDD id \u67E5\u539F\u59CB\u8BB0\u5F55\u3002`
  ].join("\n");
  return { text, ids };
}
function buildProjectSectionText(db, workspace, project, dir = ".dsh-meow") {
  return buildProjectSection(db, workspace, project, dir)?.text ?? null;
}
function buildWrittenSection(db, workspace, sessionId, dir, exclude) {
  const ordered = [...readWritten(workspace, sessionId, dir)];
  for (const { id } of db.idsBySession(sessionId)) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  const rows = [];
  for (const id of ordered) {
    if (exclude.has(id)) continue;
    const found = db.findById(id);
    if (!found || found.row.status !== "active") continue;
    rows.push(found.row);
  }
  const kept = rows.slice(-MAX_REINJECT_WRITTEN);
  if (kept.length === 0) return null;
  return {
    text: [
      lbl2("inject.sectionFormat", { label: lbl2("inject.writtenSection") }),
      lbl2("inject.writtenIntro"),
      ...kept.map(fmtProjectRow)
    ].join("\n"),
    ids: kept.map((r) => r.id)
  };
}
function buildReinjection(db, workspace, sessionId, projects, opts = {}, dir = ".dsh-meow") {
  const o = { ...DEFAULT_OPTS, ...opts };
  const snapshot = buildInjectionBody(db, o);
  const projectTexts = [];
  const projectIds = /* @__PURE__ */ new Set();
  for (const project of projects) {
    const built = buildProjectSection(db, workspace, project, dir);
    if (built !== null) {
      projectTexts.push(built.text);
      for (const id of built.ids) projectIds.add(id);
    }
  }
  const written = buildWrittenSection(db, workspace, sessionId, dir, /* @__PURE__ */ new Set([...snapshot?.injectedIds ?? [], ...projectIds]));
  if (snapshot === null && projectTexts.length === 0 && written === null) return null;
  const lines = [];
  if (snapshot !== null) {
    lines.push(snapshot.body);
    lines.push("");
  }
  if (projectTexts.length > 0 || written !== null) {
    lines.push(lbl2("inject.sectionFormat", { label: lbl2("inject.reinjectSection") }));
    lines.push(lbl2("inject.reinjectIntro"));
    lines.push("");
    if (projectTexts.length > 0) {
      lines.push(projectTexts.join("\n\n"));
      lines.push("");
    }
  }
  if (written !== null) {
    lines.push(written.text);
    lines.push("");
  }
  lines.push(lbl2("inject.boundary"));
  const text = lines.join("\n").trimEnd();
  const replayedIds = [...snapshot?.injectedIds ?? [], ...written?.ids ?? []];
  if (replayedIds.length > 0) markInjected(workspace, sessionId, replayedIds, dir);
  return { text, injectedIds: replayedIds };
}
function hitQuery(db, workspace, sessionId, userText, o, dir) {
  const seenState = readSeenFile(workspace, sessionId, dir);
  const currentProject = seenState.currentProject;
  const hitRows = [
    ...db.list("fact", { status: "active" }),
    ...db.list("lesson", { status: "active" }),
    ...db.list("rules", { status: "active" }),
    ...db.list("topic", { status: "active" })
  ].filter(
    (r) => (isGlobalScope(r.project) || currentProject !== null && projectCovers(r.project, currentProject)) && r.source_session !== sessionId && !seenState.injected.includes(r.id)
    // 已注入先排除再截断（#67）：先 hitTopK 后过滤，
  );
  if (hitRows.length === 0) return [];
  const query = userText.slice(0, 500);
  const docs = toDocs(hitRows).map((d) => ({
    ...d,
    // 匹配面 = 条目关键词（LLM 提取或自动 bigram；无关键词的旧条目回退内容前 100 字）。
    // [macro-fusion 0.6.6] 同 docText：keywords 缺失 / 非数组时不许在这里抛（旧条目会整批读不出来）。
    content: Array.isArray(d.keywords) && d.keywords.length > 0 ? d.keywords.join(" ") : String(d.content ?? "").slice(0, 100)
  }));
  const hits = keywordHitScore(query, docs, { k: o.hitTopK });
  const byId = new Map(hitRows.map((r) => [r.id, r]));
  return hits.map((h) => {
    const row = byId.get(h.id);
    return { id: h.id, level: h.level, content: row?.content ?? h.content, project: row?.project ?? null, updated_at: row?.updated_at ?? null };
  });
}
function buildHitInjection(db, workspace, sessionId, userText, opts = {}, dir = ".dsh-meow") {
  const o = { ...DEFAULT_OPTS, ...opts };
  const fresh = hitQuery(db, workspace, sessionId, userText, o, dir);
  if (fresh.length === 0) return null;
  const lines = [keyedValue("labels", "inject.hitHeader")];
  for (const h of fresh) {
    const proj = projectLabel(h.project);
    const time = h.updated_at ? ` ${new Date(h.updated_at).toISOString().slice(0, 16).replace("T", " ")} [${relativeTime(h.updated_at)}]` : "";
    lines.push(`[${proj} : ${h.level}] [${h.id}]${time}`);
    lines.push(h.content);
    lines.push("");
  }
  lines.push(lbl2("inject.boundary"));
  const text = lines.join("\n").trimEnd();
  const ids = fresh.map((h) => h.id);
  markInjected(workspace, sessionId, ids, dir);
  for (const h of fresh) db.bumpHit(h.level, h.id);
  return { text, injectedIds: ids };
}

// src/tools.ts
var T = (key) => keyedValue("tools", key);
var L = (key, params) => fillTemplate(keyedValue("labels", key), params);
var toolGate;
function setMemoryToolGate(gate) {
  toolGate = gate;
}
function refuseOrThrow(kind, exec) {
  if (toolGate === void 0) return;
  const workspace = workspaceOf(exec);
  if (workspace === void 0) return;
  const sessionId = sessionIdOf(exec);
  const refusal = kind === "read" ? toolGate.refuseRead?.(workspace, sessionId) : toolGate.refuseWrite?.(workspace, sessionId);
  if (refusal !== null && refusal !== void 0) throw new Error(refusal);
}
function describeArg(value) {
  if (typeof value === "string") return `string("${value.slice(0, 40)}")`;
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return "null";
  return typeof value;
}
function normalizeKeywords(raw) {
  const out = [];
  const push = (v) => {
    const t = v.trim();
    if (t.length > 0) out.push(t);
  };
  const walk = (v) => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (typeof v !== "string") return;
    const text = v.trim();
    if (text.length === 0) return;
    if (text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          walk(parsed);
          return;
        }
      } catch {
      }
      walk(text.replace(/^\[+|\]+$/g, ""));
      return;
    }
    if (/[,，、;；\n]/.test(text)) {
      for (const part of text.split(/[,，、;；\n]+/)) push(part);
      return;
    }
    push(text);
  };
  walk(raw);
  return out;
}
function coerceNumber(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : void 0;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t.length === 0) return void 0;
    const n = Number(t);
    return Number.isFinite(n) ? n : void 0;
  }
  return void 0;
}
function coerceBoolean(raw) {
  if (raw === true) return true;
  if (typeof raw === "number") return raw === 1;
  if (typeof raw === "string") return ["true", "1", "yes", "y"].includes(raw.trim().toLowerCase());
  return false;
}
function filterSearchable(rows, opts) {
  return rows.filter((r) => {
    if (opts.project && opts.project.length > 0 && !opts.project.some((p) => projectCovers(r.project, p))) return false;
    const statuses = opts.status?.filter((s) => s !== "all") ?? [];
    if (statuses.length > 0 && !statuses.includes(r.status)) return false;
    if (opts.days && Date.now() - r.created_at > opts.days * 864e5) return false;
    return true;
  });
}
function workspaceOf(exec) {
  const cwd = exec.agent?.session?.header?.cwd;
  if (typeof cwd === "string" && cwd.length > 0) return cwd;
  return getDreamWorkspace() ?? void 0;
}
function sessionIdOf(exec) {
  const header = exec.agent?.session?.header ?? {};
  const id = typeof header.id === "string" && header.id.length > 0 ? header.id : null;
  if (header.origin === "subagent" && header.parentSession !== void 0) {
    const p = header.parentSession;
    if (typeof p === "string" && p.length > 0) return p;
    if (p !== null && typeof p === "object" && typeof p.id === "string") {
      return p.id;
    }
  }
  return id;
}
function similarity(a, b) {
  return overlapOfSets(new Set(tokenize(a)), new Set(tokenize(b)));
}
var DEDUP_THRESHOLD = 0.8;
// [macro-fusion 0.2.88] 「同一句话存两层」：写去重只在同一层里比（db.list(level)），所以同一句
// 既写 fact 又写 lesson 会真的落下两份——实测两条分数一模一样（1.280 / 1.280）、检索时并排端出来，
// 白占一个 k 名额、同一段字要让模型读两遍。层不同不等于内容不同，这里补两处：
//   ① 写的时候扫一遍别的层，撞上了就照样写（层各有分工是合法的），但回执点名「另一层已有」；
//   ② 检索的时候把内容几乎一样的条目折叠掉（只折「逐字级重复」，改写过的不会误折），
//      折了几条写进尾注，并给 dedupe: false 看全量的出路（教训 63：收窄必须自带出口）。
// [macro-fusion 0.2.90] 两个数并排报出来之后，最常见的两种误读要当场拆掉：
// 「相似度高」被当成「同一句话」、以及「逐字重复度高」被当成「话题相同」。
// 判据用两个绝对量（≥0.50 且 repeat <0.50），不用「相差几个点」：实测长条目里嵌一句是
// cosine 0.715 / repeat 0.354（差 36 个点），近重复 0.944 / 0.808（差 14 个点），
// 而轻度重叠可能只差十几个点却同样不是同一句——「逐字连一半都对不上」更贴近要说的事。
function similarCalibNote(hits, freshHits) {
  const calib = [];
  if (freshHits.length > 0)
    calib.push(`命中里有 ${freshHits.length} 条是本会话刚写的（${freshHits.map((h) => h.level).join(" / ")}）——它们是刚才那几条，不是库里积累下来的旧账；别把「我自己刚记的」当成「已有依据」。`);
  const looksLike = hits.filter((h) => h.similarity >= 0.5 && h.repeat < 0.5);
  if (looksLike.length > 0)
    calib.push(`其中 ${looksLike.length} 条看着像、其实不是同一句：相似度 ≥0.50 但逐字重复度不到 50%（写侧要 ${Math.round(DEDUP_THRESHOLD * 100)}% 才算重复）——长条目里嵌了一句，或者只是同话题；别当成「这句话早就记过了」。`);
  const verbatim = hits.filter((h) => h.repeat >= DEDUP_THRESHOLD);
  if (verbatim.length > 0)
    calib.push(`其中 ${verbatim.length} 条逐字重复度 ≥${Math.round(DEDUP_THRESHOLD * 100)}%：写侧会判重复，多半是同一句话分别存进了两层，用 memory_update 把其中一条 status 设 archived。`);
  return calib.join(" ");
}
function crossLevelDupe(db, level, content) {
  let best = null;
  for (const lv of LEVELS) {
    if (lv === level) continue;
    for (const r of db.list(lv, { status: "active" })) {
      const sim = similarity(r.content, content);
      if (sim >= DEDUP_THRESHOLD && (!best || sim > best.sim)) best = { id: r.id, level: lv, sim };
    }
  }
  return best;
}
// [macro-fusion 0.2.92] 短 id 只有 8 位，而 id 开头就是时间戳的 base36——同一批次里连写两条经常撞在一起
// （实测连写 BASE / NEAR 两条都截成 `0mwo1yus`）。回执 / 清单上端一个**指向两条**的短 id，等于让人拿着它
// 去 memory_update，而 update 遇到歧义前缀会直接拒绝——读起来却像「这条记忆不见了」。
// 所以凡是给人拿去改库的短 id，先用它自己在全表确认唯一：不唯一就往下延，直到能唯一定位。
function uniqueShortId(db, level, id, min = 8) {
  const full = String(id ?? "");
  if (full.length <= min) return full;
  for (let n = min; n < full.length; n++) {
    const p = full.slice(0, n);
    const hits = db.p(`SELECT id FROM ${level} WHERE id LIKE ?`).all(`${p}%`);
    if (hits.length <= 1) return p;
  }
  return full;
}
function crossLevelNote(hit, db) {
  if (!hit) return "";
  const shortId = db === undefined ? hit.id.slice(0, 8) : uniqueShortId(db, hit.level, hit.id);
  return `另一层已有几乎一样的条目（${hit.level} ${shortId}，重复度 ${Math.round(hit.sim * 100)}%）：这条照样写下了，但同一句话存两层，检索时两条会一起冒出来、白占名额。它们若本是一件事，用 memory_update 把其中一条 status 设 archived；若两层各有分工，把措辞写开一点。`;
}
// [macro-fusion 0.2.136] 写入侧的第三件事：既不是「重复」也不是「跨层」，是「同一件事的两个版本」。
// 实测：0.2.132 / 0.2.133 / 0.2.134 / 0.2.135 四条交付态 fact，逐字重复度只有四成多——写侧不合并
// （线是 0.8）、跨层也不管，于是库里并排躺着四条「当前版本是 X」。检索时模型读到哪条算数？没答案。
// 这类不是措辞重复，是**结论互斥**，只能靠硬事实认出来：版本号（1.2.3）与日期（2026-11-21）。
// 判据刻意窄：同层、两边都有 token、且 token 集合不同、且相似度过 0.3 —— 只报「它写 A，你这次写 B」，
// 不说「可能相关」这种没有信息量的话。提醒不改库（写入照旧），出口是 supersedes / memory_update。
var CONFLICT_SIM = 0.3;
var CONFLICT_MAX = 3;
var VERSION_TOKEN = /(?:^|[^\w.])(\d+\.\d+(?:\.\d+){0,2})(?![\w.])/g;
var DATE_TOKEN = /(?:^|\D)(\d{4}-\d{2}-\d{2})(?!\d)/g;
function factTokens(text) {
  const s = String(text ?? "");
  const versions = /* @__PURE__ */ new Set();
  const dates = /* @__PURE__ */ new Set();
  let m;
  VERSION_TOKEN.lastIndex = 0;
  while (m = VERSION_TOKEN.exec(s)) versions.add(m[1]);
  DATE_TOKEN.lastIndex = 0;
  while (m = DATE_TOKEN.exec(s)) dates.add(m[1]);
  return { versions, dates };
}
function tokenDiff(a, b) {
  const only = (x, y) => [...x].filter((v) => !y.has(v));
  const mineV = only(a.versions, b.versions);
  const mineD = only(a.dates, b.dates);
  const theirsV = only(b.versions, a.versions);
  const theirsD = only(b.dates, a.dates);
  if (mineV.length > 0 && theirsV.length > 0) return { kind: "\u7248\u672C", mine: mineV, theirs: theirsV };
  if (mineD.length > 0 && theirsD.length > 0) return { kind: "\u65E5\u671F", mine: mineD, theirs: theirsD };
  return null;
}
function conflictCandidates(rows, content, project, limit = CONFLICT_MAX) {
  const mine = factTokens(content);
  const proj = typeof project === "string" ? project.trim() : "";
  const out = [];
  for (const r of rows) {
    const rowProj = typeof r.project === "string" ? r.project.trim() : "";
    if (proj.length > 0 && rowProj.length > 0 && rowProj !== proj) continue;
    const sim = similarity(r.content, content);
    if (sim < CONFLICT_SIM) continue;
    const d = tokenDiff(mine, factTokens(r.content));
    if (!d) continue;
    out.push({ id: r.id, level: r.level, sim: Math.round(sim * 1e3) / 1e3, kind: d.kind, mine: d.mine, theirs: d.theirs });
  }
  out.sort((a, b) => b.sim - a.sim);
  return out.slice(0, limit);
}
function conflictWarn(list, db, mode) {
  if (!Array.isArray(list) || list.length === 0) return "";
  const kindOf = (k) => k === "\u7248\u672c" ? safeKeyed("conflict.kindVersion", "\u7248\u672c") : k === "\u65e5\u671f" ? safeKeyed("conflict.kindDate", "\u65e5\u671f") : String(k ?? "");
  const sep = safeKeyed("conflict.join", "\uff1b");
  const items = list.map((c) => {
    let short = String(c.id ?? "").slice(0, 8);
    try {
      if (db !== void 0) short = uniqueShortId(db, c.level, c.id);
    } catch {
    }
    return safeKeyed("conflict.item", "{level} {id}\uff08{kind}\uff1a\u5b83\u5199 {theirs}\uff0c\u4f60\u8fd9\u6b21\u5199 {mine}\uff09", {
      level: c.level, id: short, kind: kindOf(c.kind), theirs: (c.theirs ?? []).join("/"), mine: (c.mine ?? []).join("/")
    });
  });
  // mode="update" 说「改动落库了」，mode 缺省说「这条写下了」——同一件事在两条路上说法不同。
  if (mode === "update") {
    return safeKeyed("conflict.headUpdate", "⚠️ 改完之后，库里还有同一件事的另一种说法：{items}。这条改动照样落库了——可两个版本并排睡着，下次检索分不清该信哪个：若那些条目已被这次的信息取代，就把它们 status 设 stale（不删、可反悔；要重写时也可以用 supersedes 一次做完），别让两个版本并排睡；若是不同对象，忽略这条。", { items: items.join(sep) });
  }
  return safeKeyed("conflict.head", "\u26a0\ufe0f \u5e93\u91cc\u5df2\u6709\u540c\u4e00\u4ef6\u4e8b\u7684\u53e6\u4e00\u79cd\u8bf4\u6cd5\uff1a{items}\u3002\u8fd9\u6761\u7167\u6837\u5199\u4e0b\u4e86\u2014\u2014\u4f46\u5982\u679c\u5b83\u5df2\u88ab\u8fd9\u6b21\u7684\u4fe1\u606f\u53d6\u4ee3\uff0c\u6b63\u786e\u505a\u6cd5\u662f\u7ed9\u5b83\u4eec\u4f20 supersedes\uff08\u6216 memory_update \u628a status \u8bbe stale\uff0c\u4e0d\u5220\u3001\u53ef\u53cd\u6094\uff09\uff0c\u522b\u8ba9\u4e24\u4e2a\u7248\u672c\u5e76\u6392\u8eba\u5728\u5e93\u91cc\uff1b\u82e5\u8bf4\u7684\u662f\u4e0d\u540c\u5bf9\u8c61\uff0c\u5ffd\u7565\u8fd9\u6761\u63d0\u9192\u3002", { items: items.join(sep) });
}

// [macro-fusion 0.2.141] 折叠以前是「谁分高留谁」：同组里第一条不动，后面一律折掉。可「分高」
// 说的是措辞贴不贴，不是「这条还用不用」——一条已退位的旧说法只要写得更像提问，就能把接手它的
// 新说法折掉，回执只留一句「多半是同一句既存了 fact 又存了 lesson」。这是**把新的折了、把旧的留下**，
// 而且一声不响。现在同组里按「在用优先 → 较新优先 → 分高优先」挑一条留下，被折的逐条点名。
function foldRank(h, byId) {
  const row = byId ? byId.get(h.id) : null;
  return {
    st: statusWeight(row?.status ?? h.status),
    at: Number(row?.updated_at ?? h.updated_at ?? 0) || 0,
    sc: Number(h.score ?? 0) || 0
  };
}
function pickKeeper(members, byId) {
  return members.slice().sort((a, b) => {
    const ra = foldRank(a, byId);
    const rb = foldRank(b, byId);
    if (ra.st !== rb.st) return rb.st - ra.st;
    if (ra.at !== rb.at) return rb.at - ra.at;
    return rb.sc - ra.sc;
  })[0];
}
function foldNearDupes(hits, byId) {
  const groups = [];
  for (const h of hits) {
    const g = groups.find((one) => similarity(one.head.content ?? "", h.content ?? "") >= DEDUP_THRESHOLD);
    if (g) g.members.push(h);
    else groups.push({ head: h, members: [h] });
  }
  const keptIds = /* @__PURE__ */ new Set();
  const dropped = [];
  for (const g of groups) {
    const keep = pickKeeper(g.members, byId);
    keptIds.add(String(keep.id));
    for (const m of g.members) {
      if (String(m.id) === String(keep.id)) continue;
      dropped.push({ id: String(m.id), keep: String(keep.id), newer: foldRank(m, byId).at > foldRank(keep, byId).at });
    }
  }
  const kept = hits.filter((h) => keptIds.has(String(h.id)));
  return { kept, folded: dropped.length, dropped };
}
// [macro-fusion 0.2.87] 「合并」以前是「用这次的参数把旧条目整条覆盖一遍」：关键词被整个换掉
// （旧的一条不剩，检索就漏）、归属被搬到另一个项目（回执不提）、更短的新内容把旧细节吃掉
// （实测 78 字 → 67 字，尾句「也不许只备份配置文件」直接消失）。三处坏起来都一声不响。
// 现在合并只做加法：关键词取并集、归属冲突不动、内容变短且非逐字默认不换（overwrite: true 才换），
// 回执逐项说清「并了什么、换了什么、为什么没换」。
// 这段故意放在工具字面量外面：probe-toolsize 按源码切片量字面量体积，说明书式的长句不该算进膨胀。
function applyMerge(db, level, merged, asked) {
  const kwOld = Array.isArray(merged.keywords) ? merged.keywords : [];
  const kwUnion = [];
  for (const k of [...kwOld, ...asked.keywords]) {
    const v = String(k ?? "").trim();
    if (v.length > 0 && !kwUnion.includes(v)) kwUnion.push(v);
  }
  const kwAdded = kwUnion.filter((k) => !kwOld.includes(k));
  const impOld = Number(merged.importance) || 1;
  const impNext = Math.max(impOld, asked.importance);
  const oldContent = String(merged.content ?? "");
  const projOld = typeof merged.project === "string" && merged.project.trim() ? merged.project.trim() : "";
  const projKept = projOld.length > 0 && asked.project !== projOld;
  const sim = similarity(oldContent, asked.content);
  const shrink = asked.content.length < oldContent.length && sim < 0.98;
  const holdContent = shrink && !asked.overwrite;
  const patch = { importance: impNext, keywords: kwUnion };
  if (!holdContent) patch.content = asked.content;
  if (!projKept && asked.project) patch.project = asked.project;
  if (asked.subcategory && level === "project") patch.subcategory = asked.subcategory;
  if (asked.goal && level === "topic") patch.goal = asked.goal;
  if (level === "lesson" && asked.corrected) patch.corrected = 1;
  db.update(level, merged.id, patch);
  const parts = [];
  parts.push(kwAdded.length > 0
    ? `关键词并进了 ${kwAdded.length} 条（${kwAdded.join(" / ")}），现在共 ${kwUnion.length} 条，旧的一条没删`
    : `关键词还是 ${kwUnion.length} 条（这次给的都在里面了）`);
  parts.push(impNext !== impOld ? `importance 从 ${impOld} 提到 ${impNext}（取较大值）` : `importance 保持 ${impOld}`);
  if (holdContent) {
    parts.push(`内容没换：旧 ${oldContent.length} 字、这次 ${asked.content.length} 字，不是逐字同一句，直接替换会把旧细节吃掉；确实要换成短的，传 overwrite: true`);
  } else if (sim >= 0.98) {
    parts.push(`内容按这次给的存（与旧条目 ${oldContent.length} 字基本逐字相同）`);
  } else {
    parts.push(`内容已替换（${oldContent.length} 字 → ${asked.content.length} 字，重复度 ${Math.round(sim * 100)}%）`);
  }
  if (projKept) {
    parts.push(`归属没改：这条原属「${projOld}」，这次给的是「${asked.project}」——合并不会搬走归属，要换归属请先归档再重写`);
  }
  return `这条并进了已有条目 ${merged.id.slice(0, 8)}（内容重复度 ≥${Math.round(DEDUP_THRESHOLD * 100)}%）：${parts.join("；")}。这是「合并」，不是「新写一条」。`;
}
function rememberTool(dir) {
  return {
    name: "memory_remember",
    description: T("memory_remember.description"),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["content", "project", "keywords", "importance"],
      properties: {
        content: { type: "string", description: T("memory_remember.param.content") },
        level: {
          type: "string",
          enum: [...LEVELS],
          default: "fact",
          description: T("memory_remember.param.level")
        },
        project: { type: "string", description: T("memory_remember.param.project") },
        subcategory: { type: "string", enum: [...PROJECT_SUBCATEGORIES], description: T("memory_remember.param.subcategory") },
        goal: { type: "string", description: T("memory_remember.param.goal") },
        importance: { type: "integer", default: 1, description: T("memory_remember.param.importance") },
        corrected: { type: "boolean", default: false, description: T("memory_remember.param.corrected") },
        keywords: { type: "array", items: { type: "string" }, description: T("memory_remember.param.keywords") },
        overwrite: { type: "boolean", default: false, description: T("memory_remember.param.overwrite") }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: {
          ok: { type: "boolean" },
          id: { type: "string" },
          level: { type: "string" },
          merged: { type: "boolean" },
          keywords: { type: "array", items: { type: "string" }, description: T("memory_remember.out.keywords") },
          project: { type: "string", description: T("memory_remember.out.project") },
          dropped: { type: "array", items: { type: "string" } },
          note: { type: "string" }
        }
      },
      render: (_args, value) => {
        const v = value;
        const kw = Array.isArray(v.keywords) && v.keywords.length > 0 ? `关键词：${v.keywords.join(" / ")}。` : "";
        const proj = typeof v.project === "string" ? `项目：${v.project}。` : "";
        const head = v.merged ? "✅ 已合并到已有条目" : "✅ 记忆已写入";
        const base = `${head}（${String(v.level ?? "fact")}${typeof v.id === "string" ? `，id=${v.id.slice(0, 8)}` : ""}）。`;
        const note = typeof v.note === "string" && v.note.trim() ? v.note.trim() : "";
        if (note.length === 0) {
          return [{ type: "text", text: `${base}${proj}${kw}无需重复调用本工具。` }];
        }
        return [{ type: "text", text: `${base}\n${note}\n${proj}${kw}`.trimEnd() }];
      }
    },
    async execute(args, exec) {
      refuseOrThrow("write", exec);
      const parsed = args;
      const content = typeof parsed.content === "string" ? parsed.content.trim() : "";
      if (content.length === 0) throw new Error(L("remember.error.content"));
      const project = typeof parsed.project === "string" && parsed.project.trim() ? parsed.project.trim() : null;
      if (project === null) throw new Error(L("remember.error.project", { global: globalProjectMarker() }));
      const keywords = normalizeKeywords(parsed.keywords);
      if (keywords.length === 0) {
        const missing = parsed.keywords === void 0 || parsed.keywords === null || typeof parsed.keywords === "string" && parsed.keywords.trim() === "" || Array.isArray(parsed.keywords) && parsed.keywords.length === 0;
        throw new Error(missing ? L("remember.error.keywords") : L("remember.error.keywordsEmpty", { received: describeArg(parsed.keywords) }));
      }
      const importanceRaw = coerceNumber(parsed.importance);
      if (importanceRaw === void 0) throw new Error(L("remember.error.importance"));
      // [macro-fusion 0.2.50] 七个参数原来被过滤得一声不响：层名写错直接落进 fact，
      // subcategory / goal / corrected 给错层就丢，importance 小数被四舍五入。回执只说「✅ 记忆已写入（fact…）」，
      // 读起来像「按你说的写好了」，真实是「按我改过的写法写好了」。
      const levelAsked = typeof parsed.level === "string" ? parsed.level.trim() : "";
      const levelBad = levelAsked.length > 0 && !LEVELS.includes(levelAsked);
      const level = LEVELS.includes(levelAsked) ? levelAsked : "fact";
      const importance = Math.round(importanceRaw);
      const subcategoryAsked = typeof parsed.subcategory === "string" ? parsed.subcategory.trim() : "";
      const subcategory = level === "project" && PROJECT_SUBCATEGORIES.includes(subcategoryAsked) ? subcategoryAsked : null;
      const goal = typeof parsed.goal === "string" && parsed.goal.trim() ? parsed.goal.trim() : null;
      const corrected = coerceBoolean(parsed.corrected) ? 1 : 0;
      const overwrite = coerceBoolean(parsed.overwrite);
      const dropped = [];
      if (levelBad) {
        dropped.push(`level（「${levelAsked}」不在七层里——${LEVELS.join(" / ")}）`);
      }
      if (subcategoryAsked.length > 0 && level !== "project") {
        dropped.push(`subcategory（只有 project 层有子类，这条是 ${level}）`);
      } else if (subcategoryAsked.length > 0 && level === "project" && subcategory === null) {
        dropped.push(`subcategory（「${subcategoryAsked}」不在六类里——${PROJECT_SUBCATEGORIES.join(" / ")}）`);
      }
      if (goal !== null && level !== "topic") {
        dropped.push(`goal（只有 topic 层有目标句，这条是 ${level}）`);
      }
      if (corrected === 1 && level !== "lesson") {
        dropped.push(`corrected（只有 lesson 层记「被纠正」，这条是 ${level}）`);
      }
      if (!Number.isInteger(importanceRaw)) {
        dropped.push(`importance（${describeArg(parsed.importance)} 不是整数，按 ${importance} 写进去了）`);
      }
      const levelNote = levelBad
        ? `写成 ${level} 了：你给的层名「${levelAsked}」不在七层里（${LEVELS.join(" / ")}），这条记忆被记进了 ${level}——这不是「按你说的层写好了」。要放进正确的层，得在那一层重新 remember 一次，再把这条归档（memory_update 不改层）。`
        : "";
      const droppedNote = dropped.length === 0
        ? ""
        : `这几个参数没生效：${dropped.join("；")}。`
      const noteOf = (extra) => [levelNote, droppedNote, extra].filter((s) => s.length > 0).join("\n")
      const workspace = workspaceOf(exec);
      if (!workspace) throw new Error("memory_remember: \u65E0\u6CD5\u786E\u5B9A\u5DE5\u4F5C\u533A\uFF08\u4F1A\u8BDD\u65E0 cwd\uFF09\u2014\u2014\u8BB0\u5FC6\u5DE5\u5177\u9700\u5728\u6709\u5DE5\u4F5C\u533A cwd \u7684\u4F1A\u8BDD\u5185\u8C03\u7528\uFF0C\u5916\u90E8/\u65E0\u4F1A\u8BDD\u8C03\u7528\u94FE\u4E0D\u53D7\u652F\u6301\uFF08#94\uFF09");
      const db = getDb(workspace, dir);
      const source_session = sessionIdOf(exec);
      if (project && !isGlobalProject(project) && !project.includes(",")) setCurrentProject(workspace, source_session ?? "unknown", project, dir);
      const existing = db.list(level, { status: "active" });
      let merged;
      for (const r of existing) {
        if (similarity(r.content, content) >= DEDUP_THRESHOLD) {
          merged = r;
          break;
        }
      }
      if (merged) {
        const mergeNote = applyMerge(db, level, merged, { content, project, subcategory, goal, corrected, importance, keywords, overwrite });
        markWritten(workspace, source_session ?? "unknown", [merged.id], dir);
        const after = db.findById(merged.id)?.row;
        return {
          ok: true,
          id: merged.id,
          level,
          merged: true,
          keywords: after?.keywords ?? merged.keywords,
          ...after?.project ? { project: after.project } : {},
          dropped,
          note: noteOf(mergeNote)
        };
      }
      const row = db.insert({
        level,
        content,
        project,
        subcategory,
        goal,
        importance,
        corrected,
        keywords,
        source_session
      });
      markWritten(workspace, source_session ?? "unknown", [row.id], dir);
      const crossNote = crossLevelNote(crossLevelDupe(db, level, content), db);
      const conflictNote = conflictWarn(conflictCandidates(existing, content, project), db);
      return {
        ok: true,
        id: row.id,
        level,
        merged: false,
        keywords: row.keywords,
        ...row.project ? { project: row.project } : {},
        dropped,
        note: noteOf([crossNote, conflictNote].filter((s) => s.length > 0).join("\n"))
      };
    },
    presentCall(args) {
      const parsed = args;
      const preview = typeof parsed.content === "string" ? parsed.content.slice(0, 40) : "";
      return { card: "generic", title: `memory_remember: ${preview}`, kind: "write" };
    }
  };
}
// [macro-fusion 0.2.85] 本工厂里改了两处，都跟「排得对」有关，注释统一放这里：
//   ① 渲染顺序：原来 `sort((a, b) => (a.updated_at ?? 0) - (b.updated_at ?? 0))` 按创建时间升序，
//      把 search() 顶着算出来的相关度整个丢掉——模型读到的第一条永远是最旧那条。旁边 BASE_NOTE
//      的「如果冲突，以最新的为准」说的是内容取舍，被这一行实现成了排序。现在改成相关度降序为主，
//      updated_at 只做平手时的次级。
//   ② 可解释：explain 里补上 importanceWeight（打分侧在 search() 里加），三个因子 bm25 ×
//      recencyWeight × importanceWeight 缺一个，读者就没法判断「它为什么排前面」。
// 注释刻意放在字面量外面：tools/probe-toolsize.mjs 是按源码切片量工具字面量的，注释不该算进「膨胀」。
// [macro-fusion 0.2.86] 相关度下限 min_rel（0.2.168 起默认 0.30，原来是 0.35）：
// 实测 30 条语料下，查询「数据库连接池 上限」返回 5 条，第 3 条起分数只有榜首的 33%/33%/31%
// （内容是「数据库备份每天凌晨三点」这种只沾到「数据库」一个词的条目）。这类尾巴有三个代价：
// 模型要读、要用 k 个名额、还会把「沾边」误当「相关」。这里按「分数 < 榜首 × min_rel」收掉，
// 至少留 1 条（榜首永远在），并在回执里报出被收掉的条数与最高分——收窄要可追溯，
// 不是悄悄少给几条（0.2.85 刚把「排得对」修好，这里补的是「排得对之后别把尾巴也端出来」）。
// 参数 min_rel=0 可以关掉，用于「我要看全量」的场合。
// [macro-fusion 0.2.121] 检索回执补两样东西，都是「模型能不能自答」的问题：
//   ① 正文：原来 render 只印 `关于：关键词`，正文一个字不给——检索排在前面却读不到内容，
//      每条命中都得再 memory_read 一次，一次检索变成 k+1 次往返，还读不出「这 k 条讲了什么」。
//      content_max（默认 300）本来就在 execute 里截好了，只是没人打印；这里把截好的印出来，
//      原文更长时标一句「已截断」，指向 memory_read 取全文（截断要可追溯，不是悄悄少给）。
//   ② 日期：keywords 里带 `YYYY-MM-DD`（写入端/评测侧都这么塞日期）就在抬头补一天，因为
//      relativeTime 只在 30 天前才落到绝对日期，「5 分钟前」回答不了「那天是几号」。
//   ③ [0.2.128] 命中自己那行精确到分（stampWhen），邻居行仍只到天。依据是 1,193 题同题对照
//      （omni10）：把会话时间归一成 `2023-05-08 13:56` 之后整体 41.2% → 44.3%、时间题
//      18.1% → 27.4%（+3.1pt，p<0.0001）；而把时间铺到每一行反而 40.4%（多花 334 字符）——
//      读者要的是「能不能比大小」，不是「每一行都有时间」。所以只加一次，加在最该看的那行。
// 三样都只在回执层面加，不改排序、不改分数。
var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function dayOfKeywords(keywords) {
  if (!Array.isArray(keywords)) return "";
  for (const kw of keywords) {
    if (typeof kw === "string" && DAY_RE.test(kw.trim())) return kw.trim();
  }
  return "";
}
/** 写入时间 → 本机日期 YYYY-MM-DD。关键词里没有日期时兜底：
 *  相对时间（「5 分钟前」「2 年前」）回答不了「那天是几号」。 */
function stampDay(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "";
  const p = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 把回执里的 day（`YYYY-MM-DD` 或 `YYYY-MM-DD HH:MM`）解析成毫秒；认不出回 NaN。
 *  时间轴只按这个数排序，不猜、不补。 */
function stampMs(day) {
  const m = String(day ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), 0, 0).getTime();
}
/** 同上，但精确到分：写入时间本身带时刻时给 `YYYY-MM-DD HH:MM`，整点 00:00 只给日期。
 *  为什么只给命中行：0.2.128 的 1,193 题对照里，时间只出现在命中自己那行是 44.3%，
 *  铺到每一行是 40.4%——多出来的字没换来分，反而把正文挤走。 */
function stampWhen(ms) {
  const day = stampDay(ms);
  if (!day) return "";
  const d = new Date(Number(ms));
  const p = (v) => String(v).padStart(2, "0");
  const hh = d.getHours();
  const mm = d.getMinutes();
  if (hh === 0 && mm === 0) return day;
  return `${day} ${p(hh)}:${p(mm)}`;
}
/** [0.2.129] 时间轴：只在问句本身问时间、且至少三条命中带时刻时才给一行。
 *  为什么必须带序号：omni14 拿「正文前十个字」当锚只有 43.9%（对不含时间轴的 43.1%，p=0.23 不显著），
 *  带 `[k]` 那版 46.5%——这条线的价值就在「[3] 比 [1] 早」这一眼可比，所以命中抬头也带 [k]。
 *  闸门（问句含时间词 + 命中 ≥3）来自 omni13：一律印 46.2%、只在问句问时间时印 46.5%，
 *  而且一律印会把单跳查事实的题拖低（cat4 71.5%→70.9%）。 */
function timelineLine(hits, query) {
  const q = typeof query === "string" ? query : "";
  if (!TIMELINE_CUE.test(q) || !Array.isArray(hits) || hits.length < 3) return "";
  const timed = hits
    .map((h, i) => ({ i, day: String(h.day ?? ""), ms: stampMs(h.day) }))
    .filter((x) => x.day.length > 0 && Number.isFinite(x.ms));
  if (timed.length < 3) return "";
  const order = timed.sort((a, b) => a.ms - b.ms || a.i - b.i);
  const shown = order.slice(0, TIMELINE_MAX);
  const more = order.length > shown.length ? ` \u00B7 \u2026\u53E6\u6709 ${String(order.length - shown.length)} \u6761` : "";
  return `\u65F6\u95F4\u8F74\uFF08\u4ECE\u65E9\u5230\u665A\uFF09\uFF1A${shown.map((x) => `[${String(x.i + 1)}] ${x.day}`).join(" \u00B7 ")}${more}`;
}
function searchTool(dir) {
  return {
    name: "memory_search",
    description: T("memory_search.description"),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: T("memory_search.param.query") },
        level: { type: "string", description: T("memory_search.param.level") },
        project: { type: "string", description: T("memory_search.param.project") },
        status: { type: "string", description: T("memory_search.param.status") },
        days: { type: "integer", minimum: 1, maximum: 3650, description: T("memory_search.param.days") },
        k: { type: "integer", minimum: 1, maximum: 50, default: 10, description: T("memory_search.param.k") },
        content_max: { type: "integer", minimum: 0, maximum: 5e3, default: 300, description: T("memory_search.param.content_max") },
        context: { type: "integer", minimum: 0, maximum: 3, default: 0, description: T("memory_search.param.context") },
        min_rel: { type: "number", minimum: 0, maximum: 1, default: 0.3, description: T("memory_search.param.min_rel") },
        dedupe: { type: "boolean", default: true, description: T("memory_search.param.dedupe") },
        explain: { type: "boolean", default: false, description: T("memory_search.param.explain") },
        band_keep: {
          type: "boolean",
          default: true,
          description: "\u9ed8\u8ba4\u53ea\u7ed9\u548c\u699c\u9996\u540c\u4e00\u91cf\u7ea7\u7684\u547d\u4e2d\uff08\u5206\u6570\u4e0d\u5230\u699c\u9996 85% \u7684\u6574\u6279\u6536\u53e3\uff09\uff1b\u4f20 false = \u8fde\u4f4e\u5206\u5019\u9009\u4e00\u5e76\u5c55\u5f00\u3002"
        },
        internal: {
          type: "boolean",
          default: false,
          description: "只给插件内部诊断用（例如写完一条记忆后检查是否该巩固）：这次查询不进本会话的「已端给你看过」账，也不计召回次数。模型不该传它。"
        }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["note", "hits"],
        properties: {
          note: { type: "string", description: T("memory_search.out.note") },
          timeline: { type: "string", description: T("memory_search.out.timeline") },
          hits: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "level"],
              properties: {
                id: { type: "string", description: T("memory_search.out.hits.id") },
                level: { type: "string" },
                title: { type: "string" },
                content: { type: "string" },
                truncated: { type: "boolean", description: T("memory_search.out.hits.truncated") },
                day: { type: "string", description: T("memory_search.out.hits.day") },
                context: { type: "object", description: T("memory_search.out.hits.context") },
                keywords: { type: "array", items: { type: "string" }, description: T("memory_search.out.hits.keywords") },
                project: { type: "string", description: T("memory_search.out.hits.project") },
                score: { type: "number" },
                updated_at: { type: "number", description: T("memory_search.out.hits.updated_at") },
                explain: {
                  type: "object",
                  additionalProperties: false,
                  required: ["bm25", "importance", "recencyWeight", "status"],
                  properties: {
                    bm25: { type: "number", description: T("memory_search.out.hits.explain") },
                    importance: { type: "number" },
                    recencyWeight: { type: "number" },
                    status: { type: "string" }
                  }
                }
              }
            }
          }
        }
      },
      render: (_args, value) => {
        const v = value;
        const lines = [String(v.note ?? "")];
        const cm = _args?.content_max ?? 300;
        const hits = v.hits ?? [];
        // [0.2.126] 命中挨在一起时，上一条的 ↓ 就是下一条的正文，再印一遍纯属重复花 token。
        //  命中一定会在自己的表头下面印出来，所以邻居里凡是命中体、或本轮已经印过的行，一律不印。
        const printed = new Set(hits.map((h) => `${String(h.level ?? "")}:${String(h.id ?? "")}`));

        const ctxDeep = !TIMELINE_CUE.test(String(_args?.query ?? ""));
        const ctxMax = ctxDeep ? CTX_LINES_DEEP : CTX_LINES;
        let ctxUsed = 0;
        let ctxChars = 0;
        let ctxSkipped = 0;
        const ctxLine = (arrow, it) => {
          const key = `${String(it?.level ?? "")}:${String(it?.id ?? "")}`;
          if (key !== ":" && printed.has(key)) return null;
          const text = `  ${arrow} ${it?.day ? String(it.day) + " " : ""}${String(it?.content ?? "")}`;
          if (ctxUsed >= ctxMax || (ctxDeep && ctxChars + text.length > CTX_CHARS_DEEP)) {
            ctxSkipped++;
            return null;
          }
          printed.add(key);
          ctxUsed++;
          ctxChars += text.length;
          return text;
        };
        // [0.2.129] 时间轴本身在模块级 timelineLine 里（不塞进 render 字面量）
        const tl = timelineLine(hits, _args?.query);
        if (tl) lines.push(tl);
        hits.forEach((h, hi) => {
          const kw = (Array.isArray(h.keywords) ? h.keywords : []).filter((x) => typeof x === "string" && x.length > 0);
          const about = kw.length > 0 ? kw.join(", ") : `${String(h.content ?? "").slice(0, 40)}\u2026`;
          const proj = `${projectLabel(h.project)} : ${String(h.level ?? "")}`;
          const rel = relativeTime(h.updated_at ?? null);
          const day = h.day ? ` \u00B7 ${h.day}` : "";
          lines.push(`[${String(hi + 1)}] [${proj}] [${String(h.id ?? "")}] [${rel}${day}] \u5173\u4E8E\uFF1A${about}`);
          const ctx = h.context ?? null;
          if (ctx !== null) for (const it of ctx.before ?? []) {
            const ln = ctxLine("\u2191", it);
            if (ln !== null) lines.push(ln);
          }
          const body = String(h.content ?? "");
          if (body.length > 0) lines.push(`  ${body}${h.truncated === true ? `\uFF08\u5DF2\u622A\u65AD\u5230 ${cm} \u5B57\uFF0C\u5168\u6587\u7528 memory_read\uFF09` : ""}`);
          if (ctx !== null) for (const it of ctx.after ?? []) {
            const ln = ctxLine("\u2193", it);
            if (ln !== null) lines.push(ln);
          }
          const ex = h.explain;
          if (ex !== void 0) {
            lines.push(`  bm25=${String(ex.bm25 ?? 0)} importance=${String(ex.importance ?? 0)} recencyWeight=${String(ex.recencyWeight ?? 1)} status=${String(ex.status ?? "active")} score=${String(h.score ?? 0)}`);
          }
        });
        if (ctxSkipped > 0)
          lines.push(`  \u2026\u90BB\u5C45\u8FD8\u6709 ${String(ctxSkipped)} \u884C\u6CA1\u94FA\u5F00\uFF08\u4E00\u6B21\u6700\u591A ${String(ctxMax)} \u884C\uFF1B\u8BA4\u51C6\u54EA\u6761\u5C31\u7528 memory_read \u8BFB\u5168\u6587\uFF09`);
        return lines.map((t) => ({ type: "text", text: t }));
      }
    },
    async execute(args, exec) {
      refuseOrThrow("read", exec);
      const parsed = args;
      const explain = parsed.explain === true;
      const query = typeof parsed.query === "string" ? parsed.query.trim() : "";
      if (!query) throw new Error('memory_search: query \u5FC5\u586B\u4E14\u4E0D\u80FD\u4E3A\u7A7A\uFF08\u4F8B\uFF1A{"query": "\u5173\u952E\u8BCD"}\uFF09\uFF1B\u6D4F\u89C8\u9879\u76EE\u5168\u8C8C\u8BF7\u7528 memory_project');
      const workspace = workspaceOf(exec);
      if (!workspace) throw new Error("memory_search: \u65E0\u6CD5\u786E\u5B9A\u5DE5\u4F5C\u533A\uFF08\u4F1A\u8BDD\u65E0 cwd\uFF09\u2014\u2014\u8BB0\u5FC6\u5DE5\u5177\u9700\u5728\u6709\u5DE5\u4F5C\u533A cwd \u7684\u4F1A\u8BDD\u5185\u8C03\u7528\uFF0C\u5916\u90E8/\u65E0\u4F1A\u8BDD\u8C03\u7528\u94FE\u4E0D\u53D7\u652F\u6301\uFF08#94\uFF09");
      const db = getDb(workspace, dir);
      const sessionId = sessionIdOf(exec);
      const seen = readSeen(workspace, sessionId ?? "unknown", dir);
      const projectList3 = typeof parsed.project === "string" && parsed.project.trim() ? parsed.project.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : [];
      const project = projectList3.length > 0 ? projectList3 : null;
      if (projectList3.length === 1 && !isGlobalProject(projectList3[0])) setCurrentProject(workspace, sessionId ?? "unknown", projectList3[0], dir);
      // [macro-fusion 0.2.56] 参数给错了会被静默吞掉：status 拼错 → 一行都查不到，回执却按「默认检索范围」
      // 去解释（读者以为记忆里没有）；days 给 0 / 负数 → 这个过滤直接消失，读者以为限了时段；
      // k / content_max 被夹到边界也一声不吭。这三种都不是「查了没有」，是「你给的条件没生效」。
      const STATUS_VALUES = ["active", "stale", "archived"];
      const statusAsked = typeof parsed.status === "string" && parsed.status.trim() ? parsed.status.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : [];
      const statusBad = statusAsked.filter((s) => s !== "all" && !STATUS_VALUES.includes(s));
      const statusList = statusAsked.filter((s) => s === "all" || STATUS_VALUES.includes(s));
      const statusDead = statusAsked.length > 0 && statusList.length === 0;
      const status = statusList.length > 0 ? statusList : null;
      const daysRaw = coerceNumber(parsed.days);
      const daysGiven = parsed.days !== void 0 && parsed.days !== null && String(parsed.days).trim().length > 0;
      const days = daysRaw !== void 0 && daysRaw > 0 ? daysRaw : null;
      const kRaw = coerceNumber(parsed.k);
      const kGiven = parsed.k !== void 0 && parsed.k !== null && String(parsed.k).trim().length > 0;
      const k = kRaw !== void 0 ? Math.max(1, Math.min(50, Math.round(kRaw))) : 10;
      const kClamped = kGiven && (kRaw === void 0 || kRaw < 1 || kRaw > 50);
      const cmRaw = coerceNumber(parsed.content_max);
      const cmGiven = parsed.content_max !== void 0 && parsed.content_max !== null && String(parsed.content_max).trim().length > 0;
      const contentMax = cmRaw !== void 0 ? Math.max(0, Math.min(5e3, Math.round(cmRaw))) : 300;
      const cmClamped = cmGiven && (cmRaw === void 0 || cmRaw < 0 || cmRaw > 5e3);
      // [macro-fusion 0.2.86] 相关度下限（详见 searchTool 上方说明）：只展开分数不低于榜首这个比例的条目。
      // [macro-fusion 0.2.168] 0.35 → 0.30：0.35 是在 30 条受控语料上定的，到了真库（545 条）它在难句上
      // 会砍掉正解——13 条换说法问句里 0.35 命中 9 条、0.30 命中 10 条，而回执只多 0.31 条（4.23 → 4.54）；
      // 自找池（150 题，问句就是关键词）两档都是 142 题，一题不伤。0.25 与 0.30 同分，取条数更少的 0.30。
      const relRaw = coerceNumber(parsed.min_rel);
      const relGiven = parsed.min_rel !== void 0 && parsed.min_rel !== null && String(parsed.min_rel).trim().length > 0;
      const minRel = relRaw !== void 0 ? Math.max(0, Math.min(1, relRaw)) : 0.3;
      const relClamped = relGiven && (relRaw === void 0 || relRaw < 0 || relRaw > 1);
      // [macro-fusion 0.2.51] 层名过滤原来是静默的：拼错 / 复数 / 一个都不认识 → 过滤后数组变空
      // → 零命中，回执只说「以最新的为准」，读者会把它读成「记忆里没有」。这里把「哪些层名没对上」留住。
      const levelAsked = typeof parsed.level === "string" && parsed.level.trim() ? parsed.level.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : [];
      const levelBad = levelAsked.filter((s) => !LEVELS.includes(s));
      const levelValid = levelAsked.filter((s) => LEVELS.includes(s));
      // [macro-fusion 0.2.168] 默认层补上 user：默认范围原来只有 fact/lesson/topic/rules，而 user 层
      // 存的正是「主人的偏好与设备环境」——真库 8 条 user 条目，在工具路径上 8 题全漏（API 层每题都是第 1 名，
      // 说明不是排序问题，是根本没进候选池）。补上之后自找池 142/150 → 150/150、首位 141 → 149，
      // 回执反而更短（2.18 → 2.01 条）：正解进榜把弱候选挤出了地板。
      // soul 与 project 仍不默认：soul 是 AI 自身人格（7 层里唯一「不该在被问事实时出现」的），
      // project 层放的是一整个项目的概览，实测掺进来会抢首位（换说池首位 5 → 4、top3 9 → 9）。
      const levels = levelValid.length > 0 ? levelValid : levelAsked.length === 0 ? ["fact", "lesson", "topic", "rules", "user"] : [];
      const levelNote = levelAsked.length > 0 && levelValid.length === 0 ? `这次一条都没查：你给的层名「${levelAsked.join("、")}」不在七层里（${LEVELS.join(" / ")}）。这不是「记忆里没有」，是层名没对上——换成真实层名再查一次。` : levelBad.length > 0 ? `这几个层名没生效：${levelBad.join("、")}（不在七层里）——这次只查了 ${levelValid.join(" / ")} 层。` : "";
      // [macro-fusion 0.2.56] 状态值 / 时段 / 条数 / 截断长度给错了，各说各的——别混进「本次零命中」里。
      const statusNote = statusDead
        ? `这次一条都没查：你给的状态值「${statusAsked.join("、")}」不在 ${STATUS_VALUES.join(" / ")} 里（要查全部状态写 all）。这不是「记忆里没有」，是状态值没对上——换成真实状态再查一次。`
        : statusBad.length > 0
          ? `这几个状态值没生效：${statusBad.join("、")}（不在 ${STATUS_VALUES.join(" / ")} 里）——这次只按 ${statusList.join(" / ")} 过滤。`
          : "";
      const daysNote = daysGiven && days === null ? `days 给的是「${String(parsed.days)}」，不是正数，这个「最近 N 天」的过滤没生效——等于查了全部时段。` : "";
      const kNote = kClamped ? `k 给的是「${String(parsed.k)}」，超出 1–50，这次按 ${k} 条处理。` : "";
      const cmNote = cmClamped ? `content_max 给的是「${String(parsed.content_max)}」，超出 0–5000，这次按 ${contentMax} 处理。` : "";
      const relClampNote = relClamped ? `min_rel 给的是「${String(parsed.min_rel)}」，不在 0–1 里，这次按 ${minRel} 处理。` : "";
      const rows = statusDead ? [] : levels.flatMap((lv) => {
        if (statusList.includes("all")) return db.list(lv);
        if (statusList.length === 1 && statusList[0] !== "active") return db.list(lv, { status: statusList[0] });
        if (statusList.length > 1) return db.list(lv);
        return db.listSearchable(lv);
      });
      const docFor = (r) => ({ id: r.id, level: r.level, title: r.title, content: r.content, keywords: r.keywords, importance: r.importance, created_at: r.created_at, updated_at: r.updated_at, last_accessed_at: r.last_accessed_at, status: r.status });
      // [macro-fusion 0.2.171] 历史可查：问句里点了名（版本号 / 路径 / 短 id / commit），这个名字
      // 只活在已过期的条目里 —— 那就把它翻出来，并标明已过期。只并「点了名的那几条」，
      // 所以 listSearchable 的口径一个字不动（主人拍板：其他类别过时不默认检索），
      // 放宽只发生在「用户点名要它」这一种问句上。
      // 挑哪几条不能再按库里的顺序取前两条（0.2.147 就是这样把正解挤到第 3）：先在过期子集里
      // 用同一套打分器排一遍，只取排在最前的 HIST_LIFT_MAX 条。
      const askIdents = statusDead || statusList.length > 0 || parsed.include_stale === false ? [] : identsOf(query);
      let histAdded = 0;
      const histIds = [];
      if (askIdents.length > 0) {
        const have = new Set(rows.map((r) => String(r.id)));
        const pool = [];
        for (const lv of levels) {
          let olds = [];
          try { olds = db.list(lv, { status: "stale" }); } catch { olds = []; }
          for (const r of olds) {
            const key = String(r.id);
            if (have.has(key)) continue;
            const hay = `${key} ${String(r.title ?? "")} ${String(r.content ?? "")} ${Array.isArray(r.keywords) ? r.keywords.join(" ") : ""} ${String(r.project ?? "")}`.toLowerCase();
            if (!askIdents.some((t) => hay.includes(t))) continue;
            pool.push(r);
            have.add(key);
          }
        }
        if (pool.length > 0) {
          const asked = await rankForSearch(query, pool.map(docFor), { k: HIST_LIFT_MAX, explain: false, bandKeep: true });
          for (const h of asked) {
            const r = pool.find((x) => String(x.id) === String(h.id));
            if (!r) continue;
            rows.push(r);
            histAdded += 1;
            histIds.push(String(r.id).slice(0, 8));
          }
        }
      }
      const filtered = filterSearchable(rows, { project, status, days });
      const byId = new Map(filtered.map((r) => [r.id, r]));
      const docs = filtered.map(docFor);
      // [macro-fusion 0.2.154] 稠密能上就上：模型 / 依赖缺一个立刻退回词法，
      // 答案与 0.2.153 逐位相同（这条由 probe-cost 的 C5 快照守着）。
      // [macro-fusion 0.2.167] band_keep：默认按置信档收口（0.2.165 的刀），
      // 但收了几条必须报得出来（见下面 bandNote），并且要有一个显式出口能关掉它。
      const bandKeep = parsed.band_keep !== false;
      const ranked = await rankForSearch(query, docs, { k: docs.length, explain, bandKeep });
      // [macro-fusion 0.2.155] 闸门在排序之后、裁剪之前：命中长得像，不等于问的是库里的事。
      const gate = await denseGate(query, docs, { k: docs.length, explain });
      if (gate.fired) ranked.length = 0;
      const topScore = ranked.length > 0 ? ranked[0].score : 0;
      const aboveFloor = minRel > 0 && topScore > 0 ? ranked.filter((h, i) => i === 0 || h.score >= topScore * minRel) : ranked;
      // [macro-fusion 0.2.143] 裁之前先问一句「被裁的是不是榜上某条的接手者」——是就提上来。
      const cutRows = ranked.slice(aboveFloor.length);
      const lifted = minRel > 0 ? liftSuccessors(aboveFloor, cutRows) : [];
      const floorKept = lifted.length === 0 ? aboveFloor : [...aboveFloor, ...lifted];
      const belowFloor = cutRows.length - lifted.length;
      const dedupeOn = parsed.dedupe !== false;
      const foldedRes = dedupeOn ? foldNearDupes(floorKept, byId) : { kept: floorKept, folded: 0, dropped: [] };
      const unique = foldedRes.kept;
      // [macro-fusion 0.2.141] 折了谁、留下的是谁，都要点名——否则「另一条更该信」这件事永远看不见。
      const foldKept = [...new Set((foldedRes.dropped ?? []).map((d) => String(d.keep).slice(0, 8)))].join("、");
      const foldDropped = (foldedRes.dropped ?? []).map((d) => String(d.id).slice(0, 8)).join("、");
      const dedupeNote = foldedRes.folded > 0
        ? safeKeyed("search.dedupeKept", "另有 {n} 条内容几乎一样（重复度 ≥{th}%）没重复列：留下的是 {kept}（按「在用 → 较新 → 分高」挑的），被折掉的是 {dropped}。要看全量传 dedupe: false。", {
          n: String(foldedRes.folded),
          th: String(Math.round(DEDUP_THRESHOLD * 100)),
          kept: foldKept,
          dropped: foldDropped
        })
        : "";
      // [macro-fusion 0.2.143] 提上来的要说出来：读者得知道「上面那条已退位，接它班的是这条」。
      const liftIds = lifted.map((h) => String(h.id).slice(0, 8)).join("\u3001");
      const liftNote = lifted.length === 0
        ? ""
        : safeKeyed("search.floorLift", "\u53e6\u6709 {n} \u6761\u76f8\u5173\u5ea6\u4f4e\u4e8e\u9996\u699c\u7684 {pct}%\uff0c\u4f46\u5b83\u4eec\u6b63\u662f\u699c\u4e0a\u67d0\u6761\u7684\u63a5\u624b\u6761\u76ee\uff08{ids}\uff09\uff0c\u8fd9\u6b21\u4e00\u5e76\u5c55\u5f00\u2014\u2014\u4e0a\u9762\u5199\u7740\u300c\u5df2\u88ab\u53d6\u4ee3\u300d\u7684\u90a3\u6761\u522b\u518d\u5f53\u7ed3\u8bba\u7528\u3002", {
          n: String(lifted.length),
          pct: String(Math.round(minRel * 100)),
          ids: liftIds
        });
      const relNote = belowFloor > 0
        ? `另有 ${belowFloor} 条相关度不到榜首的 ${Math.round(minRel * 100)}%（最高的 ${Math.round(ranked[aboveFloor.length].score * 100) / 100} 分，榜首 ${Math.round(topScore * 100) / 100} 分）没展开：它们多半只沾到一两个词，展开会挤掉真正相关的条目、也让回执变长。要看全量就传 min_rel=0。`
        : "";
      const blindCount = Math.min(5, k);
      const blind = unique.slice(0, blindCount);
      const fresh = [];
      for (const h of unique.slice(blindCount)) {
        if (fresh.length >= k - blindCount) break;
        if (seen.has(h.id)) continue;
        fresh.push(h);
      }
      const hits = [...blind, ...fresh];
      // [macro-fusion 0.4.0] internal=true：插件自己的诊断查询不算「这一轮端给用户看过」。
      // 不关的话，写完一条紧接着问 memory_search({mode:"similar", id})，候选会被这批记成已看过而排空，
      // 回执变成「可比的候选一条都没有」；同时 bumpHit 会抬 hit_count，让「召回过但没人读」这类通胀指标失真。
      // 默认 false = 对外查询照旧记账；只有 flow.tryCall 直连 bridge 才传得进来（macro 侧检索工具的参数是白名单）。
      if (parsed.internal !== true) {
        for (const h of hits) db.bumpHit(h.level, h.id);
        markSearched(workspace, sessionId ?? "unknown", hits.map((h) => h.id), dir);
      }
      const reordered = [...hits].sort((a, b) => (b.score - a.score) || ((b.updated_at ?? 0) - (a.updated_at ?? 0)));
      // [macro-fusion 0.2.123] context=N：给每条命中带上同层相邻的 N 条（默认 0，一个字节都不多花）
      const ctxSpan = Math.min(3, Math.max(0, Math.trunc(Number(parsed.context ?? 0)) || 0));
      const ctxMap = ctxSpan > 0 ? db.adjacentWindows(reordered.map((h) => ({ level: h.level, id: h.id })), ctxSpan) : null;
      const BASE_NOTE = "\u5982\u679C\u51B2\u7A81\uFF0C\u4EE5\u6700\u65B0\u7684\u4E3A\u51C6\u3002\u65F6\u95F4\u6233\u8F83\u65E7\u7684\u6761\u76EE\u53EF\u4F5C\u4E3A\u4E8B\u60C5\u53D1\u5C55\u8FC7\u7A0B\u7684\u53C2\u8003\u3002\u5982\u679C\u4F60\u786E\u5B9E\u9700\u8981\u66F4\u591A\u7EC6\u8282\uFF0C\u53EF\u4EE5\u76F4\u63A5\u53BB\u804A\u5929\u8BB0\u5F55\u91CC\u641C\u7D22\u76F8\u5173\u5173\u952E\u8BCD\u3002";
      const explicitLevels = typeof parsed.level === "string" && parsed.level.trim().length > 0;
      // [macro-fusion 0.2.51] 显式给了合法层却零命中，也是「只在某几层里查」——不说明就会被读成「库里没有」。
      const scopeNote = hits.length === 0 && levelValid.length > 0 ? `这次只在 ${levelValid.join(" / ")} 层里查了，零命中：别的层就算有同关键词也看不到——要全层查就去掉 level 参数（默认 fact / lesson / topic / rules）。` : "";
      const plain = hits.length === 0 && !explicitLevels && !statusDead && !gate.fired ? `${BASE_NOTE}\u672C\u6B21\u96F6\u547D\u4E2D\uFF1A\u9ED8\u8BA4\u68C0\u7D22\u8303\u56F4\u662F fact/lesson/topic/rules/user\uFF0Csoul \u4E0E project \u5C42\u4E0D\u53C2\u4E0E\u5173\u952E\u8BCD\u68C0\u7D22\uFF08\u8981\u67E5\u5B83\u4EEC\u8BF7\u663E\u5F0F\u4F20 level\uFF0C\u5982 {"level":"project"}\uFF09\uFF1B\u82E5\u8BB0\u5FC6\u5E93\u521A\u542F\u7528\uFF0C\u4E5F\u53EF\u80FD\u786E\u5B9E\u8FD8\u6CA1\u6709\u53EF\u68C0\u7D22\u7684\u8BB0\u5FC6\u3002` : BASE_NOTE;
      // [macro-fusion 0.2.140] 降权是藏在分数里的，读者看不见——那就把它说出来：
      // 有几条不是在用的、它们被降到多重、想只看在用的该加什么参数。没有这类命中时一个字符都不多花。
      const offNow = reordered.filter((h) => String(byId.get(h.id)?.status ?? "active") !== "active");
      const statusDownNote = offNow.length === 0
        ? ""
        : safeKeyed("search.statusDown", "这次命中有 {n} 条不是在用的（stale=已完结或被取代，archived=作废）：它们已按 {stale} / {arch} 降权排在后面，别当成现在的结论用；只要在用的就在参数里加 status:\"active\"。", { n: String(offNow.length), stale: String(STATUS_WEIGHT.stale), arch: String(STATUS_WEIGHT.archived) });
      // [macro-fusion 0.2.169] 语义补位要自己报名：那条分数 0.55 的条目长相就是噪声，
      // 不说是补进来的，读者第一反应是删掉它——而它常常是这次唯一答对的那一条。
      // 救援这条路径上「弱命中」「回执没给满」两句话说的都是同一件事，一律让位给它（见下）。
      const rescued = gate.fired ? 0 : Number(ranked.rescueAdded) || 0;
      const weakNote = gate.fired || rescued > 0 ? "" : weakNoteOf(ranked, { query });
      const gateNote = gate.fired
        ? `这次零命中不是「库里没有」，是这条问句跟记忆库不沾边：${gate.why}；最近的那条是 ${String(gate.nearest ?? '').slice(0, 8)}。真要硬看候选，就把这道闸关掉（环境里设 MEOW_DENSE_ABSTAIN=0），或者把门槛调低（MEOW_DENSE_ABSTAIN=0.3）。`
        : "";
      // [macro-fusion 0.2.167] 收口折掉的条数要报出来。0.2.165 那道刀一直在切，
      // 但切完一声不响：读者看到「只给了 5 条」，既不知道同档之外还有 17 条，
      // 也判断不出该不该要全量——这正是 rules 里「上限不许静默截断」那一条。
      // 闸门挡下来时 ranked 已被清空，那是「不沾边」不是「收口」，不能算在这笔账上。
      // [macro-fusion 0.2.167] 只报「回执短于你要的 k」这一种情况：候选池本身有多大
      // （这次内部排序拿了 {k: docs.length} 条全量）不该印给读者——那只说明库大，不说明少看了什么。
      // 回执已经给满 k 条时，收口对读者没有任何影响，一个字符都不花。
      const bandTrimmed = gate.fired ? 0 : Number(ranked.trimmed) || 0;
      const bandShort = bandTrimmed > 0 && hits.length < k;
      // [macro-fusion 0.2.169] 补了几条、词法尾部折了几条，由补位这一条 note 一次说清：
      // 那条分数 0.55 的条目长相就是噪声，不说是补进来的，读者第一反应是删掉它——
      // 而它常常是这次唯一答对的那一条。救援这条路径上「弱命中」「回执没给满」
      // 说的都是同一件事，都已经让位给它了（上面 weakNote、下面 bandNote）。
      const rescueTrimmed = gate.fired ? 0 : Number(ranked.rescueTrimmed) || 0;
      const rescueNote = rescued > 0
        ? safeKeyed("search.rescue", "\u8FD9\u6B21\u8BCD\u6CD5\u6CA1\u628A\u63E1\uFF08\u699C\u9996\u53EA\u8986\u76D6\u4E86\u8FD9\u6761\u95EE\u53E5\u7684 {pct}%\uFF09\uFF1A\u5DF2\u6309\u8BED\u4E49\u8865\u4E86 {n} \u6761\uFF08\u4F59\u5F26 \u2265 {cos}\uFF0C\u5206\u6570\u4E0E\u8BCD\u6CD5\u4E0D\u662F\u540C\u4E00\u5957\u91CF\u7EB2\uFF0C\u522B\u62FF\u5206\u6570\u8DDF\u699C\u9996\u6BD4\uFF09\uFF1B\u8BCD\u6CD5\u91CC\u6CA1\u628A\u63E1\u7684 {m} \u6761\u6CA1\u5C55\u5F00\uFF08\u5B83\u4EEC\u672C\u6765\u5C31\u6Cbe\u4E0D\u4E0A\u95EE\u53E5\uFF0C\u5C55\u5F00\u53EA\u4F1A\u628A\u56DE\u6267\u6491\u957F\uFF09\u3002\u8981\u5168\u91CF\u4F20 band_keep: false\u3002", { pct: String(Math.round((Number(ranked[0]?.cover) || 0) * 100)), n: String(rescued), cos: String(DENSE_RESCUE_COS), m: String(rescueTrimmed) })
        : "";
      const bandNote = bandShort && rescued === 0
        ? safeKeyed("search.bandTrim", "\u8fd9\u6b21\u56de\u4e86 {n} \u6761\uff0c\u6ca1\u5230\u4f60\u8981\u7684 {k} \u6761\uff1a\u548c\u699c\u9996\u4e0d\u662f\u4e00\u4e2a\u91cf\u7ea7\u7684\u5019\u9009\uff08\u5206\u6570\u4e0d\u5230 {pct}%\uff0c\u591a\u534a\u53ea\u6cbe\u4e00\u4e24\u4e2a\u8bcd\uff09\u6ca1\u5c55\u5f00\uff0c\u76f8\u5173\u5ea6\u5730\u677f\u4e0e\u53bb\u91cd\u4e5f\u4f1a\u6298\u6389\u4e00\u4e9b\u3002\u8981\u8fde\u4f4e\u5206\u5019\u9009\u4e00\u8d77\u770b\uff1a\u4f20 band_keep: false\uff08\u914d\u5408 min_rel: 0 \u624d\u662f\u771f\u5168\u91cf\uff09\u3002", { n: String(hits.length), k: String(k), pct: String(Math.round(IMP_BAND * 100)) })
        : "";
      // [macro-fusion 0.2.170] 剥离了哪些疑问框架，只有 explain 模式才说：默认回执一个字节都不花，
      // 但真要问「它凭什么排第一」时，读者得能看到「我改过你的问法」。
      const stripNote = explain && (hits[0]?.explain?.stripped?.length ?? 0) > 0
        ? safeKeyed("search.strip", "疑问框架按虚词处理了：{words}", { words: hits[0].explain.stripped.join("、") })
        : "";
      // [macro-fusion 0.2.171] 翻出来的历史要自己报名：不说是「过期的」，读者会把它当成现在的结论。
      const histNote = histAdded === 0
        ? ""
        : safeKeyed("search.histLift", "\u95EE\u53E5\u91CC\u7684 {what} \u53EA\u51FA\u73B0\u5728\u5DF2\u8FC7\u671F\u7684\u6761\u76EE\u91CC\uFF1A\u8FD9\u6B21\u987A\u5E26\u628A {n} \u6761\u7FFB\u4E86\u51FA\u6765\uFF08{ids}\uFF09\uFF0C\u5B83\u4EEC\u6B63\u662F\u90A3\u4E2A\u65F6\u671F\u7684\u8BB0\u5F55\u3001\u5DF2\u88AB\u540E\u7EED\u7248\u672C\u53D6\u4EE3\uFF0C\u522B\u5F53\u6210\u73B0\u5728\u7684\u7ED3\u8BBA\u7528\u3002\u8981\u901A\u770B\u5386\u53F2\u4F20 status:\"all\"\u3002", {
          what: askIdents.slice(0, 2).join("\u3001"),
          n: String(histAdded),
          ids: histIds.join("\u3001")
        });
      const note = [plain, gateNote, weakNote, levelNote, scopeNote, statusNote, daysNote, kNote, cmNote, relNote, rescueNote, bandNote, liftNote, histNote, relClampNote, dedupeNote, statusDownNote, stripNote].filter((s) => s.length > 0).join("\n");
      return {
        note,
        hits: reordered.map((h) => {
          const row = byId.get(h.id);
          return {
            id: h.id,
            level: h.level,
            title: h.title ?? "",
            content: contentMax > 0 ? h.content.slice(0, contentMax) : h.content,
            ...contentMax > 0 && h.content.length > contentMax ? { truncated: true } : {},
            day: dayOfKeywords(row?.keywords) || stampWhen(row?.updated_at),
            ...ctxMap !== null && ctxMap.has(String(h.id)) ? { context: ctxMap.get(String(h.id)) } : {},
            keywords: row?.keywords ?? [],
            project: row?.project ?? "",
            score: Math.round(h.score * 100) / 100,
            updated_at: h.updated_at ?? 0,
            // 可解释检索（#51）：explain=true 时附分项得分。状态过滤是检索前的二值
            // 过滤、不进打分——这里补 status 字段让分解完整。
            ...explain ? {
              explain: {
                bm25: h.explain?.bm25 ?? 0,
                importance: row?.importance ?? 0,
                importanceWeight: h.explain?.importanceWeight ?? 1,
                recencyWeight: h.explain?.recencyWeight ?? 1,
                statusWeight: h.explain?.statusWeight ?? statusWeight(row?.status),
                status: row?.status ?? "active"
              }
            } : {}
          };
        })
      };
    },
    presentCall(args) {
      const parsed = args;
      return { card: "generic", title: `memory_search: ${String(parsed.query ?? "").slice(0, 40)}`, kind: "read" };
    }
  };
}
function findSimilarTool(dir) {
  return {
    name: "memory_find_similar",
    description: T("memory_find_similar.description"),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", description: T("memory_find_similar.param.id") },
        k: { type: "integer", minimum: 1, maximum: 20, default: 5, description: T("memory_find_similar.param.k") },
        content_max: { type: "integer", minimum: 0, maximum: 5e3, default: 200, description: T("memory_find_similar.param.content_max") }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["hits"],
        properties: {
          // [macro-fusion 0.2.46] 空结果的解释（只在 hits 为空时有值）。加这一项是为了让
          // render 有字可说——原来 render 返回空数组，融合层只剩 {"hits": []}。
          note: { type: "string" },
          hits: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "level", "similarity"],
              properties: {
                id: { type: "string" },
                level: { type: "string" },
                title: { type: "string" },
                content: { type: "string" },
                similarity: { type: "number", description: T("memory_find_similar.out.hits.similarity") },
                repeat: { type: "number", description: T("memory_find_similar.out.hits.repeat") }
              }
            }
          }
        }
      },
      render: (_args, value) => {
        const v = value;
        const hits = v.hits ?? [];
        // [macro-fusion 0.2.46] 一条都没有的时候也要说话：原来返回空数组，
        // 上层拿不到任何字（融合层会退化成 {"hits": []}），读者分不清「没有相似」和「没比」。
        if (hits.length === 0) {
          return [{
            type: "text",
            text: String(v.note || "相似检索没算成：这次没有可比较的对象。这不是「记忆里没有相似的东西」。")
          }];
        }
        return hits.map((h) => ({
          type: "text",
          text: `[${String(h.level ?? "")} ${String(h.id ?? "").slice(0, 12)}] \u76F8\u4F3C\u5EA6 ${Number(h.similarity ?? 0).toFixed(3)}\uFF08\u9010\u5B57 ${Number(h.repeat ?? 0).toFixed(2)}\uFF09 ${String(h.title ?? "")} ${String(h.content ?? "").slice(0, 80)}`
        }));
      }
    },
    async execute(args, exec) {
      refuseOrThrow("read", exec);
      const parsed = args;
      const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
      if (!id) throw new Error("memory_find_similar: id \u4E0D\u80FD\u4E3A\u7A7A");
      const workspace = workspaceOf(exec);
      if (!workspace) throw new Error("memory_find_similar: \u65E0\u6CD5\u786E\u5B9A\u5DE5\u4F5C\u533A\uFF08\u4F1A\u8BDD\u65E0 cwd\uFF09\u2014\u2014\u8BB0\u5FC6\u5DE5\u5177\u9700\u5728\u6709\u5DE5\u4F5C\u533A cwd \u7684\u4F1A\u8BDD\u5185\u8C03\u7528\uFF0C\u5916\u90E8/\u65E0\u4F1A\u8BDD\u8C03\u7528\u94FE\u4E0D\u53D7\u652F\u6301\uFF08#94\uFF09");
      const db = getDb(workspace, dir);
      // [macro-fusion 0.2.53] 这里原来也是 findById：短 id 撞车时静默取第一条，然后**拿别人的正文当基准**
      // 去算相似度——比出来的分数全是错的，而结果看起来完全正常（0.2.52 只修了 memory_read，
      // 这条读路径同样吃短 id，口径必须一起收紧）。
      const matches = typeof db.findByIdAll === "function" ? db.findByIdAll(id) : db.findById(id) ? [db.findById(id)] : [];
      if (matches.length > 1) {
        const shown = matches.slice(0, 5).map((m) => `${m.level} ${m.row.id}${m.row.title ? `「${m.row.title}」` : `「${String(m.row.content).slice(0, 24)}…」`}`);
        const more = matches.length > shown.length ? `…等 ${matches.length} 条` : "";
        throw new Error(
          `memory_find_similar: 相似检索这次一条都没比：这个短 id 命中了 ${matches.length} 条（${shown.join("；")}${more}）。不是我替你挑第一条——基准挑错，比出来的相似度全是错的。把 id 给够位数（至少 8 位，最好整条）再试。`,
        );
      }
      const found = matches[0];
      if (!found) {
        throw new Error(
          `memory_find_similar: 相似检索没起点——这个工作区里一条都没有：id「${id}」在七层表里都查不到（记忆库按工作区分开存，当前工作区 ${workspace}）。可能是拼错了、位数不够（至少 8 位），或这条建在别的 cwd 会话里——先用 memory_search 反查 id。`,
        );
      }
      const sessionId = sessionIdOf(exec);
      const seen = readSeen(workspace, sessionId ?? "unknown", dir);
      const kRaw = coerceNumber(parsed.k);
      const k = kRaw !== void 0 ? Math.max(1, Math.min(20, Math.round(kRaw))) : 5;
      const cmRaw = coerceNumber(parsed.content_max);
      const contentMax = cmRaw !== void 0 ? Math.max(0, Math.min(5e3, Math.round(cmRaw))) : 200;
      const rows = LEVELS.flatMap((lv) => lv === "soul" || lv === "user" ? [] : db.listSearchable(lv));
      // [macro-fusion 0.2.89] 两处口径修正（实测见 tools/probe-similar.mjs）：
      // ① 原来这里还有 `r.source_session !== sessionId` —— 同一次会话里刚写的条目整批不算候选。
      //    可「我刚写了这几条，看看谁跟谁像」正是这个工具最自然的用法：三条相关记忆写下去，
      //    回执是「可比的候选一条都没有……等下一次会话再问」，等于把工具在自己最该用的时刻关掉。
      //    真正要防的是「重复端」（这一轮已经列给读者看过的），那是 seen 的活，不让会话身份兼职。
      // ② 基准原来只拿 found.row.content 去比，候选取的却是 docText（title + 正文 + keywords）。
      //    同一把尺子两边量的字不一样：keywords 写在候选身上算分，写在基准身上被整块丢掉——
      //    实测「只沾基准 keywords」的候选在正文口径下 0.000 分（完全看不见），
      //    基准也走 docText 才 0.241。基准短、信息在 keywords 的条目（本库的常态）就这么漏邻居。
      const candidates = rows.filter((r) => r.id !== found.row.id && !seen.has(r.id));
      const docs = candidates.map((r) => ({
        id: r.id,
        level: r.level,
        title: r.title,
        content: r.content,
        keywords: r.keywords,
        importance: r.importance,
        created_at: r.created_at,
        updated_at: r.updated_at,
        last_accessed_at: r.last_accessed_at
        // #91：衰减按最后使用时间
      }));
      const hits = findSimilar(docText(found.row), docs, k, found.row.content);
      markSearched(workspace, sessionId ?? "unknown", hits.map((h) => h.id), dir);
      // [macro-fusion 0.2.89] 本会话刚写的条目现在也会成为候选（见上面的口径注释），
      // 那就得说清楚哪几条是「刚才你写的」——否则读者会把它们当成库里积累下来的旧账，
      // 误判「这条结论早就有依据了」。
      const freshHits = hits.filter((h) => rows.some((r) => r.id === h.id && r.source_session === sessionId));
      // [macro-fusion 0.2.46] 空结果原来什么都不说：render 返回空数组，
      // 融合层就只能把 {"hits": []} 原样端出去——既没解释也没凭据。
      // 四种情况共用这个「空」：基准内容没有可比较的词 / 库里只有这一条 /
      // 候选都被过滤（本会话新写 + 这一轮已看过） / 真算过但词汇零重叠。
      let note = "";
      if (hits.length === 0) {
        const noTarget = tfVector(tokenize(docText(found.row))).size === 0;
        note = noTarget
          ? "相似检索没算成：这条记忆没有可用于比较的词（标题 / 正文 / 关键词全是符号、数字或停用词）。这不是「记忆里没有相似的东西」。"
          : rows.length <= 1
            ? "相似检索没算成：库里就只有这一条可比的记忆，没有别的条目可以比较。这不是「记忆里没有相似的东西」。"
            : candidates.length === 0
              ? `相似检索没算成：可比的候选一条都没有（库里 ${rows.length} 条，这一轮已经端给你看过的都排除了）。这不是「记忆里没有相似的东西」——换一条基准，或者把 k 给大一点再问。`
              : `这次真算过了：${candidates.length} 条候选里没有一条和它有共同词汇（相似度全是 0）。这才是「记忆里没有相似的东西」。`;
      }
      if (hits.length > 0) note = similarCalibNote(hits, freshHits);
      return {
        hits: hits.map((h) => ({
          id: h.id,
          level: h.level,
          title: h.title ?? "",
          content: contentMax > 0 ? h.content.slice(0, contentMax) : h.content,
          similarity: h.similarity,
          repeat: h.repeat
        })),
        note
      };
    },
    presentCall(args) {
      const parsed = args;
      return { card: "generic", title: `memory_find_similar: ${String(parsed.id ?? "").slice(0, 12)}`, kind: "read" };
    }
  };
}
function readTool(dir) {
  return {
    name: "memory_read",
    description: T("memory_read.description"),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", description: T("memory_read.param.id") }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["found"],
        properties: {
          found: { type: "boolean" },
          id: { type: "string" },
          level: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          importance: { type: "number" },
          status: { type: "string" },
          keywords: { type: "array", items: { type: "string" } },
          project: { type: "string" },
          goal: { type: "string" },
          corrected: { type: "boolean" },
          created_at: { type: "number" },
          updated_at: { type: "number" },
          ambiguous: { type: "boolean" },
          candidates: { type: "array", items: { type: "string" } },
          note: { type: "string" }
        }
      },
      render: (_args, value) => {
        const v = value;
        const hint = "\u5982\u679C\u4F60\u786E\u5B9E\u9700\u8981\u66F4\u591A\u7EC6\u8282\uFF0C\u53EF\u4EE5\u76F4\u63A5\u53BB\u804A\u5929\u8BB0\u5F55\u91CC\u641C\u7D22\u76F8\u5173\u5173\u952E\u8BCD\u3002";
        // [macro-fusion 0.2.52] 「没读到」有两种：短 id 撞车（不许替你挑一条）与真没有（工作区/拼错/位数）。
        if (v.ambiguous === true) return [{ type: "text", text: String(v.note ?? "") }];
        if (!v.found) return [{ type: "text", text: `${typeof v.note === "string" && v.note.trim() ? v.note : `\u672A\u627E\u5230\u8BE5\u8BB0\u5FC6\u3002`}${hint}` }];
        const parts = [`[${String(v.level ?? "")}] ${String(v.title ?? "")}\uFF08${String(v.status ?? "")}\uFF09`];
        if (v.project) parts.push(`\u9879\u76EE\uFF1A${String(v.project)}`);
        if (v.goal) parts.push(`\u76EE\u6807\uFF1A${String(v.goal)}`);
        parts.push(String(v.content ?? ""));
        parts.push(hint);
        return [{ type: "text", text: parts.join("\n") }];
      }
    },
    async execute(args, exec) {
      refuseOrThrow("read", exec);
      const parsed = args;
      const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
      if (!id) throw new Error("memory_read: id \u4E0D\u80FD\u4E3A\u7A7A");
      const workspace = workspaceOf(exec);
      if (!workspace) throw new Error("memory_read: \u65E0\u6CD5\u786E\u5B9A\u5DE5\u4F5C\u533A\uFF08\u4F1A\u8BDD\u65E0 cwd\uFF09\u2014\u2014\u8BB0\u5FC6\u5DE5\u5177\u9700\u5728\u6709\u5DE5\u4F5C\u533A cwd \u7684\u4F1A\u8BDD\u5185\u8C03\u7528\uFF0C\u5916\u90E8/\u65E0\u4F1A\u8BDD\u8C03\u7528\u94FE\u4E0D\u53D7\u652F\u6301\uFF08#94\uFF09");
      const db = getDb(workspace, dir);
      // [macro-fusion 0.2.52] 读原来是 findById：短 id 走 LIKE 前缀，撞上多条时**静默取第一条**
      //（按 LEVELS 顺序跨表），回执却写成「[fact] 标题（active）」，读起来像「你要的就是这条」。
      // 写路径（memory_update）遇到歧义是直接拒绝的，读路径比写路径松，两边口径就不统一了。
      const matches = typeof db.findByIdAll === "function" ? db.findByIdAll(id) : (db.findById(id) ? [db.findById(id)] : []);
      if (matches.length > 1) {
        const shown = matches.slice(0, 5).map((m) => `${m.level} ${m.row.id}${m.row.title ? `「${m.row.title}」` : `「${String(m.row.content).slice(0, 24)}…」`}`);
        const more = matches.length > shown.length ? `…等 ${matches.length} 条` : "";
        const list = `${shown.join("；")}${more}`;
        return {
          found: false,
          ambiguous: true,
          id,
          candidates: list,
          note: `这个短 id 不止一条记忆：命中了 ${matches.length} 条（${list}）。所以这次一条都没读——不是我替你挑第一条。把 id 给够位数（至少 8 位，最好整条）再读一次。`
        };
      }
      const found = matches[0];
      if (!found) {
        return {
          found: false,
          id,
          note: `这个工作区里一条都没有：id「${id}」在七层表里都查不到。可能是拼错了、位数不够（短 id 至少 8 位），也可能是这条记忆建在别的 cwd 会话里——记忆库按工作区分开存（当前工作区 ${workspace}），换回那个工作区再找；活着的条目可以用 memory_search 反查 id。`
        };
      }
      const { row } = found;
      markAccessed(workspace, sessionIdOf(exec) ?? "unknown", [row.id], dir);
      // [macro-fusion 0.4.0] 读到正文才记一次 read：这是 unused 体检（hit_count>0 却从没读过）
      // 唯一的记账点，所以只放在这里——检索、注入、面板都不许冒充「读」。
      db.bumpRead(row.level, row.id);
      return {
        found: true,
        id: row.id,
        level: row.level,
        title: row.title ?? "",
        content: row.content,
        importance: row.importance,
        status: row.status,
        keywords: row.keywords,
        project: row.project ?? "",
        goal: row.goal ?? "",
        corrected: row.corrected === 1,
        created_at: row.created_at,
        updated_at: row.updated_at
      };
    },
    presentCall(args) {
      const parsed = args;
      return { card: "generic", title: `memory_read: ${String(parsed.id ?? "").slice(0, 16)}`, kind: "read" };
    }
  };
}
function updateTool(dir) {
  return {
    name: "memory_update",
    description: T("memory_update.description"),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", description: T("memory_update.param.id") },
        content: { type: "string", description: T("memory_update.param.content") },
        status: { type: "string", enum: ["active", "archived", "stale"], description: T("memory_update.param.status") },
        importance: { type: "integer", description: T("memory_update.param.importance") },
        goal: { type: "string", description: T("memory_update.param.goal") },
        project: { type: "string", description: T("memory_update.param.project") },
        keywords: { type: "array", items: { type: "string" }, description: T("memory_update.param.keywords") }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: {
          ok: { type: "boolean" },
          id: { type: "string" },
          level: { type: "string" },
          // [macro-fusion 0.2.49] 这两张表让「改了什么 / 哪些字段被过滤掉」可判读，
          // note 是给人看的那句话（上层 render 见不到文本就会退回 JSON，等于又闷回去）。
          changed: { type: "array", items: { type: "string" } },
          dropped: { type: "array", items: { type: "string" } },
          note: { type: "string" }
        }
      },
      render: (_args, value) => {
        const v = value;
        const said = typeof v.note === "string" && v.note.trim() ? v.note : v.ok ? `\u2705 \u5DF2\u66F4\u65B0\uFF08${String(v.level ?? "")} ${String(v.id ?? "").slice(0, 8)}\uFF09\u3002` : "\u66F4\u65B0\u5931\u8D25\uFF1A\u672A\u627E\u5230\u8BE5\u8BB0\u5FC6\u3002";
        return [{ type: "text", text: said }];
      }
    },
    async execute(args, exec) {
      refuseOrThrow("write", exec);
      const parsed = args;
      const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
      if (!id) throw new Error("memory_update: id \u4E0D\u80FD\u4E3A\u7A7A");
      const workspace = workspaceOf(exec);
      if (!workspace) throw new Error("memory_update: \u65E0\u6CD5\u786E\u5B9A\u5DE5\u4F5C\u533A\uFF08\u4F1A\u8BDD\u65E0 cwd\uFF09\u2014\u2014\u8BB0\u5FC6\u5DE5\u5177\u9700\u5728\u6709\u5DE5\u4F5C\u533A cwd \u7684\u4F1A\u8BDD\u5185\u8C03\u7528\uFF0C\u5916\u90E8/\u65E0\u4F1A\u8BDD\u8C03\u7528\u94FE\u4E0D\u53D7\u652F\u6301\uFF08#94\uFF09");
      const db = getDb(workspace, dir);
      const sessionId = sessionIdOf(exec);
      const matches = db.findByIdAll(id);
      if (matches.length > 1) {
        const list = matches.map((m) => `${m.level}:${m.row.id.slice(0, 8)} ${m.row.title || m.row.content.slice(0, 40)}`).join("\uFF1B");
        throw new Error(`memory_update: \u77ED id "${id}" \u547D\u4E2D ${matches.length} \u6761\uFF08${list}\uFF09\uFF0C\u8BF7\u6539\u7528\u5B8C\u6574 id`);
      }
      const found = matches[0];
      if (!found) return { ok: false, id, level: "", changed: [], dropped: [], note: "更新失败：没有这个 id（七层表里都找不到）。短 id 给前 8 位就够，但要能唯一命中；请先用 memory_search / memory_read 确认 id。" };
      const patch = {};
      if (typeof parsed.content === "string" && parsed.content.trim()) patch.content = parsed.content.trim();
      if (typeof parsed.status === "string" && ["active", "archived", "stale"].includes(parsed.status)) patch.status = parsed.status;
      const importanceRaw = coerceNumber(parsed.importance);
      if (importanceRaw !== void 0) patch.importance = Math.round(importanceRaw);
      if (typeof parsed.goal === "string" && parsed.goal.trim() && found.level === "topic") patch.goal = parsed.goal.trim();
      if (typeof parsed.project === "string" && (found.level === "project" || found.level === "fact" || found.level === "lesson" || found.level === "rules" || found.level === "topic")) {
        const cleared = parsed.project.trim() === "";
        patch.project = cleared ? null : parsed.project.trim();
        if (!cleared && !isGlobalProject(String(patch.project)) && !String(patch.project).includes(",")) setCurrentProject(workspace, sessionId ?? "unknown", patch.project, dir);
      }
      {
        const kw = normalizeKeywords(parsed.keywords);
        if (kw.length > 0) patch.keywords = kw;
      }
      // [macro-fusion 0.2.49] 这一段原来只回一个 ok 布尔：字段被这条流水线静默丢掉时，
      // patch 是空的，ok 仍然是 true，于是「一个字段都没写进去」被说成「✅ 已更新」。
      // 过滤是必要的（goal 只有 topic 层有、user/soul 层没有项目归属），但不能闷着丢。
      const has = (k) => parsed[k] !== void 0 && parsed[k] !== null;
      const changed = Object.keys(patch);
      const dropped = [];
      if (has("content") && !(typeof parsed.content === "string" && parsed.content.trim())) {
        dropped.push("content（给的是空串——整段替换会把它清空，所以这次没动它）");
      }
      if (has("status") && !["active", "archived", "stale"].includes(parsed.status)) {
        dropped.push(`status（${String(parsed.status)} 不在 active/stale/archived 里）`);
      }
      if (has("importance") && importanceRaw === void 0) {
        dropped.push(`importance（${String(parsed.importance)} 不是数字）`);
      }
      if (has("goal") && found.level !== "topic") {
        dropped.push(`goal（只有 topic 层有目标句，这条是 ${found.level}）`);
      }
      if (has("project") && !(typeof parsed.project === "string" && (found.level === "project" || found.level === "fact" || found.level === "lesson" || found.level === "rules" || found.level === "topic"))) {
        dropped.push(`project（${found.level} 层不接受项目归属）`);
      }
      if (has("keywords") && normalizeKeywords(parsed.keywords).length === 0) {
        dropped.push("keywords（归一后是空列表——传空数组等于「不改」，要清空请传有意义的新词）");
      }
      let ok = false;
      let note;
      if (changed.length === 0) {
        note =
          "这次什么都没改：一个能写进库的字段都没有。"
          + (dropped.length > 0 ? `没生效的是这些：${dropped.join("；")}。` : "（只给了 id，别的字段一个都没带。）")
          + `要改就带上 ${String(found.level)} 层支持的字段再调一次——这不是「已经更新好了」。`;
      } else {
        ok = db.update(found.level, found.row.id, patch) === true;
        note = ok
          ? (dropped.length > 0
            ? `✅ 已更新（${found.level} ${String(found.row.id).slice(0, 8)}）：${changed.join(" / ")}。但这几个字段没生效：${dropped.join("；")}——这是「部分生效」，不是全部。`
            : `✅ 已更新（${found.level} ${String(found.row.id).slice(0, 8)}）：${changed.join(" / ")}。`)
          : `找到了这条记忆，但没写进库（${found.level} ${String(found.row.id).slice(0, 8)}）：可能是这行刚被合并/归档，也可能是库被锁住了。稍后再试一次，或先用 memory_read 确认它还在。`;
      }
      if (ok) markWritten(workspace, sessionId ?? "unknown", [found.row.id], dir);
      // [0.2.137] 改内容和写新条目一样会让两个版本并排躺着。原来只有 remember 查冲突，
      // 于是「把旧条目改成新版本号」这条最常走的路反而是唯一不查的路。
      let conflictNote = "";
      if (ok && typeof patch.content === "string") {
        try {
          const projNow = patch.project !== void 0 ? patch.project : found.row.project;
          const siblings = db.list(found.level, { status: "active" }).filter((r) => r.id !== found.row.id);
          conflictNote = conflictWarn(conflictCandidates(siblings, patch.content, projNow), db, "update");
        } catch {
          conflictNote = "";
        }
      }
      const said = conflictNote.length > 0 ? `${note}\n${conflictNote}` : note;
      return { ok, id: found.row.id, level: found.level, changed, dropped, note: said };

    },
    presentCall(args) {
      const parsed = args;
      return { card: "generic", title: `memory_update: ${String(parsed.id ?? "").slice(0, 8)}${parsed.status ? ` \u2192 ${String(parsed.status)}` : ""}`, kind: "write" };
    }
  };
}
function projectTool(dir) {
  return {
    name: "memory_project",
    description: T("memory_project.description"),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["project"],
      properties: {
        project: { type: "string", description: T("memory_project.param.project") }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["project", "text"],
        properties: {
          project: { type: "string" },
          text: { type: "string", description: T("memory_project.out.text") }
        }
      },
      render: (_args, value) => {
        const v = value;
        return [{ type: "text", text: String(v.text ?? "") }];
      }
    },
    async execute(args, exec) {
      refuseOrThrow("read", exec);
      const parsed = args;
      const project = typeof parsed.project === "string" ? parsed.project.trim() : "";
      if (!project) throw new Error("memory_project: project \u4E0D\u80FD\u4E3A\u7A7A");
      const workspace = workspaceOf(exec);
      if (!workspace) throw new Error("memory_project: \u65E0\u6CD5\u786E\u5B9A\u5DE5\u4F5C\u533A\uFF08\u4F1A\u8BDD\u65E0 cwd\uFF09\u2014\u2014\u8BB0\u5FC6\u5DE5\u5177\u9700\u5728\u6709\u5DE5\u4F5C\u533A cwd \u7684\u4F1A\u8BDD\u5185\u8C03\u7528\uFF0C\u5916\u90E8/\u65E0\u4F1A\u8BDD\u8C03\u7528\u94FE\u4E0D\u53D7\u652F\u6301\uFF08#94\uFF09");
      const db = getDb(workspace, dir);
      const sessionId = sessionIdOf(exec);
      if (!isGlobalProject(project) && !project.includes(",")) setCurrentProject(workspace, sessionId ?? "unknown", project, dir);
      markProjectQueried(workspace, sessionId ?? "unknown", project, dir);
      const text = buildProjectSectionText(db, workspace, project, dir);
      if (text === null) {
        // [macro-fusion 0.2.47] 空全景原来只有一句「该项目暂无记忆条目」。
        // 三种情况共用它：① 名字一条都对不上（拼错 / 大小写 / 中英混写）
        // ② 名字对得上，但 project 层与 rules 层都空着，而 fact/lesson/topic 里还有一堆
        // ③ 真的七层都查过、一条都没有。只有 ③ 才是结论。
        const known = typeof db.listProjectNames === 'function' ? db.listProjectNames() : [];
        const lower = project.toLowerCase();
        const matched = known.some((n) => n === project || n.toLowerCase() === lower);
        const counts = [
          ['fact', db.list('fact', { status: 'active' }).filter((r) => projectList(r.project).includes(project)).length],
          ['lesson', db.list('lesson', { status: 'active' }).filter((r) => projectList(r.project).includes(project)).length],
          ['topic', db.list('topic', { status: 'active' }).filter((r) => projectList(r.project).includes(project)).length]
        ];
        const total = counts.reduce((a, [, n]) => a + n, 0);
        if (total > 0) {
          const brief = counts.filter(([, n]) => n > 0).map(([lv, n]) => `${lv} ${n}`).join(' / ');
          return {
            project,
            text: [
              L("project.empty", { name: project }),
              `上面这句只说了一半：overview/structure/decisions/quotes/ops/todo 六类与项目准则都没有 active 条目，` +
                `但这个项目在别的层还有 ${total} 条记忆（${brief}）。`,
              `这不是「这个项目没有记忆」——用 memory_search(project="${project}", query=…) 能把它们捞出来；` +
                `想让全景段落有内容，可以用 memory_remember 往 project 层的子类里补。`
            ].join('\n')
          };
        }
        if (!matched) {
          const sample = known.slice(0, 12);
          return {
            project,
            text: [
              `【项目：${project}】这个名字在库里一条都对不上——七层表里没有任何一条记忆的 project 字段写着它。`,
              sample.length > 0
                ? `库里现有的项目名：${sample.join(' / ')}${known.length > sample.length ? ` …（共 ${known.length} 个）` : ''}。`
                : '库里现在一个项目名都还没有（所有记忆都没有项目标签）。',
              `这不是「这个项目没有记忆」，是名字没对上——大小写、空格、中英文混写都可能让同一个项目变成两个名字。` +
                `也可以直接 memory_search(query=…) 全库检索。`
            ].join('\n')
          };
        }
        return {
          project,
          text: [L("project.empty", { name: project }), '查过七层表：project 字段正好写着这个名字的 active 条目是 0 条，这次是真没有（已归档/已完结的不算）。'].join('\n')
        };
      }
      return { project, text };
    },
    presentCall(args) {
      const parsed = args;
      return { card: "generic", title: `memory_project: ${String(parsed.project ?? "").slice(0, 24)}`, kind: "read" };
    }
  };
}
function homeTool() {
  return {
    name: "memory_home",
    description: T("memory_home.description"),
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: { type: "string", description: T("memory_home.param.target") }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["note"],
        properties: { note: { type: "string", description: T("memory_home.out.note") } }
      },
      render: (_args, value) => {
        const v = value;
        return [{ type: "text", text: String(v.note ?? "") }];
      }
    },
    async execute(args) {
      const parsed = args;
      const presets = homeDirPresets();
      const raw = typeof parsed.target === "string" ? parsed.target.trim() : "";
      if (raw === "") {
        return { note: [
          `\u5F53\u524D\u5168\u5C40\u6570\u636E\u76EE\u5F55\uFF1A${activeHomeDir()}`,
          `\u9884\u8BBE default\uFF08\u7CFB\u7EDF\u7528\u6237\u4E3B\u76EE\u5F55\uFF09\uFF1A${presets.default}`,
          `\u9884\u8BBE dsh-storage\uFF08DSH \u6839\u76EE\u5F55 Storage\uFF09\uFF1A${presets["dsh-storage"]}`,
          `\u9884\u8BBE plugin-root\uFF08\u63D2\u4EF6\u672C\u4F53\u6839\u76EE\u5F55\uFF09\uFF1A${presets["plugin-root"]}`,
          `\u4E0D\u4FEE\u6539\u5219\u4E0D\u4F20 target\uFF1B\u8981\u5207\u6362\u8BF7\u4F20\u9884\u8BBE\u6807\u8BB0\u6216\u7EDD\u5BF9\u8DEF\u5F84\u3002`
        ].join("\n") };
      }
      const LEGAL = ["default", "dsh-storage", "plugin-root"];
      const target = resolveHomeDir(raw);
      const downgraded = target === resolveHomeDir(void 0) && !LEGAL.includes(raw);
      if (downgraded) {
        return { note: `\u65E0\u6CD5\u8BC6\u522B\u7684 target\uFF1A"${raw}"\uFF08\u53EF\u7528\u9884\u8BBE\u6807\u8BB0\u6216\u7EDD\u5BF9\u8DEF\u5F84\uFF09\u3002\u5F53\u524D\u76EE\u5F55\u672A\u53D8\uFF1A${activeHomeDir()}` };
      }
      const sw = switchHomeDir(target);
      if (sw.mode === "same") return { note: `\u5168\u5C40\u6570\u636E\u76EE\u5F55\u672C\u5C31\u662F ${sw.to}\uFF0C\u672A\u53D8\u66F4\u3002` };
      if (sw.mode === "failed") return { note: `\u5207\u6362\u5931\u8D25\uFF1A${sw.error}\u3002\u4ECD\u4F7F\u7528 ${sw.from}\uFF0C\u6570\u636E\u672A\u53D7\u5F71\u54CD\uFF0C\u53EF\u7A0D\u540E\u91CD\u8BD5\u3002` };
      if (sw.mode === "reused-nonempty") return { note: `\u5DF2\u5207\u6362\u4E3A ${sw.to}\uFF08\u76EE\u6807\u76EE\u5F55\u5DF2\u6709\u5185\u5BB9\uFF0C\u76F4\u63A5\u542F\u7528\u3001\u672A\u8986\u76D6\uFF09\u3002\u65E7\u76EE\u5F55 ${sw.from} \u539F\u6837\u4FDD\u7559\u3002` };
      if (sw.mode === "rename") return { note: `\u5DF2\u5207\u6362\u4E3A ${sw.to}\uFF1A\u81EA ${sw.from} \u79FB\u52A8 ${sw.files} \u9879\u5B8C\u6210\uFF08\u540C\u76D8\u79FB\u52A8\uFF09\u3002\u5982\u672C\u673A\u6709\u591A\u4E2A dsh \u5B9E\u4F8B\u5171\u4EAB\u65E7\u76EE\u5F55\uFF0C\u8BF7\u540C\u6B65\u4FEE\u6539\u5B83\u4EEC\u7684\u8BBE\u7F6E\u3002` };
      return { note: `\u5DF2\u5207\u6362\u4E3A ${sw.to}\uFF1A\u81EA ${sw.from} \u590D\u5236 ${sw.files} \u9879\uFF08\u8DE8\u76D8\u590D\u5236\u4E3A\u5FEB\u7167\uFF09\u3002\u65E7\u76EE\u5F55 ${sw.from} \u4FDD\u7559\u672A\u5220\uFF0C\u786E\u8BA4\u65E0\u8BEF\u540E\u53EF\u624B\u52A8\u5220\u9664\uFF1B\u82E5\u591A\u4E2A dsh \u5B9E\u4F8B\u5171\u4EAB\u65E7\u76EE\u5F55\uFF0C\u8BF7\u540C\u6B65\u4FEE\u6539\u5176\u4ED6\u5B9E\u4F8B\u7684\u8BBE\u7F6E\u3002` };
    }
  };
}
function registerMemoryTools(register, dir = ".dsh-meow") {
  register(rememberTool(dir));
  register(searchTool(dir));
  register(findSimilarTool(dir));
  register(readTool(dir));
  register(updateTool(dir));
  register(projectTool(dir));
  register(homeTool());
}

// src/source.ts
// [macro-fusion 0.2.80] 注入消息的 kind 是宿主聊天卡上直接显示的字符串（上下文注入 · <kind>），
// 所以这里要写融合后的名字「宏记忆 / macro-memory」，而不是上游的 meow-memory。
// 历史会话里已经落盘的 kind 仍是 plugin:meow-memory，识别时必须一起认，否则老快照会被
// 当成普通用户消息重新算一遍（重复注入 / 反复召回）。
var PLUGIN_NAME = "meow-memory";
var PLUGIN_KIND = "plugin:macro-memory";
var LEGACY_PLUGIN_KINDS = ["plugin:meow-memory", `plugin:${PLUGIN_NAME}`];
var PLUGIN_SOURCE = { kind: PLUGIN_KIND };
function isMeowSource(source) {
  if (source === null || typeof source !== "object") return false;
  const record = source;
  if (record.kind === PLUGIN_KIND) return true;
  if (LEGACY_PLUGIN_KINDS.includes(record.kind)) return true;
  return record.kind === "plugin" && record.plugin === PLUGIN_NAME;
}

// src/dream.ts
var DREAM_MARKER = "[meow-memory-dream]";
function shortSessionId(sid) {
  return (sid.startsWith("session-") ? sid.slice(8) : sid).slice(0, 8);
}
function dreamLog(ws, dir, msg) {
  try {
    appendFileSync(join7(ws, dir, "dream-debug.log"), `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`);
  } catch {
  }
}
/** [macro-fusion 0.2.97] 读某个工作区的 dream 账本：面板要说的每一句都从这里出，别的地方不许自己猜。
 *  missing 分四种：'' 正常；'no-workspace' 会话没有 cwd；'no-db' 这个工作区还没建记忆库；
 *  'read-failed: …' 库在但读不出来（原因原样带出）——「没账本」和「读不出来」不能合成一句话。 */
function readDreamLedger(workspace, dir = ".dsh-meow", limit = 5, offset = 0, project = "", since = 0, until = 0) {
  const empty = { rows: [], path: "", missing: "no-workspace", total: 0 };
  if (typeof workspace !== "string" || workspace.length === 0) return empty;
  const path = memoryDbPath(workspace, dir);
  if (!existsSync8(path)) return { rows: [], path, missing: "no-db", total: 0 };
  try {
    const db = getDb(workspace, dir);
    // [macro-fusion 0.2.100] 分页要一个总数：翻到第几页、还有几条更早，只能从这里来，
    // 不许拿「这一页返回了几条」凑（最后一页会短，那是页面短，不是账本短）。
    // [macro-fusion 0.2.101] 带 project 时 total 也必须是筛后的数——两个数各算一套就会翻出空页。
    // [macro-fusion 0.2.105] since / until（毫秒，闭区间）同理：行和总数一起过同一把筛子。
    return {
      rows: db.recentDreamsPage(limit, offset, project, since, until),
      path,
      missing: "",
      total: db.dreamCountOf(project, since, until),
    };
  } catch (e) {
    return { rows: [], path, missing: `read-failed: ${e instanceof Error ? e.message : String(e)}`, total: 0 };
  }
}

/** [macro-fusion 0.2.105] 账本覆盖的时间范围（最早 / 最新，毫秒）。
 *  筛出一段空结果时，面板要能说「这段时间里没有」而不是「账本里没有」——两者的修法完全不同。 */
function readDreamSpan(workspace, dir = ".dsh-meow") {
  if (typeof workspace !== "string" || workspace.length === 0) return { first: 0, last: 0, path: "", missing: "no-workspace" };
  const path = memoryDbPath(workspace, dir);
  if (!existsSync8(path)) return { first: 0, last: 0, path, missing: "no-db" };
  try {
    const got = getDb(workspace, dir).dreamsSpan();
    return { first: got.first, last: got.last, path, missing: "" };
  } catch (e) {
    return { first: 0, last: 0, path, missing: `read-failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** [macro-fusion 0.2.101] 账本里出现过哪些项目段、各出现几次。
 *  这是「按项目翻账」的入口：面板先告诉你有哪几个项目，再说每个项目能筛出几条。
 *  missing 三态与 readDreamLedger 一样分开说，理由也一样——没库和读不开是两种修法。 */
function readDreamProjects(workspace, dir = ".dsh-meow", limit = 5) {
  if (typeof workspace !== "string" || workspace.length === 0) return { items: [], total: 0, path: "", missing: "no-workspace" };
  const path = memoryDbPath(workspace, dir);
  if (!existsSync8(path)) return { items: [], total: 0, path, missing: "no-db" };
  try {
    const got = getDb(workspace, dir).dreamProjects(limit);
    return { items: got.items, total: got.total, path, missing: "" };
  } catch (e) {
    return { items: [], total: 0, path, missing: `read-failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** [macro-fusion 0.2.100] 单条账：面板要摊开一条的原文时走这里。
 *  rank 是「第几近」（1 = 最新，和面板上的 #k 同一个编号），不暴露 rowid——
 *  对外的句柄只有一种口径，内部 id 只用来定位，免得同一个位置有两种叫法。
 *  missing 在 readDreamLedger 四态之外多一个 'no-row'：账本在、就是没有第 rank 条。 */
function readDreamRecord(workspace, dir = ".dsh-meow", rank = 1) {
  if (typeof workspace !== "string" || workspace.length === 0) return { row: null, prev: null, path: "", missing: "no-workspace", total: 0 };
  const path = memoryDbPath(workspace, dir);
  if (!existsSync8(path)) return { row: null, prev: null, path, missing: "no-db", total: 0 };
  const asked = Math.trunc(Number(rank));
  const k = Number.isFinite(asked) && asked > 0 ? asked : 1;
  try {
    const db = getDb(workspace, dir);
    const total = db.dreamCount();
    if (k > total) return { row: null, prev: null, path, missing: "no-row", total };
    const rows = db.recentDreamsPage(2, k - 1);
    return { row: rows[0] ?? null, prev: rows[1] ?? null, path, missing: "", total };
  } catch (e) {
    return { row: null, prev: null, path, missing: `read-failed: ${e instanceof Error ? e.message : String(e)}`, total: 0 };
  }
}

/** [macro-fusion 0.2.104] 按稳定引用读一条账：ref 是 r<N> 里的 N（dream_log.id）。
 *  与 readDreamRecord（按第几近）分工：那个编号会随新账往下挪，这个不会——同样一条账，
 *  引用是「它自己」，第几近是「它此刻排第几」。missing 在四态之外同样多一个 'no-row'。 */
function readDreamRecordByRef(workspace, dir = ".dsh-meow", ref = 0) {
  if (typeof workspace !== "string" || workspace.length === 0) return { row: null, prev: null, rank: 0, path: "", missing: "no-workspace", total: 0 };
  const path = memoryDbPath(workspace, dir);
  if (!existsSync8(path)) return { row: null, prev: null, rank: 0, path, missing: "no-db", total: 0 };
  const asked = Math.trunc(Number(ref));
  const key = Number.isFinite(asked) && asked > 0 ? asked : 0;
  try {
    const db = getDb(workspace, dir);
    const total = db.dreamCount();
    const row = db.dreamById(key);
    if (!row) return { row: null, prev: null, rank: 0, path, missing: "no-row", total };
    const rank = db.dreamRankOf(key);
    const rows = rank > 0 ? db.recentDreamsPage(2, rank - 1) : [];
    return { row: row ?? rows[0] ?? null, prev: rows[1] ?? null, rank, path, missing: "", total };
  } catch (e) {
    return { row: null, prev: null, rank: 0, path, missing: `read-failed: ${e instanceof Error ? e.message : String(e)}`, total: 0 };
  }
}

/** [macro-fusion 0.2.115] 一段连着的账：从第 offset 近开始往下取 limit 条。
 *  为什么不留着「一条一条按第几近取」：跨轮追踪要问的是「这一对在更早的几轮里出现过没有」，
 *  逐条取就是 N 次查库、还得自己拼次序；这里一次取出，次序与 recentDreamsPage 同一把尺子
 *  （run_at DESC, rowid DESC），面板上的「第 k 近」和这里的下标才说得通。
 *  missing 四态照旧，另加 'bad-arg' 只在 offset 写坏时出现（写坏就地打回，不猜）。 */
function readDreamRecords(workspace, dir = ".dsh-meow", limit = 5, offset = 0) {
  if (typeof workspace !== "string" || workspace.length === 0) return { rows: [], missing: "no-workspace", total: 0, path: "" };
  const path = memoryDbPath(workspace, dir);
  if (!existsSync8(path)) return { rows: [], missing: "no-db", total: 0, path };
  const askedLimit = Math.trunc(Number(limit));
  const n = Math.min(50, Math.max(1, Number.isFinite(askedLimit) && askedLimit > 0 ? askedLimit : 5));
  const askedOffset = Math.trunc(Number(offset));
  if (!Number.isFinite(askedOffset) || askedOffset < 0) return { rows: [], missing: "bad-arg", total: 0, path };
  try {
    const db = getDb(workspace, dir);
    const total = db.dreamCount();
    const rows = db.recentDreamsPage(n, askedOffset);
    return { rows, missing: "", total, path };
  } catch (e) {
    return { rows: [], missing: `read-failed: ${e instanceof Error ? e.message : String(e)}`, total: 0, path };
  }
}

/** [macro-fusion 0.2.116] 按 id 取几条记忆的现状（跨七层）。
 *  为什么读侧需要这个：面板要说清「上一轮报的那一对，这一轮怎么不见了」，只能看这两条**现在**长什么样
 *  （还在不在、status 是什么、updated_at 之后动过没有）；重跑一遍冲突检测不算数——那是用今天的库去猜昨天的判断。
 *  返回 { rows, missing, path }：`rows` 是 fromRow 后的真行（含 level / status / updated_at），
 *  一个 id 在七层里可能命中多条（短 id 前缀），全部带出、由调用方自己判歧义；`missing` 只在参数写坏时非空。 */
function readRowsByIds(workspace, dir = ".dsh-meow", ids = []) {
  if (typeof workspace !== "string" || workspace.length === 0) return { rows: [], missing: "no-workspace", path: "" };
  const asked = Array.isArray(ids) ? ids.map((x) => String(x ?? "").trim()).filter((x) => x !== "") : [];
  if (asked.length === 0) return { rows: [], missing: "bad-arg", path: memoryDbPath(workspace, dir) };
  const path = memoryDbPath(workspace, dir);
  if (!existsSync8(path)) return { rows: [], missing: "no-db", path };
  const cap = asked.slice(0, 20);
  try {
    const db = getDb(workspace, dir);
    const rows = [];
    for (const id of cap) {
      const matches = typeof db.findByIdAll === "function" ? db.findByIdAll(id) : [];
      for (const m of Array.isArray(matches) ? matches : []) rows.push({ ...m.row, sessionLevel: m.level });
    }
    return { rows, missing: "", path };
  } catch (e) {
    return { rows: [], missing: `read-failed: ${e instanceof Error ? e.message : String(e)}`, path };
  }
}

var LEVEL_ORDER = { project: 0, topic: 1, fact: 2, lesson: 3, rules: 4, soul: 5, user: 6 };function formatTime(t) {
  return new Date(t).toISOString().slice(0, 16).replace("T", " ");
}
function groupByProject(rows) {
  const byProject = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const list = projectList(r.project);
    const key = list.length > 0 ? list[0] : "";
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(r);
  }
  for (const list of byProject.values()) {
    list.sort((a, b) => {
      const l = LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level];
      if (l !== 0) return l;
      return a.created_at - b.created_at;
    });
  }
  return [...byProject.entries()].sort((a, b) => a[0] === "" ? 1 : b[0] === "" ? -1 : a[0].localeCompare(b[0])).map(([name2, rows2]) => ({ name: name2, rows: rows2 }));
}
function collectDreamRounds(db, sessionId, workspace, dir = ".dsh-meow", rulesReviewDays = DEFAULT_RULES_REVIEW_DAYS) {
  const seen = /* @__PURE__ */ new Set([...readSeen(workspace, sessionId, dir), ...readWritten(workspace, sessionId, dir)]);
  const atomic = [];
  const topic = [];
  for (const level of ["project", "fact", "lesson", "rules", "soul", "user"]) {
    for (const r of db.list(level)) {
      if (!(r.source_session === sessionId || seen.has(r.id))) continue;
      if (level === "rules" && rulesReviewDays > 0 && Date.now() - r.updated_at > rulesReviewDays * 864e5) continue;
      atomic.push(r);
    }
  }
  for (const r of db.list("topic")) {
    if (r.source_session === sessionId || seen.has(r.id)) topic.push(r);
  }
  const rounds = [];
  if (atomic.length > 0) rounds.push({ kind: "atomic", groups: groupByProject(atomic) });
  rounds.push({ kind: "topic", groups: groupByProject(topic) });
  const projects = /* @__PURE__ */ new Set();
  for (const r of [...atomic, ...topic]) for (const p of projectList(r.project)) projects.add(p);
  if (projects.size > 0) rounds.push({ kind: "project-summary", groups: [], projects: [...projects].sort() });
  return rounds;
}
function formatRow(r, kwLabel, noneLabel) {
  const head = r.content.replace(/\s+/g, " ").trim();
  const meta = [r.level];
  if (r.level === "project" && r.subcategory) meta.push(r.subcategory);
  if (r.title) meta.push(`\u300A${r.title}\u300B`);
  if (r.status !== "active") meta.push(r.status);
  meta.push(`${r.id} ${formatTime(r.updated_at)}`);
  const kw = (r.keywords ?? []).filter((k) => typeof k === "string" && k.length > 0);
  const kwLine = kw.length > 0 ? kw.join(", ") : noneLabel;
  return `- [${meta.join(" ")}] ${head}
  ${kwLabel} ${kwLine}`;
}
// [macro-fusion 0.2.92] dream 是全库唯一「回头看旧条目」的地方，可它的清单里从来没说清
// 「哪两条其实是同一句话」：0.2.88 的跨层重复只在**写入**时点名，0.2.90 的 repeat 只在**检索**里报。
// 整理时靠模型自己扫字面，清单几十条必然漏——而漏掉的代价是同一句话永久占两份首轮注入预算。
// 这里先用写侧同一把尺子（正文词集 Jaccard，门槛 DEDUP_THRESHOLD）把对子算出来，一行一对端上去。
// 只算本组已有的行（不跨窗口），组内两两比较：行数 ≤ 数十，词集已缓存，代价可忽略。
// [macro-fusion 0.2.92] 同一批写下的两条 id 前 8 位常常一模一样（时间戳前缀），于是重复对会印成
// 「0mwo20eo ⇄ 0mwo20eo」——读的人只能理解为「自己和自己重复」。清单里出现的短 id 必须相互可区分：
// 从 8 位起，只要和清单里任何另一个 id 撞前缀就往下延，直到不同为止。
function uniqueShortIdsAmong(rows, min = 8) {
  const ids = rows.map((r) => String(r.id ?? ""));
  const out = /* @__PURE__ */ new Map();
  for (const id of ids) {
    let n = min;
    while (n < id.length && ids.some((o) => o !== id && o.slice(0, n) === id.slice(0, n))) n++;
    out.set(id, id.slice(0, n));
  }
  return out;
}
// [macro-fusion 0.2.93] 一对重复该由哪一轮负责说：返回轮次下标（先出现的那一轮），没有则 -1。
// 这样跨 atomic / topic 的对子只印一次，而不是在两轮消息里各印一遍。
function dreamPairOwner(rounds, pair) {
  const ids = /* @__PURE__ */ new Set([String(pair.a.id ?? ""), String(pair.b.id ?? "")]);
  for (let i = 0; i < rounds.length; i++) {
    for (const g of rounds[i].groups ?? []) {
      for (const r of g.rows) if (ids.has(String(r.id ?? ""))) return i;
    }
  }
  return -1;
}
// [macro-fusion 0.2.96] 同一批行的词集要算三遍（逐字重复对、重复详写对、计划摘要），tokenize 是纯函数：
// 按「id + updated_at」记一份，三个消费者共用一张词表。改过内容的条目 updated_at 会变，读不到陈旧词集；
// 超过 4096 条整表清空（dream 一轮只有几十行，这个上限纯属防守）。
var dreamTokenMemo = new Map();
function rowTokenSet(r) {
  const key = `${String(r.id ?? "")}\u0000${String(r.updated_at ?? "")}`;
  const hit = dreamTokenMemo.get(key);
  if (hit !== void 0) return hit;
  const set = new Set(tokenize(String(r.content ?? "")));
  if (dreamTokenMemo.size > 4096) dreamTokenMemo.clear();
  dreamTokenMemo.set(key, set);
  return set;
}
var DREAM_DUP_MAX = 5;
// [macro-fusion 0.2.102] max：清单只印前 5 对（一屏够读），但「这一轮撞上几对」是个事实，
// 不能拿「列表截了几条」冒充。数的时候传 Infinity，印的时候用默认值。
function dreamDupPairs(rows, threshold = DEDUP_THRESHOLD, max = DREAM_DUP_MAX) {
  if (rows.length < 2) return [];
  const sets = rows.map(rowTokenSet);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const a = sets[i];
    if (a.size === 0) continue;
    for (let j = i + 1; j < rows.length; j++) {
      const b = sets[j];
      if (b.size === 0) continue;
      const rep = overlapOfSets(a, b);
      if (rep < threshold) continue;
      out.push({ a: rows[i], b: rows[j], repeat: Math.round(rep * 1e3) / 1e3 });
    }
  }
  out.sort((x, y) => y.repeat - x.repeat);
  return out.slice(0, max);
}
// [macro-fusion 0.2.94] 同一件事的另一种形态：一条短摘录 + 一条长详写。这种对子的逐字重复度天然很低
//（实测 15 词 ⇄ 92 词只有 0.16，15 词 ⇄ 32 词也只有 0.47），上面那块（≥80%）与写侧 DEDUP_THRESHOLD
// 都抓不到，但它们确实是同一句话存了两层，只是叠成了「摘要 + 全文」。
// 判据换成覆盖度：短的那条有几个词出现在长的那条里（取小集合做分母），再套两道闸——
// 短的那条至少要有 DREAM_COVER_MIN_WORDS 个不同的词（拦住「一个短语碰巧出现在长文里」被当成重复，
// 这条不能用长度比来挡：实测最常见的形态就是 15 词 ⇄ 92 词，比值只有 0.16）；
// 比值上限 DREAM_COVER_RATIO_MAX 拦住「两条差不多长，本就该各说各的」。
// 与 ≥80% 的逐字重复对互斥（重复度已经够高的不走这一块），同一对不会印两遍。
var DREAM_COVER_MIN = 0.9;
var DREAM_COVER_MIN_WORDS = 8;
var DREAM_COVER_RATIO_MAX = 0.75;
// [macro-fusion 0.2.95] 覆盖度只回答「是不是同一件事」，不回答「合并会不会漏字」。
// 真正的风险在短条那 10% 没落进长条的词：只让模型「合成一条」，它多半把短条整条扔掉，
// 那 10% 就跟着没了。所以把短条里长条没有的词算出来，直接写在处方行上（最多念 DREAM_MERGE_WORDS 个）。
// 一个都没有时也别留白——那正好说明这次合并是无损的，直接保留长条即可。
var DREAM_MERGE_WORDS = 6;
function missingWordsOf(smallSet, bigSet, max = DREAM_MERGE_WORDS) {
  const out = [];
  for (const w of smallSet) if (!bigSet.has(w)) out.push(w);
  out.sort((x, y) => y.length - x.length || (x < y ? -1 : x > y ? 1 : 0));
  return { total: out.length, sample: out.slice(0, max) };
}
function coverOfSets(a, b) {
  const small = a.size <= b.size ? a : b;
  const big = a.size <= b.size ? b : a;
  if (small.size === 0) return 0;
  let inter = 0;
  for (const x of small) if (big.has(x)) inter++;
  return inter / small.size;
}
function dreamCoverPairs(rows, minContain = DREAM_COVER_MIN, max = DREAM_DUP_MAX) {
  if (rows.length < 2) return [];
  const sets = rows.map(rowTokenSet);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const a = sets[i];
    if (a.size === 0) continue;
    for (let j = i + 1; j < rows.length; j++) {
      const b = sets[j];
      if (b.size === 0) continue;
      const smallWords = Math.min(a.size, b.size);
      const ratio = smallWords / Math.max(a.size, b.size);
      if (smallWords < DREAM_COVER_MIN_WORDS || ratio > DREAM_COVER_RATIO_MAX) continue;
      const cov = coverOfSets(a, b);
      if (cov < minContain) continue;
      if (overlapOfSets(a, b) >= DEDUP_THRESHOLD) continue;
      const shortRow = a.size <= b.size ? rows[i] : rows[j];
      const longRow = a.size <= b.size ? rows[j] : rows[i];
      const miss = missingWordsOf(a.size <= b.size ? a : b, a.size <= b.size ? b : a);
      out.push({ a: shortRow, b: longRow, contain: Math.round(cov * 1e3) / 1e3, ratio: Math.round(ratio * 1e3) / 1e3, missing: miss.total, words: miss.sample });
    }
  }
  out.sort((x, y) => y.contain - x.contain);
  return out.slice(0, max);
}
// [macro-fusion 0.2.114] 上面两块（逐字重复 / 重复详写）回答的都是「同一句话存了两份」。
// 还有另一种形态它们都抓不到，而那一种才是真会让记忆变错的：**同一件事写成了两种说法**。
// 例：一条说「DSH 在 C 盘」、另一条说「DSH 已经搬到 D 盘」——逐字重复度不到 30%，覆盖度也够不着
// 「摘要 + 全文」，两块都不出声，可它们一起被召回就是自相矛盾。手册里那句「冲突以时间戳最新者为准」
// 此前在代码里没有任何落地：没人检测，也就没人知道什么时候该用这条规则。
// 判据刻意窄，宁可漏也不误报（误报会让整理时的模型去改本来对的条目）：
//  ① 同题：两条关键词交集 ≥ DREAM_CONFLICT_KEYS。关键词是写记忆时亲手挑的主题标签，比正文词集
//     更能说明「说的是同一件事」；正文词集的 Jaccard 只用来排除重复，不用来判定同题。
//  ② 既不是重复（< DEDUP_THRESHOLD），也不是摘要+全文（< DREAM_COVER_MIN）——那两块各有自己的处置，
//     同一对不印两遍。
//  ③ 两条都写了数字/版本，且数字集合**不完全相同**：只有「同一件事 + 数字不一样」才有两种说法的嫌疑。
//     措辞不同而数字一致的不算冲突，那是复述。
// 不做判决：只把两种说法与更新时间摆在一起，谁新由时间戳说，改哪条由整理时的模型决断。
var DREAM_CONFLICT_MAX = 3;
var DREAM_CONFLICT_KEYS = 2;
var DREAM_CONFLICT_NUMS = 3;
var DREAM_CONFLICT_KEYS_SAMPLE = 4;
function rowKeywordSet(r) {
  const out = new Set();
  for (const k of Array.isArray(r.keywords) ? r.keywords : []) {
    const s = String(k ?? "").trim().toLowerCase();
    if (s !== "") out.add(s);
  }
  return out;
}
// 数字/版本号：0.2.113、1795165494、2026-11-20、3,826,540 都算；同一串只算一次。
function rowNumberSet(r) {
  const out = new Set();
  const re = /\d+(?:[.,:\/-]\d+)*/g;
  let m;
  while ((m = re.exec(String(r.content ?? ""))) !== null) out.add(m[0]);
  return out;
}
function sameNumberSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
function dreamConflictPairs(rows, max = DREAM_CONFLICT_MAX) {
  // 归档的那条不算：归档本身就是「这条已作废」的处置，再报一次只是催人做已经做过的事。
  const live = rows.filter((r) => String(r.status ?? "active") !== "archived");
  if (live.length < 2) return [];
  const sets = live.map(rowTokenSet);
  const kws = live.map(rowKeywordSet);
  const nums = live.map(rowNumberSet);
  const out = [];
  for (let i = 0; i < live.length; i++) {
    if (nums[i].size === 0) continue;
    for (let j = i + 1; j < live.length; j++) {
      if (nums[j].size === 0) continue;
      const shared = [];
      for (const k of kws[i]) if (kws[j].has(k)) shared.push(k);
      if (shared.length < DREAM_CONFLICT_KEYS) continue;
      if (sets[i].size === 0 || sets[j].size === 0) continue;
      if (overlapOfSets(sets[i], sets[j]) >= DEDUP_THRESHOLD) continue;
      if (coverOfSets(sets[i], sets[j]) >= DREAM_COVER_MIN) continue;
      if (sameNumberSet(nums[i], nums[j])) continue;
      const onlyA = [...nums[i]].filter((x) => !nums[j].has(x));
      const onlyB = [...nums[j]].filter((x) => !nums[i].has(x));
      const ta = Number(live[i].updated_at) || 0;
      const tb = Number(live[j].updated_at) || 0;
      out.push({
        a: live[i],
        b: live[j],
        shared: shared.slice(0, DREAM_CONFLICT_KEYS_SAMPLE),
        sharedTotal: shared.length,
        onlyA: onlyA.slice(0, DREAM_CONFLICT_NUMS),
        onlyB: onlyB.slice(0, DREAM_CONFLICT_NUMS),
        onlyACount: onlyA.length,
        onlyBCount: onlyB.length,
        newer: ta === tb ? "both" : ta > tb ? "a" : "b"
      });
    }
  }
  // 越新越靠前：整理时先看最可能正在出问题的那一对。
  const stamp = (p) => Math.max(Number(p.a.updated_at) || 0, Number(p.b.updated_at) || 0);
  out.sort((x, y) => stamp(y) - stamp(x));
  return out.slice(0, max);
}
// [macro-fusion 0.2.142] 第三种只出声不出人：一条正文写着「（已被取代：xxxx——）」，
// 而那个 xxxx 现在不在库、或者前 8 位撞了一堆认不出是谁。上面三个块都看不见它：
//   · 逐字重复 / 重复详写比的是正文相似度，可接手与被接手本来就不像；
//   · 疑似冲突比「同题不同数」，可这里压根不缺对方那半句，缺的是对方**这条记录**。
// 于是清单一直只列「该整理的地方」，而这是「已经整理坏了的地方」：链断了、或链指向了一个认不出的人。
// 判据只做两件事：① 前缀命中 0 条 → absent（那条被删/搬走了）；② 命中 ≥2 条且开头对不上 → ambiguous。
// 命中恰好 1 条、或撞车但开头能对上 → 链是好的，一个字不印（干净清单不加噪音）。
var DREAM_CHAIN_MAX = 6;
var SUPERSEDE_MARK_D = "（已被取代：";
function chainMarkOf(text) {
  const s = String(text ?? "");
  const at = s.indexOf(SUPERSEDE_MARK_D);
  if (at < 0) return null;
  const rest = s.slice(at + SUPERSEDE_MARK_D.length);
  const idm = /^\s*([0-9a-z]{4,})/.exec(rest);
  if (idm === null) return null;
  const headm = /^[0-9a-z]{4,}「([^」]*)」/.exec(rest);
  const daym = /[，,]\s*(\d{4}-\d{1,2}-\d{1,2})\s*[）)]/.exec(rest);
  return { id8: idm[1].slice(0, 8), head: headm?.[1] ?? "", day: daym?.[1] ?? "" };
}
function chainHeadOf(text) {
  const first = String(text ?? "").split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  return first.length > 28 ? `${first.slice(0, 28)}…` : first;
}
function chainHeadMatch(a, b) {
  const x = String(a ?? "").replace(/…$/, "").trim();
  const y = String(b ?? "").replace(/…$/, "").trim();
  if (x === "" || y === "") return false;
  return x.startsWith(y) || y.startsWith(x);
}
function dreamChainIssues(allRows, db) {
  const claims = [];
  for (const r of allRows) {
    const mark = chainMarkOf(r.content);
    if (mark !== null) claims.push({ row: r, mark });
  }
  // 全库扫一遍只在真有 claim 时才付——没有断链的清单，一分钱不多花。
  if (claims.length === 0) return { list: [], total: 0 };
  const index = new Map();
  for (const level of LEVELS) {
    const list = db.list(level, {});
    for (const r of Array.isArray(list) ? list : []) {
      const key = String(r.id ?? "").slice(0, 8);
      const arr = index.get(key);
      if (arr === undefined) index.set(key, [r]); else arr.push(r);
    }
  }
  const out = [];
  for (const one of claims) {
    const hits = index.get(one.mark.id8) ?? [];
    // 撞车是常态（同秒写入前 8 位必然相同），所以先按开头筛：取代句里的开头就是为这一刻留的。
    const sure = hits.length > 1 && one.mark.head !== ""
      ? hits.filter((r) => chainHeadMatch(chainHeadOf(r.content), one.mark.head))
      : hits;
    if (sure.length === 1) continue;
    out.push({
      id: String(one.row.id ?? ""),
      level: String(one.row.level ?? ""),
      status: String(one.row.status ?? ""),
      who: one.mark.id8,
      head: one.mark.head,
      day: one.mark.day,
      hits: hits.length,
      // 三态要按「库里到底有没有这个前缀」分，不能按开头筛完剩几条分：
      // 撞车但开头一个都对不上时，sure 也是 0——那是「认不出是谁」，不是「那条不在了」。
      state: hits.length === 0 ? "absent" : "ambiguous",
      at: Number(one.row.updated_at) || 0
    });
  }
  out.sort((x, y) => y.at - x.at);
  return { list: out.slice(0, DREAM_CHAIN_MAX), total: out.length };
}
// [macro-fusion 0.2.144] dream 的三块检测器（逐字重复 / 重复详写 / 疑似冲突）都只在本轮行里互相比，
// 全库从不参与：新写一条与三个月前那条一字不差，dream 一句话都不说——冗余就这么一层层叠上去。
// 这里补「这轮写的，库里早有了」：候选只从关键字与正文前缀建的索引里取（不做 N×M 全比），
// 重复度按 token 集合覆盖算，与本轮内部那两块互不重叠（同为逐字重复时只由 dupPairs 负责）。
var DREAM_REPEAT_MAX = 4;
var DREAM_REPEAT_MIN = 0.8;
var DREAM_REPEAT_SCAN = 40;
function dreamRepeatIssues(allRows, db) {
  if (allRows.length === 0) return { list: [], total: 0, scanned: 0 };
  if (!db || typeof db.list !== "function") return { list: [], total: 0, scanned: 0 };
  const here = new Set(allRows.map((r) => String(r.id)));
  const byHead = /* @__PURE__ */ new Map();
  const byKw = /* @__PURE__ */ new Map();
  let scanned = 0;
  for (const level of LEVELS) {
    let rows = [];
    try {
      rows = db.list(level, {}) || [];
    } catch {
      rows = [];
    }
    for (const r of rows) {
      if (here.has(String(r.id))) continue;
      scanned++;
      const head = String(r.content ?? "").slice(0, 8);
      if (head.length >= 4) {
        const arr = byHead.get(head);
        if (arr === void 0) byHead.set(head, [r]);
        else arr.push(r);
      }
      for (const kw of Array.isArray(r.keywords) ? r.keywords : []) {
        const k = String(kw).slice(0, 12);
        if (k.length === 0) continue;
        const arr = byKw.get(k);
        if (arr === void 0) byKw.set(k, [r]);
        else arr.push(r);
      }
    }
  }
  const out = [];
  for (const row of allRows) {
    const set = rowTokenSet(row);
    if (set.size === 0) continue;
    const cands = /* @__PURE__ */ new Map();
    for (const r of byHead.get(String(row.content ?? "").slice(0, 8)) ?? []) cands.set(String(r.id), r);
    for (const kw of Array.isArray(row.keywords) ? row.keywords : []) {
      for (const r of byKw.get(String(kw).slice(0, 12)) ?? []) cands.set(String(r.id), r);
    }
    if (cands.size === 0) continue;
    let best = null;
    let n = 0;
    for (const r of cands.values()) {
      if (n++ >= DREAM_REPEAT_SCAN) break;
      const rep = overlapOfSets(set, rowTokenSet(r));
      if (rep < DREAM_REPEAT_MIN) continue;
      if (best === null || rep > best.repeat) best = { other: r, repeat: Math.round(rep * 1e3) / 1e3 };
    }
    if (best === null) continue;
    out.push({
      id: row.id,
      level: row.level,
      otherId: best.other.id,
      otherLevel: best.other.level,
      otherStatus: String(best.other.status ?? "active"),
      otherDay: formatTime(Number(best.other.updated_at) || 0),
      repeat: best.repeat,
      at: Number(row.updated_at ?? 0) || 0
    });
  }
  out.sort((a, b) => b.repeat - a.repeat || b.at - a.at);
  return { list: out.slice(0, DREAM_REPEAT_MAX), total: out.length, scanned };
}
// 渲染这一段：没有「库里已经有了」就返回空串。
function dreamRepeatBlock(result, shortOf, lbl3) {
  const list = Array.isArray(result?.list) ? result.list : [];
  if (list.length === 0) return "";
  const short = (id) => (shortOf instanceof Map ? String(shortOf.get(String(id)) ?? String(id).slice(0, 8)) : String(id).slice(0, 8));
  const lines = list.map((it) => {
    const head = lbl3("dream.repeat.line", {
      id: short(it.id),
      level: String(it.level ?? ""),
      oid: short(it.otherId),
      olevel: String(it.otherLevel ?? ""),
      day: String(it.otherDay ?? ""),
      status: String(it.otherStatus ?? "active"),
      pct: String(Math.round(Number(it.repeat) * 100))
    });
    const verdict = it.otherStatus === "active" ? lbl3("dream.repeat.keep", { oid: short(it.otherId) }) : lbl3("dream.repeat.revive", { oid: short(it.otherId) });
    return `- ${head}\n  ${verdict}`;
  });
  const total = Number(result?.total ?? list.length) || list.length;
  const more = total > list.length ? `\n${lbl3("dream.repeat.more", { n: String(total - list.length) })}` : "";
  return `
${lbl3("dream.repeat.title", { n: String(total) })}
${lines.join("\n")}${more}
${lbl3("dream.repeat.rule", {})}`;
}
// [macro-fusion 0.2.143] 相关度下限按分数裁，可分数排的是「措辞贴不贴这次提问」，不是「谁接了班」：
// 一条退位的旧说法字面很贴、分很高进了榜，接手它的新说法措辞朴素、掉到下限以下被裁掉——
// 于是读者只看到已经作废的那条，越照着它改越错。所以下限裁完之后要回看一眼：被裁的那几条里，
// 有没有哪条正是榜上某条的接手者？有就提上来（最多 LIFT_MAX 条，顺序仍按分数排）。
// 认不出是谁（同前缀多条、开头都对不上）就不动——提错人比不提更坏。
var LIFT_MAX = 3;
function liftSuccessors(shown, cut) {
  if (shown.length === 0 || cut.length === 0) return [];
  const out = [];
  for (const h of shown) {
    const mark = chainMarkOf(h.content);
    if (mark === null) continue;
    const cand = cut.filter((c) => String(c.id ?? "").slice(0, 8) === mark.id8);
    if (cand.length === 0) continue;
    const sure = cand.length > 1 && mark.head !== ""
      ? cand.filter((c) => chainHeadMatch(chainHeadOf(c.content), mark.head))
      : cand;
    if (sure.length !== 1) continue;
    const one = sure[0];
    if (out.some((x) => String(x.id) === String(one.id))) continue;
    if (out.length >= LIFT_MAX) break;
    out.push(one);
  }
  return out;
}
// 渲染这一段：没有断链就返回空串（干净清单一个字不加）。抽成纯函数是为了探针能直接验文案，
// 不用为了看一句话去造一整个 dream 轮次。
function dreamChainBlock(result, shortOf, lbl3) {
  const here = Array.isArray(result?.list) ? result.list : [];
  const total = Number(result?.total) || 0;
  if (here.length === 0) return "";
  const more = total > here.length ? `\n${lbl3("dream.chain.more", { n: String(total - here.length) })}` : "";
  return `
${lbl3("dream.chain.title", { n: String(total) })}
${here.map((it) => {
    const sid = typeof shortOf?.get === "function" ? shortOf.get(String(it.id)) : String(it.id).slice(0, 8);
    const head = `- ${sid} \xB7 ${it.level} \xB7 ${it.who}${it.head === "" ? "" : `\u300C${it.head}\u300D`}${it.day === "" ? "" : `\uFF08${it.day}\uFF09`}`;
    const said = it.state === "absent"
      ? lbl3("dream.chain.absent", { who: it.who, day: it.day })
      : lbl3("dream.chain.ambiguous", { who: it.who, day: it.day, hits: String(it.hits), head: it.head });
    return `${head}\n  ${said}`;
  }).join("\n")}${more}
${lbl3("dream.chain.rule", {})}`;
}
// [macro-fusion 0.2.96] dream 整理完什么都不留：claimDream 只防重复整理，logDream 只记「done + 轮数」，
// 主人在面板与回执里都看不到「这一轮翻了多少条、撞上几对、有几对合并会丢字」。模型自己也无从预判规模。
// 这段把清单本身算成一串数字——用的是后面真正印块的那两个函数，不另立口径——① 起 dream 时随回执说给模型听，
// ② 收尾时随 dream_log.changes 落库，事后能对账；③ 中断/失败也留着上一条摘要，不必重算。
// [macro-fusion 0.2.102] 两件真问题，都在「落库的那份摘要」上：
//  ① 0.2.101 的面板开始按项目名筛账（json_extract(changes,'$.plan.projects') 配 json_each），
//     可这里存的一直是**个数**。json_each 对数字只产出一行 value=数字（实测 integer 3），
//     于是真账本上按名字筛永远是「没有这个项目段的账」——而探针里手写的 changes 是数组，所以当时全绿。
//  ② 账本只记「撞上几对」，不记「跟谁撞」。0.2.100 的单条展开能把账摊开，摊开也只有数字，
//     想动手合并还得回去翻那次 dream 的消息（早被压缩掉了）。
// 现在：projects 存名字数组（去重保序、空名丢掉），个数另存 projectCount 保住老口径；pairs 存前几对明细
// （短 id 与清单里印的是同一套 uniqueShortIdsAmong，能直接拿去 memory_read）。
// 另外 dup / cover 的数改成不截断的真值：清单只印 5 对是一回事，「这一轮一共撞上几对」是另一回事。
var DREAM_PLAN_PAIR_CAP = 6;
function dreamPlanProjectNames(rounds) {
  const out = [];
  for (const r of rounds) {
    if (!Array.isArray(r.projects)) continue;
    for (const p of r.projects) {
      const name = String(p ?? "").trim();
      if (name !== "" && !out.includes(name)) out.push(name);
    }
  }
  return out;
}
function dreamPlanPairs(allRows) {
  const shortOf = uniqueShortIdsAmong(allRows);
  const named = (row) => String(shortOf.get(String(row.id ?? "")) ?? String(row.id ?? ""));
  const level = (row) => String(row.level ?? "");
  const out = [];
  for (const p of dreamDupPairs(allRows, DEDUP_THRESHOLD, Infinity)) {
    out.push({ kind: "dup", a: named(p.a), b: named(p.b), levelA: level(p.a), levelB: level(p.b), score: p.repeat });
  }
  for (const p of dreamCoverPairs(allRows, DREAM_COVER_MIN, Infinity)) {
    out.push({
      kind: "cover",
      a: named(p.a),
      b: named(p.b),
      levelA: level(p.a),
      levelB: level(p.b),
      score: p.contain,
      missing: Number(p.missing) || 0,
      words: Array.isArray(p.words) ? p.words.slice(0, DREAM_MERGE_WORDS) : []
    });
  }
  return out.slice(0, DREAM_PLAN_PAIR_CAP);
}
// [macro-fusion 0.2.114] 账本明细里记一对疑似冲突，与重复对不是同一种卡片：
// 重复对问「要不要并成一条」，冲突对问「两条说法哪里不一样、谁更新」——所以只记差异与时间，不记判决。
// newerAt 记的是「新那条」的更新时间（时间一样就记两者相等的那一个，读侧据此说「分不出谁新」）。
function dreamPlanConflicts(allRows) {
  const shortOf = uniqueShortIdsAmong(allRows);
  const named = (row) => String(shortOf.get(String(row.id ?? "")) ?? String(row.id ?? ""));
  const out = [];
  for (const p of dreamConflictPairs(allRows, Infinity)) {
    const ta = Number(p.a.updated_at) || 0;
    const tb = Number(p.b.updated_at) || 0;
    const win = p.newer === "a" ? p.a : p.newer === "b" ? p.b : null;
    out.push({
      kind: "conflict",
      a: named(p.a),
      b: named(p.b),
      levelA: String(p.a.level ?? ""),
      levelB: String(p.b.level ?? ""),
      shared: p.shared,
      sharedTotal: p.sharedTotal,
      onlyA: p.onlyA,
      onlyB: p.onlyB,
      onlyACount: p.onlyACount,
      onlyBCount: p.onlyBCount,
      newer: p.newer,
      newerAt: win === null ? Math.max(ta, tb) : Number(win.updated_at) || 0
    });
  }
  return out.slice(0, DREAM_PLAN_PAIR_CAP);
}
function dreamPlanDigest(rounds) {
  const rowsOf = (r) => (Array.isArray(r.groups) ? r.groups.flatMap((g) => (Array.isArray(g.rows) ? g.rows : [])) : []);
  const allRows = rounds.flatMap(rowsOf);
  const covers = dreamCoverPairs(allRows, DREAM_COVER_MIN, Infinity);
  // 数的时候传 Infinity：清单印几张是排版，撞上几对是事实（0.2.102 的教训）。
  const conflicts = dreamConflictPairs(allRows, Infinity);
  return {
    rounds: rounds.length,
    groups: rounds.reduce((n, r) => n + (Array.isArray(r.groups) ? r.groups.length : 0), 0),
    rows: allRows.length,
    dup: dreamDupPairs(allRows, DEDUP_THRESHOLD, Infinity).length,
    cover: covers.length,
    missing: covers.reduce((n, p) => n + (Number(p.missing) || 0), 0),
    projects: dreamPlanProjectNames(rounds),
    projectCount: rounds.reduce((n, r) => n + (Array.isArray(r.projects) ? r.projects.length : 0), 0),
    // [macro-fusion 0.2.114] 疑似冲突：与 dup/cover 分开两个字段。dup 与 cover 是「同一句话存了两份」，
    // 读侧拿 dup+cover 对账落了几对卡片；冲突是另一种病，混进同一个计数会让「对子没落账」那句误报。
    conflicts: conflicts.length,
    pairs: dreamPlanPairs(allRows),
    conflictPairs: dreamPlanConflicts(allRows)
  };
}
// [macro-fusion 0.2.103] 账本原来只记「这一轮翻了几条」（清单里的行），不记「库本身有多大」。
// 翻 20 条是翻，可库是 800 条还是 40 条，读账的人分不出来——整理到底让库变轻还是变重，账上没答案。
// 口径三件事：①只数 status='active'，归档/stale 的账在 status 上，不该混进「库有多大」；
// ②取的是**开工那一刻**，不是收尾之后（收尾时模型才动手改库，那之后的结果要等下一轮账才知道）；
// ③只留非零的层，别在 JSON 里塞一排 0 让读的人以为「空层也算数」。
// [macro-fusion 0.2.111] 规模原来只按层（byLevel），答不了「是哪个项目在涨」：Alpha 一直在长、
// Beta 一直在掉，层走向上 fact 只是个净数。按项目数一次，但要说清口径——
// ①七个层里只有五个带 project 列（project / fact / lesson / topic / rules），soul 与 user 没有归属，
//   这两层永远不进这条数；②NULL 与空串不是一个项目（全局条目不占名字）；
// ③同一层同名的合并相加，跨层同名也相加（读者问的是「这个项目一共多少条」）。
var PROJECT_LAYERS = ["project", "fact", "lesson", "topic", "rules"];
function dreamStoreProjects(db) {
  const byProject = {};
  for (const level of PROJECT_LAYERS) {
    let rows = [];
    try {
      rows = db.p(`SELECT project AS name, COUNT(*) AS n FROM ${level} WHERE status = 'active' GROUP BY project`).all();
    } catch {
      rows = [];
    }
    for (const row of rows) {
      const name = String(row?.name ?? "").trim();
      const n = Number(row?.n) || 0;
      if (name === "" || n <= 0) continue;
      byProject[name] = (byProject[name] || 0) + n;
    }
  }
  return byProject;
}
function dreamStoreScale(db) {
  const byLevel = {};
  let active = 0;
  for (const level of LEVELS) {
    let n = 0;
    try {
      const row = db.p(`SELECT COUNT(*) AS n FROM ${level} WHERE status = 'active'`).get();
      n = Number(row?.n) || 0;
    } catch {
      n = 0;
    }
    if (n > 0) byLevel[level] = n;
    active += n;
  }
  const byProject = dreamStoreProjects(db);
  const out = { active, byLevel };
  // 一个项目都没有就不写这一格：空对象塞进 JSON 只会让人以为「数过、结果是零个项目」。
  if (Object.keys(byProject).length > 0) out.byProject = byProject;
  return out;
}
// 回执那句话：四个数字全部来自上面那份摘要，一个也不手写；只有真有字要补时才加第二句。
function dreamReceipt(digest) {
  if (digest === void 0 || digest === null || typeof digest !== "object") return "";
  const lbl4 = (key, params) => fillTemplate(keyedValue("labels", key), params);
  const head = lbl4("dream.plan", {
    rounds: String(digest.rounds),
    rows: String(digest.rows),
    dup: String(digest.dup),
    cover: String(digest.cover)
  });
  const miss = Number(digest.missing) > 0 ? lbl4("dream.plan.missing", { missing: String(digest.missing) }) : "";
  // [macro-fusion 0.2.114] 疑似冲突也进回执：这是「这次整理同时发现了两种说法的记忆」，
  // 与「合并会丢 N 个词」一样属于该立刻被看见、而不是要展开账才看见的东西。
  const conf = Number(digest.conflicts) > 0 ? lbl4("dream.plan.conflicts", { n: String(digest.conflicts) }) : "";
  return [head, miss, conf].filter((s) => s !== "").join("\n");
}
function buildDreamMessage(db, sessionId, T2, rounds, idx) {
  const round = rounds[idx];
  const lbl3 = (key, params) => fillTemplate(keyedValue("labels", key), params);
  const groupMarker = `[meow-dream-group ${idx + 1}/${rounds.length} ${lbl3(`dream.round.${round.kind}`)}]`;
  const lines = [
    `${DREAM_MARKER} ${lbl3("dream.title")}`,
    "",
    ...resolveSlotText("dream-header", {
      timestamp: formatTime(T2),
      idx: String(idx + 1),
      total: String(rounds.length),
      roundKind: lbl3(`dream.round.${round.kind}`)
    }).split("\n"),
    ""
  ];
  if (round.kind === "project-summary") {
    lines.push(...resolveSlotText("dream-project-summary", { projects: (round.projects ?? []).join("\u3001"), groupMarker }).split("\n"));
  } else {
    const kwLabel = lbl3("dream.row.keywordsLabel");
    const noneLabel = lbl3("dream.row.none");
    const groupsText = round.groups.map((g) => {
      const name2 = g.name === "" ? lbl3("dream.groupUnlabeled") : g.name;
      return `${lbl3("dream.groupHeader", { name: name2 })}
${g.rows.map((r) => formatRow(r, kwLabel, noneLabel)).join("\n")}`;
    }).join("\n\n");
    const listBlock = round.groups.length === 0 ? `
${lbl3("dream.topic.empty")}` : `

${groupsText}`;
    // [macro-fusion 0.2.92] 逐字重复对：只在算出来的时候出现，没对子就一个字不加（干净清单不加噪音）。
    // [macro-fusion 0.2.93] 0.2.92 只在**本组**里两两比：atomic 与 topic 是两次独立的消息，同一句话
    // 一条记成 fact、一条记成 topic 时两者永远碰不到一起——写侧 crossLevelDupe 早就能抓（它扫全部层），
    // dream 又漏一次。现在整个 dream 范围的行一起算对子，只由「在轮次里先出现的那一轮」负责展示：
    // 同一对只印一次（两轮都印一遍等于白烧一份 token，还会让模型以为有两对）。
    const roundRows = round.groups.flatMap((g) => g.rows);
    const allRows = rounds.filter((r) => Array.isArray(r.groups)).flatMap((r) => r.groups.flatMap((g) => g.rows));
    const roundIds = new Set(roundRows.map((r) => String(r.id ?? "")));
    const dupPairs = dreamDupPairs(allRows).filter((p) => dreamPairOwner(rounds, p) === idx);
    const shortOf = uniqueShortIdsAmong(allRows);
    const dupBlock = dupPairs.length === 0 ? "" : `
${lbl3("dream.dup.title", { n: String(dupPairs.length), threshold: String(Math.round(DEDUP_THRESHOLD * 100)) })}
${dupPairs.map((p) => {
      const pairLine = `- ${shortOf.get(String(p.a.id))} \u21C4 ${shortOf.get(String(p.b.id))}  ${p.repeat.toFixed(2)} \xB7 ${p.a.level} \u21C4 ${p.b.level}`;
      const inThisRound = roundIds.has(String(p.a.id)) && roundIds.has(String(p.b.id));
      return inThisRound ? pairLine : `${pairLine}\uFF08${lbl3("dream.dup.crossRound")}\uFF09`;
    }).join("\n")}
${lbl3("dream.dup.rule", { threshold: String(Math.round(DEDUP_THRESHOLD * 100)) })}`;
    // [macro-fusion 0.2.94] 重复详写对：一短一长、短的那条几乎整句都在长的那条里。
    // 与上面那块互斥（≥80% 的已报过），所以同一对不会印两遍。
    const coverPairs = dreamCoverPairs(allRows).filter((p) => dreamPairOwner(rounds, p) === idx);
    const coverBlock = coverPairs.length === 0 ? "" : `
${lbl3("dream.cover.title", { n: String(coverPairs.length), contain: String(Math.round(DREAM_COVER_MIN * 100)) })}
${coverPairs.map((p) => {
      const line = `- ${shortOf.get(String(p.a.id))} \u2282 ${shortOf.get(String(p.b.id))}  ${p.contain.toFixed(2)} \xB7 ${p.a.level} \u21D2 ${p.b.level}`;
      const inThis = roundIds.has(String(p.a.id)) && roundIds.has(String(p.b.id));
      const head = inThis ? line : `${line}\uFF08${lbl3("dream.dup.crossRound")}\uFF09`;
      // [macro-fusion 0.2.95] 处方行：短条里长条没有的词，就是合并时可能丢掉的那部分。
      const recipe = p.missing === 0
        ? lbl3("dream.cover.keepNone")
        : lbl3("dream.cover.keep", { n: String(p.missing), words: p.words.join("\u3001") });
      return `${head}\n  ${recipe}`;
    }).join("\n")}
${lbl3("dream.cover.rule", { contain: String(Math.round(DREAM_COVER_MIN * 100)) })}`;
    // [macro-fusion 0.2.114] 疑似冲突块：同一主题、数字/版本却不一样的两条，摆在一起而不是判一条死刑。
    // ① 与上面两块不是同一类问题，所以单独成块、单独一句话交接；
    // ② 一样按「先出现的那一轮负责说」去重，跨轮的标一句，不会两轮各印一遍；
    // ③ 谁新由 updated_at 说（时间一样就说「分不出」），改哪条由整理时的模型决断——检测器不替它改库。
    const conflictPairs = dreamConflictPairs(allRows).filter((p) => dreamPairOwner(rounds, p) === idx);
    const moreOf = (shown, total) => (total > shown ? lbl3("dream.conflict.more", { n: String(total - shown) }) : "");
    const conflictBlock = conflictPairs.length === 0 ? "" : `
${lbl3("dream.conflict.title", { n: String(conflictPairs.length), keys: String(DREAM_CONFLICT_KEYS) })}
${conflictPairs.map((p) => {
      const idA = String(shortOf.get(String(p.a.id)));
      const idB = String(shortOf.get(String(p.b.id)));
      const head = `- ${idA} \u21C4 ${idB}  ${p.a.level} \u21C4 ${p.b.level}${roundIds.has(String(p.a.id)) && roundIds.has(String(p.b.id)) ? "" : `\uFF08${lbl3("dream.dup.crossRound")}\uFF09`}`;
      const kwLine = lbl3("dream.conflict.keywords", { words: p.shared.join("\u3001"), more: moreOf(p.shared.length, p.sharedTotal) });
      const sideLines = [];
      if (p.onlyA.length > 0) sideLines.push(lbl3("dream.conflict.only", { id: idA, nums: p.onlyA.join("\u3001"), more: moreOf(p.onlyA.length, p.onlyACount) }));
      if (p.onlyB.length > 0) sideLines.push(lbl3("dream.conflict.only", { id: idB, nums: p.onlyB.join("\u3001"), more: moreOf(p.onlyB.length, p.onlyBCount) }));
      const verdict = p.newer === "both"
        ? lbl3("dream.conflict.same", { time: formatTime(Math.max(Number(p.a.updated_at) || 0, Number(p.b.updated_at) || 0)) })
        : lbl3("dream.conflict.newer", {
            id: String(shortOf.get(String((p.newer === "a" ? p.a : p.b).id))),
            time: formatTime(Number((p.newer === "a" ? p.a : p.b).updated_at) || 0)
          });
      return [head, `  ${kwLine}`, ...sideLines.map((s) => `  ${s}`), `  ${verdict}`].join("\n");
    }).join("\n")}
${lbl3("dream.conflict.rule", {})}`;
    // [macro-fusion 0.2.142] 链体检块：接手者不在了、或前缀撞车认不出是谁——这两件事上面三块都看不见，
    // 而它们不是「该整理」，是「已经断了」。照样按「这条落在哪一轮就由哪一轮说」分摊，不会每组各印一遍。
    const chainAll = dreamChainIssues(allRows, db);
    const chainHere = chainAll.list.filter((it) => roundIds.has(String(it.id)));
    const chainBlock = dreamChainBlock({ list: chainHere, total: chainAll.total }, shortOf, lbl3);
    // [macro-fusion 0.2.144] 「这轮写的，库里早有了」——duplicate 那两块只看本轮，全库从不参与。
    const repeatAll = dreamRepeatIssues(allRows, db);
    const repeatHere = repeatAll.list.filter((it) => roundIds.has(String(it.id)));
    const repeatBlock = dreamRepeatBlock({ list: repeatHere, total: repeatAll.total }, shortOf, lbl3);
    lines.push(...resolveSlotText(round.kind === "topic" ? "dream-topic" : "dream-atomic", { list: listBlock + dupBlock + repeatBlock + coverBlock + conflictBlock + chainBlock, groupMarker }).split("\n"));
  }
  return createUserMessage({ content: [{ type: "text", text: lines.join("\n") }], source: PLUGIN_SOURCE });
}
var DREAM_LEASE_MS = 30 * 6e4;
var DREAM_MAX_ATTEMPTS = 3;
var liveAgents = /* @__PURE__ */ new Map();
function registerLiveAgent(agent) {
  const id = agent.session?.header?.id;
  if (typeof id === "string" && id.length > 0) liveAgents.set(id, agent);
}
function newDreamOwner() {
  return `${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
}
var DREAM_RETRIGGER_COOLDOWN_MS = 6 * 36e5;
function windowNeedsDream(w, now = Date.now()) {
  if (now - w.last_event_time > 24 * 36e5) return false;
  const lastDream = w.last_dream_time ?? 0;
  if (lastDream >= w.last_event_time) return false;
  if (lastDream > 0 && now - lastDream < DREAM_RETRIGGER_COOLDOWN_MS) return false;
  return true;
}
function safeSteer(agent, msg, workspace, dir, tag) {
  const steer = agent?.steer;
  if (typeof steer !== "function") return false;
  try {
    steer.call(agent, msg);
    return true;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    dreamLog(workspace, dir, `${tag} steer-failed err=${text}`);
    console.warn(`[meow-memory] ${tag}: agent.steer failed, dream skipped (${text})`);
    return false;
  }
}
var memoryTurnEnqueuedHook;
function setMemoryTurnEnqueuedHook(fn) {
  memoryTurnEnqueuedHook = fn;
}
var setMemoryTurnEnqueuedHookForTest = setMemoryTurnEnqueuedHook;
function sendMemoryTurn(agent, msg, workspace, dir, tag) {
  const followup = agent?.followup;
  if (typeof followup !== "function") return safeSteer(agent, msg, workspace, dir, tag);
  try {
    followup.call(agent, msg);
    memoryTurnEnqueuedHook?.(agent);
    return true;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    dreamLog(workspace, dir, `${tag} followup-failed err=${text}`);
    console.warn(`[meow-memory] ${tag}: agent.followup failed, memory task skipped (${text})`);
    return false;
  }
}
var DREAM_HEARTBEAT_MS = 6e4;
var HEARTBEAT_MAX_MS = 6 * 36e5;
var dreamHeartbeats = /* @__PURE__ */ new Map();
function armDreamHeartbeat(sessionId, workspace, dir) {
  if (dreamHeartbeats.has(sessionId)) return;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const hb = dreamHeartbeats.get(sessionId);
    if (hb === void 0) return;
    try {
      if (Date.now() - hb.startedAt > HEARTBEAT_MAX_MS || !getDb(workspace, dir).touchDreamLease(sessionId)) {
        stopDreamHeartbeat(sessionId);
      }
    } catch {
      stopDreamHeartbeat(sessionId);
    }
  }, DREAM_HEARTBEAT_MS);
  if (typeof timer === "object" && timer !== null && typeof timer.unref === "function") timer.unref();
  dreamHeartbeats.set(sessionId, { timer, startedAt });
}
function stopDreamHeartbeat(sessionId) {
  const hb = dreamHeartbeats.get(sessionId);
  if (hb === void 0) return;
  dreamHeartbeats.delete(sessionId);
  clearInterval(hb.timer);
}
function disposeDreamHeartbeats() {
  for (const sid of [...dreamHeartbeats.keys()]) stopDreamHeartbeat(sid);
}
function startWindowDream(ctx, agent, workspace, dir = ".dsh-meow", onDreamState, rulesReviewDays = DEFAULT_RULES_REVIEW_DAYS, trace) {
  // [macro-fusion 0.2.48] 这个函数有四种停下的原因，原来只回一个 false，
  // 工具层只好用「有没有 lease」猜，猜错的那一支把「没送出去」说成「没有需要整理的记忆」。
  // 加一个可选的 trace 收集器（只有 memory_dream 传），老调用方一个都不用改。
  const say = (reason) => {
    if (trace !== void 0 && trace !== null) trace.reason = reason;
    return false;
  };
  const sessionId = agent.session?.header?.id;
  if (!sessionId) return say("noSessionId");
  const db = getDb(workspace, dir);
  const rounds = collectDreamRounds(db, sessionId, workspace, dir, rulesReviewDays);
  if (rounds.length === 0) {
    db.finishDream(sessionId, Date.now());
    dreamLog(workspace, dir, `dream skip-empty sid=${shortSessionId(sessionId)}`);
    onDreamState?.(sessionId, "dreamed");
    return say("noRounds");
  }
  const win = db.getWindow(sessionId);
  const T2 = win && win.last_event_time > 0 ? win.last_event_time : Date.now();
  if (!db.claimDream(sessionId, newDreamOwner(), T2, DREAM_LEASE_MS)) return say("claimed");
  db.setDreamMeta(`dreamplan:${sessionId}`, JSON.stringify(rounds));
  // [macro-fusion 0.2.96] 先把这轮的规模算成一份摘要：回执要念给模型听，落库要留给事后对账。
  // 只在真的 claim 成功之后算——被 claimed 挡回来的那次不该为一个不会跑的整理烧一遍分词。
  const digest = dreamPlanDigest(rounds);
  // [macro-fusion 0.2.103] 库规模只在这一刻取一次：再晚模型就已经动手改库了，取到的就不是「整理前」。
  digest.store = dreamStoreScale(db);
  db.setDreamMeta(`dreamdigest:${sessionId}`, JSON.stringify(digest));
  if (trace !== void 0 && trace !== null) trace.digest = digest;
  // [macro-fusion 0.2.99] 开始整理时把规模一起广播出去：月亮图标在整理过程中就能说
  // 「这一轮看到几条」，而不是等收尾再从 dream_log 里读。第三个参数是加法，
  // 老消费方（只认 state）忽略它照样工作。
  onDreamState?.(sessionId, "dreaming", { plan: digest });
  const msg = buildDreamMessage(db, sessionId, T2, rounds, 0);
  if (!sendMemoryTurn(agent, msg, workspace, dir, `dream start sid=${shortSessionId(sessionId)}`)) {
    db.releaseDream(sessionId);
    return say("sendFailed");
  }
  if (trace !== void 0 && trace !== null) trace.reason = "started";
  armDreamHeartbeat(sessionId, workspace, dir);
  dreamLog(workspace, dir, `dream start pid=${process.pid} session=${shortSessionId(sessionId)} rounds=${rounds.length} plan rows=${digest.rows} dup=${digest.dup} cover=${digest.cover} missing=${digest.missing} T=${T2}`);
  return true;
}
function advanceDream(agent, dir = ".dsh-meow", onDreamState, rulesReviewDays = DEFAULT_RULES_REVIEW_DAYS) {
  const sessionId = agent?.session?.header?.id;
  const ws = agent?.session?.header?.cwd;
  if (typeof sessionId !== "string" || typeof ws !== "string" || ws.length === 0) return;
  const db = getDb(ws, dir);
  const lease = db.getDreamLease(sessionId);
  if (lease === null) return;
  if (Date.now() - lease.progress_at > DREAM_LEASE_MS) {
    recoverInterruptedDream(db, sessionId, ws, dir);
    dreamLog(ws, dir, `advanceDream expired-recover sid=${shortSessionId(sessionId)}`);
    const wAfter = db.getWindow(sessionId);
    onDreamState?.(sessionId, wAfter !== void 0 && wAfter.last_dream_time !== null ? "dreamed" : "active");
    return;
  }
  const storedPlan = db.getDreamMeta(`dreamplan:${sessionId}`);
  const rounds = storedPlan !== void 0 ? JSON.parse(storedPlan) : collectDreamRounds(db, sessionId, ws, dir, rulesReviewDays);
  const nextIdx = lease.group_idx + 1;
  if (nextIdx < rounds.length) {
    if (db.advanceDreamLease(sessionId, lease.group_idx, DREAM_LEASE_MS)) {
      armDreamHeartbeat(sessionId, ws, dir);
      const msg = buildDreamMessage(db, sessionId, lease.T, rounds, nextIdx);
      const tag = `dream group ${nextIdx + 1}/${rounds.length}`;
      if (safeSteer(agent, msg, ws, dir, tag)) dreamLog(ws, dir, `${tag} steered`);
    }
    return;
  }
  finalizeDream(db, sessionId, ws, dir, lease.T, "done", rounds.length, onDreamState);
}
function finalizeDream(db, sessionId, workspace, dir, T2, reason, groupsCount, onDreamState) {
  stopDreamHeartbeat(sessionId);
  try {
    // [macro-fusion 0.2.107] 收尾方式落成结构化字段：以前只有 summary 里那个词（done / aborted）
    // 能分辨这一轮是跑完了还是半路停下，读账的面板只能照抄一个字，连「走了几组、还剩几组」都答不上。
    // 分母必须在这里读——finishDream 会顺手删掉 dreamplan，晚一步就只剩分子了。
    let groupsTotal = 0;
    try {
      const rawRounds = db.getDreamMeta(`dreamplan:${sessionId}`);
      if (rawRounds !== void 0) {
        const parsed = JSON.parse(rawRounds);
        if (Array.isArray(parsed)) groupsTotal = parsed.length;
      }
    } catch {
      groupsTotal = 0;
    }
    const kind = reason === "aborted" ? { kind: "aborted", groupsDone: Math.max(0, groupsCount - 1), groupsTotal } : { kind: "done" };
    const stamped = db.stampDream(sessionId, T2);
    db.finishDream(sessionId, Date.now());
    // [macro-fusion 0.2.96] 把开工时算好的计划摘要一起落库：以后查 dream_log 能看到这一轮翻了几条、
    // 几对逐字重复、几对重复详写、合并会丢几个词，而不是只有「done + groups」。念完就删 meta，免得下一轮
    // 读到上一轮的旧账（中断/abort 的路径也会落到这里，照样留痕）。
    let plan;
    try {
      const rawPlan = db.getDreamMeta(`dreamdigest:${sessionId}`);
      if (rawPlan !== void 0) plan = JSON.parse(rawPlan);
      db.delDreamMeta(`dreamdigest:${sessionId}`);
    } catch {
      plan = void 0;
    }
    // [macro-fusion 0.2.106] 收尾再数一次库规模：开工那一刻的数只说明「整理前有多大」，
    // 答不了「这一轮之后库变成多大」。两个点用同一把尺子（dreamStoreScale，只数 status='active'），
    // 差的符号就是这一轮把库变轻还是变重。它**不等于**「这一轮改了几条」——两个观测点之间可能有
    // 别的会话在写、也可能有归档把 active 挪走，所以面板把这句和 stamped 并排说，让人自己分。
    // 只在有 digest 时才补：没有 plan 的账（中断得很早 / 0.2.96 之前）连开工数都没有，无从对照。
    if (plan !== void 0 && typeof plan === "object") {
      plan.storeEnd = dreamStoreScale(db);
      const before = Number(plan.store?.active);
      if (Number.isFinite(before) && before >= 0) plan.storeDelta = plan.storeEnd.active - before;
    }
    const storeNote = plan === void 0 || plan.storeEnd === void 0 ? "" : ` store=${plan.store?.active ?? "?"}->${plan.storeEnd.active}`;
    const planNote = plan === void 0 ? "" : ` plan rows=${plan.rows} dup=${plan.dup} cover=${plan.cover} missing=${plan.missing}${storeNote}`;
    // [macro-fusion 0.2.107] 中断的账把分数也印进 summary：`groups=1/2` 一眼看出走完几组、本来几组，
    // 不必展开 changes 才知道这一轮本来要处理几组。分子是「已走完」，分母是「本来几组」。
    const groupsText = reason === "aborted" && groupsTotal > 0 ? `${Math.max(0, groupsCount - 1)}/${groupsTotal}` : `${groupsCount}`;
    db.logDream(
      `window dream ${reason}: ${shortSessionId(sessionId)} groups=${groupsText} stamped=${stamped}${planNote} T=${new Date(T2).toISOString()}`,
      // #108：changes 落真实计数（此前两处调用硬编码 {before:undefined,after:undefined}
      // → JSON {}，查库的人会误读成"什么都没改"）。stamped=本轮封存/完结条目数。
      // [macro-fusion 0.2.107] kind 说明这一轮是怎么收的场：done=跑完、aborted=半路停下（带组数）。
      plan === void 0 ? { stamped, groups: groupsCount, kind } : { stamped, groups: groupsCount, kind, plan }
    );
    dreamLog(workspace, dir, `dream ${reason} session=${shortSessionId(sessionId)} groups=${groupsCount} stamped=${stamped}${planNote}`);
    onDreamState?.(sessionId, "dreamed");
  } catch (e) {
    dreamLog(workspace, dir, `dream ${reason} finish error: ${String(e)}`);
  }
}
function abortDream(agent, dir = ".dsh-meow", onDreamState) {
  const sessionId = agent?.session?.header?.id;
  const ws = agent?.session?.header?.cwd;
  if (typeof sessionId !== "string" || typeof ws !== "string" || ws.length === 0) return;
  const db = getDb(ws, dir);
  const lease = db.getDreamLease(sessionId);
  if (lease === null) return;
  finalizeDream(db, sessionId, ws, dir, lease.T, "aborted", lease.group_idx + 1, onDreamState);
}
function dreamTool(ctx, dir = ".dsh-meow", onDreamState, rulesReviewDays = DEFAULT_RULES_REVIEW_DAYS, workspaceDisabled, memoryUntrusted) {
  return {
    name: "memory_dream",
    description: keyedValue("tools", "memory_dream.description"),
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {}
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: {
          ok: { type: "boolean" },
          note: { type: "string" }
        }
      },
      render: (_args, value) => {
        const v = value;
        return [{ type: "text", text: v.ok ? `\u{1F9E0} dream \u5DF2\u5B89\u6392\u3002${String(v.note ?? "")}` : `dream \u672A\u542F\u52A8\uFF1A${String(v.note ?? "")}` }];
      }
    },
    async execute(_args, exec) {
      const workspace = workspaceOf(exec);
      if (!workspace) throw new Error("memory_dream: \u65E0\u6CD5\u786E\u5B9A\u5DE5\u4F5C\u533A\uFF08\u4F1A\u8BDD\u65E0 cwd\uFF09\u2014\u2014\u8BB0\u5FC6\u5DE5\u5177\u9700\u5728\u6709\u5DE5\u4F5C\u533A cwd \u7684\u4F1A\u8BDD\u5185\u8C03\u7528\uFF0C\u5916\u90E8/\u65E0\u4F1A\u8BDD\u8C03\u7528\u94FE\u4E0D\u53D7\u652F\u6301\uFF08#94\uFF09");
      if (!exec.agent) throw new Error("memory_dream: \u65E0\u6CD5\u786E\u5B9A\u5F53\u524D agent");
      if (isSubagentAgent(exec.agent)) {
        return { ok: false, note: "\u5F53\u524D\u662F\u5B50\u4EE3\u7406\u4F1A\u8BDD\uFF0C\u6CA1\u6709\u72EC\u7ACB\u7684\u8BB0\u5FC6\u7A97\u53E3\uFF1B\u8BB0\u5FC6\u6574\u7406\u5F52\u7236\u7A97\u53E3\u8D1F\u8D23\uFF0C\u65E0\u9700\uFF08\u4E5F\u4E0D\u80FD\uFF09\u5728\u6B64\u89E6\u53D1 dream\u3002" };
      }
      if (workspaceDisabled?.(workspace) === true) return { ok: false, note: "\u8BE5\u5DE5\u4F5C\u533A\u5DF2\u505C\u7528\u8BB0\u5FC6\uFF08disabledWorkspaces \u540D\u5355\uFF09\uFF1Adream \u4E0D\u53EF\u7528\u3002" };
      if (memoryUntrusted?.(workspace) === true) return { ok: false, note: "\u6B64\u5DE5\u4F5C\u533A\u81EA\u5E26\u672A\u4FE1\u4EFB\u7684\u5916\u90E8\u8BB0\u5FC6\u5E93\uFF08.dsh-meow \u975E\u672C\u673A\u521B\u5EFA\uFF09\uFF1Adream \u4E0D\u53EF\u7528\u3002\u786E\u8BA4\u8FD9\u662F\u81EA\u5DF1\u7684\u9879\u76EE\uFF0C\u8BF7\u8BA9\u7528\u6237\u6267\u884C /meow-trust\u3002" };
      const rrd = typeof rulesReviewDays === "function" ? rulesReviewDays() : rulesReviewDays;
      // [macro-fusion 0.2.48] 原来 ok===false 时只有两句话可挑（有 lease / 没有需要整理的记忆），
      // 而 false 有四种来路。现在按 trace 说清是哪一种——尤其「消息没送出去」不能冒充「没东西可整理」。
      const trace48 = { reason: "" };
      const ok = startWindowDream(ctx, exec.agent, workspace, dir, onDreamState, rrd, trace48);
      // [macro-fusion 0.2.96] 回执里先说这一轮要看到什么（轮数/条数/逐字重复对/重复详写对/要补的词），
      // 再说什么状态。数字来自 dreamPlanDigest——和清单里真正印出来的块同源，不是另估一份。
      const receipt48 = dreamReceipt(trace48.digest);
      if (ok) return { ok, note: [receipt48, "\u6574\u7406\u4EFB\u52A1\u5DF2\u5728\u540E\u53F0\u542F\u52A8\uFF0C\u4F1A\u8BDD\u6D41\u4E2D\u7684\u4EFB\u52A1\u6C14\u6CE1\u4F1A\u663E\u793A\u8FDB\u5EA6\u4E0E\u5B8C\u6210\u72B6\u6001\u3002"].filter((x) => x !== "").join("\n") };
      if (trace48.reason === "noRounds") {
        return { ok, note: "本窗口没有需要整理的记忆（盘点过：没有未封存的记忆轮次）——这一次是真没有，不是 dream 坏了。" };
      }
      if (trace48.reason === "claimed") {
        return { ok, note: "本窗口确实有记忆要整理，但已经有一个 dream 在跑（或上一轮还在待补收尾）——这次没启动，等它收尾后再触发就行。" };
      }
      if (trace48.reason === "sendFailed") {
        return { ok, note: [receipt48, "这次没启动成功：整理任务的消息没送进会话（会话正忙或被中断）。要整理的记忆还在，稍后再触发一次就行——这不是「没有需要整理的记忆」。"].filter((x) => x !== "").join("\n") };
      }
      if (trace48.reason === "noSessionId") {
        return { ok, note: "这次没启动成功：拿不到这个窗口的标识，所以没法开工（这不是「没有需要整理的记忆」）。" };
      }
      return { ok, note: "本窗口没有需要整理的记忆。" };
    },
    presentCall() {
      return { card: "generic", title: "memory_dream: \u6574\u7406\u672C\u7A97\u53E3\u8BB0\u5FC6", kind: "write" };
    }
  };
}
function dreamCommandDefinition(ctx, dir = ".dsh-meow", onDreamState, rulesReviewDays = DEFAULT_RULES_REVIEW_DAYS, workspaceDisabled, memoryUntrusted) {
  return {
    name: "dream",
    description: "\u624B\u52A8\u5524\u8D77\u4E00\u6B21\u8BB0\u5FC6\u6574\u7406\uFF08dream\uFF09\uFF1A\u9010\u8F6E\u56DE\u987E\u672C\u7A97\u53E3\u5EFA\u7ACB/\u63D0\u53D6\u8FC7\u7684\u8DE8\u4F1A\u8BDD\u8BB0\u5FC6\u5E76\u5C01\u5B58\u3002\u4E0E memory_dream \u5DE5\u5177\u76F8\u540C\uFF0C\u624B\u52A8\u89E6\u53D1\u4E0D\u53D7\u5CF0\u65F6\u6291\u5236\u3002",
    handler(invocation) {
      const agent = invocation?.agent;
      if (!agent) return { kind: "error", text: "/dream \u65E0\u6CD5\u786E\u5B9A\u5F53\u524D\u7A97\u53E3\u7684\u4F1A\u8BDD\u3002" };
      const header = agent.session?.header;
      if (header?.origin === "subagent") {
        return { kind: "error", text: "/dream \u53EA\u80FD\u5728\u4E3B\u4F1A\u8BDD\u4F7F\u7528\uFF1A\u5B50\u4EE3\u7406\u6CA1\u6709\u72EC\u7ACB\u7684\u8BB0\u5FC6\u7A97\u53E3\u3002" };
      }
      const workspace = typeof header?.cwd === "string" && header.cwd.length > 0 ? header.cwd : null;
      if (workspace === null) {
        return { kind: "error", text: "/dream \u65E0\u6CD5\u786E\u5B9A\u5F53\u524D\u7A97\u53E3\u7684\u5DE5\u4F5C\u533A\uFF08\u4F1A\u8BDD\u65E0 cwd\uFF09\u3002" };
      }
      if (typeof header?.id !== "string" || header.id.length === 0) {
        return { kind: "error", text: "/dream \u65E0\u6CD5\u786E\u5B9A\u5F53\u524D\u7A97\u53E3\u7684\u4F1A\u8BDD id\u3002" };
      }
      if (workspaceDisabled?.(workspace) === true) {
        return { kind: "error", text: "\u8BE5\u5DE5\u4F5C\u533A\u5DF2\u505C\u7528\u8BB0\u5FC6\uFF08disabledWorkspaces \u540D\u5355\uFF09\uFF1A/dream \u4E0D\u53EF\u7528\u3002" };
      }
      if (memoryUntrusted?.(workspace) === true) {
        return { kind: "error", text: "\u6B64\u5DE5\u4F5C\u533A\u81EA\u5E26\u672A\u4FE1\u4EFB\u7684\u5916\u90E8\u8BB0\u5FC6\u5E93\uFF08.dsh-meow \u975E\u672C\u673A\u521B\u5EFA\uFF09\uFF1A/dream \u4E0D\u53EF\u7528\u3002\u786E\u8BA4\u8FD9\u662F\u81EA\u5DF1\u7684\u9879\u76EE\uFF0C\u8BF7\u5148\u6267\u884C /meow-trust\u3002" };
      }
      const rrd = typeof rulesReviewDays === "function" ? rulesReviewDays() : rulesReviewDays;
      // [macro-fusion 0.2.48] 命令面和工具面同一套原因，别让 /dream 还把「没送出去」说成「没有需要整理的记忆」。
      const traceCmd48 = { reason: "" };
      const ok = startWindowDream(ctx, agent, workspace, dir, onDreamState, rrd, traceCmd48);
      // [macro-fusion 0.2.96] 命令面与工具面同一份摘要：/dream 的屏幕上也要先说这一轮看到什么。
      const receiptCmd96 = dreamReceipt(traceCmd48.digest);
      if (ok) return { kind: "success", text: [receiptCmd96, "\u{1F9E0} dream \u5DF2\u89E6\u53D1\uFF1A\u6574\u7406\u4EFB\u52A1\u5DF2\u5728\u540E\u53F0\u8FD0\u884C\uFF0C\u4F1A\u8BDD\u6D41\u4E2D\u7684\u4EFB\u52A1\u6C14\u6CE1\u4F1A\u663E\u793A\u8FDB\u5EA6\u4E0E\u5B8C\u6210\u72B6\u6001\u3002"].filter((x) => x !== "").join("\n") };
      if (traceCmd48.reason === "claimed") {
        return { kind: "error", text: "本窗口已经有一个 dream 在跑（或待补收尾），未重复启动。" };
      }
      if (traceCmd48.reason === "sendFailed") {
        return { kind: "error", text: [receiptCmd96, "/dream 这次没启动成功：整理任务的消息没送进会话（会话正忙或被中断）。要整理的记忆还在，稍后再试一次。"].filter((x) => x !== "").join("\n") };
      }
      if (traceCmd48.reason === "noSessionId") {
        return { kind: "error", text: "/dream 这次没启动成功：拿不到这个窗口的标识，所以没法开工（这不是「没有需要整理的记忆」）。" };
      }
      return { kind: "error", text: "本窗口没有需要整理的记忆（盘点过：本窗口建立/提取过的记忆为空）。" };
    }
  };
}
function recoverInterruptedDream(db, sessionId, workspace, dir = ".dsh-meow") {
  const lease = db.getDreamLease(sessionId);
  const w = db.getWindow(sessionId);
  const T2 = lease ? lease.T : w && w.last_event_time > 0 ? w.last_event_time : Date.now();
  const progressed = lease !== null && lease.group_idx > 0;
  // [macro-fusion 0.2.107] fails 要活到落账那一行：零进展和被封存这两种收尾都得把失败次数
  // 写进 changes.kind，否则账本里只剩一句中文，事后问不了「到底崩了几次」。
  let fails = 0;
  if (!progressed) {
    fails = db.recordDreamFailure(sessionId, T2);
    if (fails < DREAM_MAX_ATTEMPTS) {
      db.releaseDream(sessionId);
      dreamLog(workspace, dir, `dream recovered zero-progress session=${shortSessionId(sessionId)} fails=${fails}/${DREAM_MAX_ATTEMPTS} -> released (retry next sweep)`);
      return 0;
    }
    dreamLog(workspace, dir, `dream recovered zero-progress session=${shortSessionId(sessionId)} fails=${fails} -> sealed (cap reached)`);
    console.warn(`[meow-memory] dream \u8FDE\u7EED\u5931\u8D25 ${fails} \u6B21\u540E\u4E2D\u65AD\uFF08\u7A97\u53E3 ${shortSessionId(sessionId)}\uFF09\uFF0C\u6309\u5C01\u5B58\u6536\u5C3E\u4E0D\u518D\u81EA\u52A8\u91CD\u8BD5\uFF1B\u8BE5\u7A97\u53E3\u6B63\u5E38\u5BF9\u8BDD\u4EA7\u751F\u65B0\u6D3B\u52A8\u540E\u53EF\u91CD\u65B0\u81EA\u52A8\u6574\u7406\uFF0C\u6216\u624B\u52A8 /dream`);
  }
  const stamped = db.stampDream(sessionId, T2);
  db.finishDream(sessionId, Date.now());
  // [macro-fusion 0.2.107] 两种收尾分开记：走到过几组 = 被打断后补记（recovered），
  // 一组都没走完就连续失败到上限 = 这一轮压根没起步（gaveup，带失败次数）。
  const groupsDone = progressed ? lease.group_idx : 0;
  const kind = progressed ? { kind: "recovered", groupsDone } : { kind: "gaveup", fails };
  db.logDream(
    `window dream recovered (interrupted): ${shortSessionId(sessionId)} stamped=${stamped} groups=${groupsDone}${fails > 0 ? ` fails=${fails}` : ""} T=${new Date(T2).toISOString()}`,
    { stamped, groups: groupsDone, kind }
    // #108：changes 落真实计数，不再硬编码空对象
  );
  dreamLog(workspace, dir, `dream recovered session=${shortSessionId(sessionId)} stamped=${stamped}`);
  return stamped;
}
function handleMemoryTurnFailure(db, sessionId, workspace, dir = ".dsh-meow") {
  stopDreamHeartbeat(sessionId);
  const lease = db.getDreamLease(sessionId);
  if (lease === null) return "none";
  const fails = db.recordDreamFailure(sessionId, lease.T);
  if (fails >= DREAM_MAX_ATTEMPTS) {
    const stamped = db.stampDream(sessionId, lease.T);
    db.finishDream(sessionId, Date.now());
    // [macro-fusion 0.2.107] 这条收尾以前只写调试日志（dream-debug.log），账本里一个字都没有——
    // 于是「连续三次失败被止损封存」在面板上等于没发生过，同一个窗口看起来像从没整理过。
    // 现在照账本记一条：kind=sealed 带失败次数，和 done / aborted 一样能查、能回指。
    db.logDream(
      `window dream sealed (turn-failed): ${shortSessionId(sessionId)} fails=${fails} stamped=${stamped} T=${new Date(lease.T).toISOString()}`,
      { stamped, kind: { kind: "sealed", fails } },
    );
    dreamLog(workspace, dir, `dream turn-failed cap sid=${shortSessionId(sessionId)} fails=${fails} -> sealed (stamped=${stamped})`);
    console.warn(`[meow-memory] dream \u8F6E\u8FDE\u7EED\u5931\u8D25 ${fails} \u6B21\uFF08\u7A97\u53E3 ${shortSessionId(sessionId)}\uFF09\uFF0C\u5DF2\u5C01\u5B58\u4E0D\u518D\u81EA\u52A8\u91CD\u8BD5\uFF1B\u8BE6\u89C1 dream-debug.log`);
    return "sealed";
  }
  db.releaseDream(sessionId);
  dreamLog(workspace, dir, `dream turn-failed sid=${shortSessionId(sessionId)} fails=${fails}/${DREAM_MAX_ATTEMPTS} -> released (retry next sweep)`);
  return "released";
}
function hourInTimeZone(timeZone, date = /* @__PURE__ */ new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).formatToParts(date);
    const h = parts.find((p) => p.type === "hour")?.value;
    if (h !== void 0) return parseInt(h, 10) % 24;
  } catch {
  }
  return date.getHours();
}
function minutesInTimeZone(timeZone, date = /* @__PURE__ */ new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(date);
    const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "NaN", 10);
    const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "NaN", 10);
    if (!Number.isNaN(h) && !Number.isNaN(m)) return h % 24 * 60 + m;
  } catch {
  }
  const d = new Date(date);
  return d.getHours() * 60 + d.getMinutes();
}
function parseMinute(hhmm) {
  const mm = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!mm) return null;
  const h = parseInt(mm[1], 10);
  const m = parseInt(mm[2], 10);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}
function isDreamSuppressed(cfg, date = /* @__PURE__ */ new Date()) {
  const m = minutesInTimeZone(cfg.timeZone, date);
  const lead = Math.max(0, Math.floor(cfg.suppressLeadMinutes));
  for (const w of cfg.suppressWindows) {
    const start = parseMinute(w.start);
    const end = parseMinute(w.end);
    if (start === null || end === null || start === end) continue;
    const from = (start - lead + 1440) % 1440;
    if (from === end) return true;
    if (from < end) {
      if (m >= from && m < end) return true;
    } else if (m >= from || m < end) {
      return true;
    }
  }
  return false;
}
function readLastRouteFromSessionLog(sessionId) {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  const home = process.env.DSH_HOME || join7(homedir3(), ".dsh");
  for (const rootName of ["sessions", "archived-sessions"]) {
    const root = join7(home, rootName);
    let projDirs;
    try {
      if (!existsSync6(root)) continue;
      projDirs = readdirSync4(root);
    } catch {
      continue;
    }
    for (const proj of projDirs) {
      for (const file of [join7(root, proj, sessionId, "session.v4.jsonl.zstd"), join7(root, proj, sessionId, "session.jsonl.zstd")]) {
        if (!existsSync6(file)) continue;
        try {
          const lines = decompressAllFrames(readFileSync6(file)).toString("utf8").split("\n");
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            if (!line.includes('"request/header"')) continue;
            let ev;
            try {
              ev = JSON.parse(line);
            } catch {
              continue;
            }
            const cfg = ev?.data?.header?.config;
            if (cfg !== void 0 && cfg !== null && typeof cfg.provider === "string" && cfg.provider.length > 0 && typeof cfg.model === "string" && cfg.model.length > 0) return { provider: cfg.provider, model: cfg.model };
          }
        } catch {
        }
      }
    }
  }
  return null;
}
function resolveResumeRoute(ctx, sessionId) {
  const fromLog = readLastRouteFromSessionLog(sessionId);
  if (fromLog !== null) return { ...fromLog, source: "session-log" };
  try {
    const svc2 = ctx.get?.("agentDefaultModel");
    const sel = typeof svc2?.currentSelection === "function" ? svc2.currentSelection() : null;
    if (sel !== null && sel !== void 0 && typeof sel.provider === "string" && sel.provider.length > 0 && typeof sel.model === "string" && sel.model.length > 0) return { provider: sel.provider, model: sel.model, source: "default-selection" };
  } catch {
  }
  return null;
}
var resumeInFlight = /* @__PURE__ */ new Set();
var RESUME_BACKOFF_MS = 6 * 36e5;
var resumeFailedAt = /* @__PURE__ */ new Map();
function resumeBackoffActive(sessionId) {
  const at = resumeFailedAt.get(sessionId);
  return at !== void 0 && Date.now() - at < RESUME_BACKOFF_MS;
}
function markResumeFailed(sessionId) {
  resumeFailedAt.set(sessionId, Date.now());
  if (resumeFailedAt.size <= 512) return;
  const now = Date.now();
  for (const [sid, at] of resumeFailedAt) {
    if (now - at >= RESUME_BACKOFF_MS) resumeFailedAt.delete(sid);
  }
}
function isSubagentAgent(agent) {
  const header = agent?.session?.header;
  if (header === void 0 || header === null) return false;
  if (header.origin === "subagent") return true;
  return typeof header.delegationDepth === "number" && header.delegationDepth > 0;
}
var autoDreamSkipWindows = /* @__PURE__ */ new Set();
var resumeShapeWarned = /* @__PURE__ */ new Set();
async function resumeAndDream(ctx, sessionId, workspace, dir, onDreamState, cfg) {
  const log = (msg) => dreamLog(workspace, dir, msg);
  const sid = shortSessionId(sessionId);
  if (resumeInFlight.has(sessionId)) return;
  if (resumeBackoffActive(sessionId)) return;
  resumeInFlight.add(sessionId);
  try {
    const sessionsSvc = ctx.get?.("sessionController");
    let agent;
    if (sessionsSvc !== void 0 && typeof sessionsSvc.resolveAgent === "function") {
      log(`check resume owner sid=${sid} via sessionController`);
      const resolved = await sessionsSvc.resolveAgent(sessionId);
      const r = resolved;
      if (r === null || typeof r !== "object" || !("agent" in r) && !("error" in r)) {
        if (!resumeShapeWarned.has(sessionId)) {
          resumeShapeWarned.add(sessionId);
          const keys = r !== null && typeof r === "object" ? Object.keys(r).join(",") : String(r);
          log(`check resume owner sid=${sid} \u672A\u8BC6\u522B\u7684 resolveAgent \u8FD4\u56DE\u5F62\u72B6\uFF08keys=${keys}\uFF09-> \u672C\u5468\u671F\u8DF3\u8FC7\uFF0C\u4E0D\u8BB0\u6C38\u4E45\u8DF3\u8FC7`);
        }
        return;
      }
      if ("error" in r) throw new Error(String(r.error?.message ?? "resolveAgent error"));
      agent = r.agent;
    } else {
      const agentsSvc = ctx.get?.("agents");
      if (agentsSvc === void 0 || typeof agentsSvc.resume !== "function") {
        log(`check agent-resume-unavailable sid=${sid} service=${agentsSvc ? "yes" : "no"}`);
        return;
      }
      const route = resolveResumeRoute(ctx, sessionId);
      if (route === null) log(`check resume no-route sid=${sid} -> resume without agentOptions (turn-failed \u515C\u5E95)`);
      else log(`check resume route sid=${sid} provider=${route.provider} model=${route.model} source=${route.source}`);
      const resumed = await agentsSvc.resume({
        resumeSessionId: sessionId,
        ...route === null ? {} : { agentOptions: { provider: route.provider, model: route.model } }
      });
      agent = resumed?.agent ?? resumed;
    }
    const header = agent?.session?.header;
    if (header === void 0 || header === null || typeof header.id !== "string" || header.id.length === 0) {
      autoDreamSkipWindows.add(sessionId);
      log(`check resume unusable-agent sid=${sid} -> skip`);
      return;
    }
    log(`check agent-resumed sid=${sid}`);
    if (isSubagentAgent(agent)) {
      autoDreamSkipWindows.add(sessionId);
      log(`check resume skip-subagent sid=${sid}`);
      return;
    }
    const db = getDb(workspace, dir);
    const w = db.getWindow(sessionId);
    if (!w || !windowNeedsDream(w)) return;
    if (Date.now() - w.last_event_time < cfg.idleMinutes * 6e4) return;
    if (db.getDreamLease(sessionId) !== null) return;
    startWindowDream(ctx, agent, workspace, dir, onDreamState, cfg.rulesReviewDays);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("not found")) markResumeFailed(sessionId);
    log(`check agent-resume-failed sid=${sid} err=${msg}`);
  } finally {
    resumeInFlight.delete(sessionId);
  }
}
function dreamSweepOnce(ctx, cfg, dir, windowIndex2, onDreamState, workspaceDisabled) {
  const archived = /* @__PURE__ */ new Set();
  try {
    const reg = ctx.get?.("workspaceRegistry");
    for (const id of reg?.archivedSessionIds ?? []) archived.add(id);
  } catch {
  }
  for (const [sessionId, workspace] of windowIndex2) {
    if (archived.has(sessionId)) continue;
    if (workspaceDisabled?.(workspace) === true) continue;
    if (autoDreamSkipWindows.has(sessionId)) continue;
    const db = getDb(workspace, dir);
    if (db.isDreamSkipped(sessionId)) continue;
    const w = db.getWindow(sessionId);
    if (!w || !windowNeedsDream(w)) continue;
    const lease = db.getDreamLease(sessionId);
    dreamLog(workspace, dir, `check sid=${shortSessionId(sessionId)} active=${lease !== null} idle=${Math.round((Date.now() - w.last_event_time) / 1e3)}s`);
    if (lease !== null) {
      if (Date.now() - lease.progress_at > DREAM_LEASE_MS) {
        recoverInterruptedDream(db, sessionId, workspace, dir);
        const wAfter = db.getWindow(sessionId);
        onDreamState?.(sessionId, wAfter !== void 0 && wAfter.last_dream_time !== null ? "dreamed" : "active");
      }
      continue;
    }
    if (Date.now() - w.last_event_time < cfg.idleMinutes * 6e4) continue;
    const agentsSvc = typeof ctx.get === "function" ? ctx.get("agents") : void 0;
    const agent = liveAgents.get(sessionId) ?? (agentsSvc !== void 0 && typeof agentsSvc.get === "function" ? agentsSvc.get(sessionId) : void 0);
    if (!agent) {
      dreamLog(workspace, dir, `check agent-missing sid=${shortSessionId(sessionId)} -> try resume`);
      void resumeAndDream(ctx, sessionId, workspace, dir, onDreamState, cfg);
      continue;
    }
    if (isSubagentAgent(agent)) {
      autoDreamSkipWindows.add(sessionId);
      dreamLog(workspace, dir, `check skip-subagent sid=${shortSessionId(sessionId)}`);
      continue;
    }
    const started = startWindowDream(ctx, agent, workspace, dir, onDreamState, cfg.rulesReviewDays);
    if (started) return;
  }
}
function dreamSweepTick(ctx, cfg, dir, windowIndex2, onDreamState, workspaceDisabled) {
  try {
    const c = typeof cfg === "function" ? cfg() : cfg;
    if (c === void 0 || !c.enabled) return;
    if (isDreamSuppressed(c)) return;
    const gateWorkspaces = [...new Set(windowIndex2.values())].sort();
    if (gateWorkspaces.length === 0 || !getDb(gateWorkspaces[0], dir).claimCheckGate(6e4)) return;
    dreamSweepOnce(ctx, c, dir, windowIndex2, onDreamState, workspaceDisabled);
  } catch (error) {
    console.warn(`[meow-memory] dream sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function scheduleDream(ctx, cfg, dir = ".dsh-meow", windowIndex2, onDreamState, workspaceDisabled) {
  const read = typeof cfg === "function" ? cfg : () => cfg;
  const checkMinutesOf = (c) => typeof c?.checkMinutes === "number" && Number.isFinite(c.checkMinutes) && c.checkMinutes >= 1 ? c.checkMinutes : 15;
  let timer;
  let stopped = false;
  let lastEnabled;
  let lastTickAt = Date.now();
  const arm = (minutes) => {
    if (stopped) return;
    timer = setTimeout(tick, minutes * 6e4);
    if (typeof timer === "object" && timer !== null && typeof timer.unref === "function") timer.unref();
  };
  const tick = () => {
    let c;
    let deferred = false;
    const gapMs = Date.now() - lastTickAt;
    lastTickAt = Date.now();
    try {
      c = read();
      if (c !== void 0 && c.enabled !== lastEnabled) {
        lastEnabled = c.enabled;
        ctx.logger.info(`meow-memory: dream \u8C03\u5EA6\u5668${c.enabled ? "\u542F\u7528" : "\u505C\u7528"}\uFF08\u914D\u7F6E\u70ED\u751F\u6548\uFF0Cissue #26\uFF09`);
      }
      if (gapMs > checkMinutesOf(c) * 6e4 * 1.5 + 6e4) {
        deferred = true;
        ctx.logger.info(`meow-memory: dream \u8C03\u5EA6\u5668\u68C0\u6D4B\u5230\u7CFB\u7EDF\u6302\u8D77 ${Math.round(gapMs / 6e4)} \u5206\u949F\uFF0C\u672C\u6B21\u8DF3\u8FC7\u30015 \u5206\u949F\u540E\u518D\u67E5`);
      } else {
        dreamSweepTick(ctx, c, dir, windowIndex2, onDreamState, workspaceDisabled);
      }
    } finally {
      arm(deferred ? 5 : checkMinutesOf(c));
    }
  };
  let initial;
  try {
    initial = read();
  } catch {
  }
  arm(checkMinutesOf(initial));
  return () => {
    stopped = true;
    if (timer !== void 0) clearTimeout(timer);
  };
}
var lastActivityAt = Date.now();
function noteActivity() {
  lastActivityAt = Date.now();
}

// src/migrate.ts
import { existsSync as existsSync7, readFileSync as readFileSync7, renameSync as renameSync5 } from "node:fs";
import { join as join8 } from "node:path";
var CATEGORY_TO_LEVEL = {
  fact: { level: "fact" },
  mistake: { level: "lesson", corrected: 1 },
  preference: { level: "user" },
  user_said: { level: "project" },
  lesson: { level: "lesson" },
  detail: { level: "project" }
};
var PROJECT_HINTS = [
  [/femwa|femo|femgen|fe4m/i, "femo"],
  // 匹配词保留 femwa/femGen（老 PROJECT.md 里的写法），输出名统一 femo
  [/meow-eyes|猫眼/i, "meow-eyes"],
  [/meow-memory|memory-meow/i, "meow-memory"],
  [/dsh-meow|dsh 本体|3080|3081|known-event|agentPreset|apiproxy/i, "dsh"]
];
function guessProject(content) {
  for (const [re, name2] of PROJECT_HINTS) {
    if (re.test(content)) return name2;
  }
  return "dsh";
}
function routeDetail(content) {
  return /路径|仓库|端口|目录|结构|junction|文件|package\.json|\.dsh|node_modules|http|127\.0\.0\.1|api|ctx\.|插件|引擎|路由/i.test(
    content
  ) ? "project" : "fact";
}
function routeUserSaid(content) {
  return /纠正|教训|错了|错了|改口|拍板|确认/i.test(content) ? { level: "lesson", corrected: 1 } : { level: "project" };
}
function routeCategory(cat, content) {
  switch (cat) {
    case "detail":
      return { level: routeDetail(content) };
    case "user_said":
      return routeUserSaid(content);
    default:
      return CATEGORY_TO_LEVEL[cat] ?? { level: "fact" };
  }
}
function parseLegacy(text) {
  const core = [];
  const entries = [];
  let current = null;
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trimEnd();
    const sec = line.match(/^##\s+.+\(([a-z_]+)\)\s*$/);
    if (sec) {
      current = sec[1];
      continue;
    }
    if (line.startsWith("- ")) {
      const content = line.slice(2).trim();
      if (!content) continue;
      if (current) entries.push({ category: current, content });
      else core.push(content);
      continue;
    }
    if (!current) {
      const t = line.trim();
      if (t && !t.startsWith("#") && !t.startsWith(">") && !t.startsWith("=====")) core.push(t);
    }
  }
  return { core, entries };
}
function splitCoreLine(line) {
  return /ai|模型|我应该|作为|身份|自我|soul/i.test(line) ? "soul" : "user";
}
function migrateLegacy(db, workspace, dir = ".dsh-meow") {
  const projectFile = join8(workspace, dir, "PROJECT.md");
  if (!db.isFresh() || !existsSync7(projectFile)) return null;
  const text = readFileSync7(projectFile, "utf8");
  const { core, entries } = parseLegacy(text);
  let imported = 0;
  const now = Date.now();
  for (const line of core) {
    const level = splitCoreLine(line);
    db.insert({ level, content: line, importance: 3, source_session: "migration", created_at: now });
    imported++;
  }
  for (const { category, content } of entries) {
    const routed = routeCategory(category, content);
    const level = routed.level;
    const project = level === "project" || level === "fact" || level === "lesson" ? guessProject(content) : null;
    db.insert({
      level,
      content,
      importance: 1,
      corrected: routed.corrected ?? 0,
      project,
      source_session: "migration",
      created_at: now
    });
    imported++;
  }
  try {
    renameSync5(projectFile, projectFile + ".imported");
  } catch {
  }
  return imported;
}

// src/reflect.ts
import { createUserMessage as createUserMessage2 } from "@deepseek-ai/dsh-llm";
var REFLECT_MARKER = "[meow-memory-reflect]";
function scanTurn(events) {
  let startIdx = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "turn/start") {
      startIdx = i;
      break;
    }
  }
  let sawToolCall = false;
  // [macro-fusion 0.2.133] 反差别的两个信号：这一轮到底有没有干过「不是记忆」的活
  // （决定要不要反思），以及用户自己说了什么（决定要不要立刻反思）。
  let sawNonMemory = false;
  let lastToolName;
  let sawReflect = false;
  // [macro-fusion 0.2.134] 事故信号：失败长在动作上，不在句子里。原来只看「用户骂人」和
  // 「turn 以 error 结束」，于是写坏一次库、同一个工具连挂三次，都留不下任何痕迹。
  let toolErrors = 0;
  let memoryErrors = 0;
  let worstFail = 0;
  let worstTool;
  let memoryWrites = 0;
  const callNames = /* @__PURE__ */ new Map();
  const failByTool = /* @__PURE__ */ new Map();
  const texts = [];
  const userTexts = [];
  for (let i = startIdx; i < events.length; i++) {
    const e = events[i];
    if (e?.type === "user/message") {
      const src = e.data?.source;
      const msgText = (e.data?.content ?? []).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text ?? "").join(" ");
      if (isMeowSource(src) && msgText.includes(REFLECT_MARKER)) {
        sawReflect = true;
      } else {
        for (const b of e.data?.content ?? []) if (b.type === "text" && b.text) {
          texts.push(b.text);
          userTexts.push(b.text);
        }

      }
    } else if (e?.type === "assistant/message") {
      for (const block of e.data?.message?.content ?? []) {
        if (block.type === "tool-call") {
          sawToolCall = true;
          lastToolName = block.name;
          if (!block.name.startsWith("memory_")) sawNonMemory = true;
          if (block.name === "memory_remember" || block.name === "memory_update") memoryWrites++;
          const callId = block.id ?? block.callId;
          if (typeof callId === "string") callNames.set(callId, block.name);
        } else if (block.type === "text" && block.text) {
          texts.push(block.text);
        }
      }
    } else if (e?.type === "tool/ptc-dispatch") {
      const name2 = e.data?.name;
      if (typeof name2 === "string") {
        sawToolCall = true;
        lastToolName = name2;
        if (!name2.startsWith("memory_")) sawNonMemory = true;
        if (name2 === "memory_remember" || name2 === "memory_update") memoryWrites++;
      }
    } else if (e?.type === "tool/call") {
      const callId2 = e.data?.callId;
      const name3 = e.data?.name;
      if (typeof callId2 === "string" && typeof name3 === "string") callNames.set(callId2, name3);
    } else if (e?.type === "tool/result") {
      const res = e.data?.message;
      if (res?.isError === true) {
        toolErrors++;
        const called = callNames.get(res.toolCallId);
        const name4 = typeof called === "string" ? called : typeof e.data?.name === "string" ? e.data.name : keyedValue("labels", "reflect.unknownTool");
        const seen = (failByTool.get(name4) ?? 0) + 1;
        failByTool.set(name4, seen);
        if (name4.startsWith("memory_")) memoryErrors++;
        if (seen > worstFail) {
          worstFail = seen;
          worstTool = name4;
        }
      }
    }
  }
  return {
    sawToolCall,
    sawNonMemory,
    lastToolName,
    sawReflect,
    toolErrors,
    memoryErrors,
    worstFail,
    worstTool,
    memoryWrites,
    failedTools: [...failByTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4),
    turnText: texts.join("\n").slice(-2e3),
    userText: userTexts.join("\n").slice(-2e3)
  };
}
function consecutiveToolSteps(events) {
  let startIdx = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "turn/start") {
      startIdx = i;
      break;
    }
  }
  let best = 0;
  let cur = 0;
  for (let i = startIdx; i < events.length; i++) {
    const e = events[i];
    if (e?.type === "tool/ptc-dispatch") {
      if (typeof e.data?.name === "string" && e.data.name.startsWith("memory_")) cur = 0;
      continue;
    }
    if (e?.type !== "assistant/message") continue;
    for (const b of e.data?.message?.content ?? []) {
      if (b.type !== "tool-call" || typeof b.name !== "string") continue;
      if (b.name.startsWith("memory_")) cur = 0;
      else {
        cur++;
        if (cur > best) best = cur;
      }
    }
  }
  return best;
}
// [macro-fusion 0.2.133] 事故触发的反思。原来的判定只看「连续干了几个非记忆工具步」，
// 于是「没出错但干了很多活」会反思，「闯了祸但活不多」反而不反思——方向刚好拧着。
// 这里把用户原话里的强信号单独算一遍：出现就立刻反思（阈值降到 1 步），不必攒够轮数。
// 词表只收「明确的纠正/事故/支出」语气，不收泛泛的提问词，免得白天每轮都触发。
var REFLECT_CUE = /(他妈|tmd|谁他妈|谁允许|擅自|不许|不允许|别再|求你了|搞坏|弄坏|删错|误删|亏了|花掉|花了|烧钱|翻车|回滚|怎么又|凭什么|说了多少遍|长点记性)/;
function reflectCueHit(text) {
  return REFLECT_CUE.test(String(text ?? "")) ? 1 : 0;
}
// [macro-fusion 0.2.134] 反思由「发生了什么」触发，不由「攒了几步」触发。两档：
//   hard（NEED=1，当场反思）：这一轮以错误收场 / 同一个工具连挂 ≥2 次 / 一轮挂 ≥3 次 /
//                            记忆工具自己挂了（这条最重：是插件自己的 bug）/ 用户用了纠正语气。
//   soft（NEED 压到 3）：只零星挂了一次——说明某处没按预期走，但不必当场打断任务。
// 判据只认事件：干了很多活但一切正常不该反思，刚开个头就闯了祸必须反思。
var INCIDENT_BURST = 3;
var INCIDENT_RETRY = 2;
var INCIDENT_SOFT_NEED = 3;
function incidentOf(turn, endReason) {
  const info = turn ?? {};
  const toolErrors = Number(info.toolErrors ?? 0);
  const memoryErrors = Number(info.memoryErrors ?? 0);
  const worstFail = Number(info.worstFail ?? 0);
  const cue = Number(info.cue ?? 0);
  const kinds = [];
  if (memoryErrors > 0) kinds.push("memory-error");
  if (endReason === "error") kinds.push("turn-error");
  if (worstFail >= INCIDENT_RETRY) kinds.push("retry-storm");
  if (toolErrors >= INCIDENT_BURST) kinds.push("error-burst");
  if (cue > 0) kinds.push("user-cue");
  const base = {
    toolErrors,
    memoryErrors,
    worstFail,
    worstTool: info.worstTool,
    failedTools: Array.isArray(info.failedTools) ? info.failedTools : []
  };
  if (kinds.length > 0) return { ...base, level: 2, kinds };
  if (toolErrors > 0) return { ...base, level: 1, kinds: ["tool-error"] };
  return { ...base, level: 0, kinds: [] };
}
function reflectNeed(incident, turns) {
  const cadence = Number.isFinite(turns) && turns > 0 ? Math.floor(turns) : 7;
  if ((incident?.level ?? 0) >= 2) return 1;
  if ((incident?.level ?? 0) === 1) return Math.min(INCIDENT_SOFT_NEED, cadence);
  return cadence;
}
// 事故文案走 labels，但用户改过 prompts 覆盖目录时缺键不许把整轮反思炸掉。
function safeKeyed(key, fallback, params) {
  let text = fallback;
  try {
    text = keyedValue("labels", key);
  } catch {
  }
  return fillTemplate(text, params ?? {});
}
function incidentLines(incident, repeat) {
  if (!incident || incident.level === 0) return [];
  const lines = [safeKeyed("reflect.incidentHead", "\u26a0\ufe0f 这一轮出了事故，所以是插件自己把你叫来反思（不是攒够轮数）：")];
  if (incident.toolErrors > 0) {
    const detail = (incident.failedTools ?? []).map(([n, c]) => `${n} \u00d7${c}`).join("\u3001");
    lines.push(safeKeyed("reflect.incidentTools", "\u00b7 工具失败 {count} 次{detail}", { count: incident.toolErrors, detail: detail ? safeKeyed("reflect.incidentDetail", "\uff08{detail}\uff09", { detail }) : "" }));
  }
  if (incident.kinds.includes("turn-error")) lines.push(safeKeyed("reflect.incidentTurnError", "\u00b7 这一轮以错误收场（endReason=error）。"));
  if (incident.kinds.includes("user-cue")) lines.push(safeKeyed("reflect.incidentCue", "\u00b7 用户用了纠正或事故语气，可能刚发生了他不想再见到的事。"));
  if (repeat && repeat.count > 0) {
    lines.push(safeKeyed("reflect.incidentRepeat", "\u00b7 这不是第一次：{detail} 已经被同一类故障撞过。孤立抖动解释不了它，写 lesson，不要只补一句结论。", { detail: describeRepeat(repeat) }));
  }
  if (repeat && repeat.unfixed > 0) {
    lines.push(safeKeyed("reflect.incidentNoFollowup", "\u00b7 \u4e0a\u4e00\u6b21\u4e5f\u53cd\u601d\u8fc7\uff0c\u4f46\u4e8b\u540e\u4ec0\u4e48\u90fd\u6ca1\u5199\u8fdb\u8bb0\u5fc6\uff08\u8d26\u672c\u8bb0\u7740 {count} \u6b21\uff09\u2014\u2014\u90a3\u6b21\u53cd\u601d\u7b49\u4e8e\u767d\u505a\uff0c\u8fd9\u6b21\u522b\u53ea\u5199\u611f\u60f3\u3002", { count: repeat.unfixed }));
  }
  lines.push(safeKeyed("reflect.incidentAsk", "先判断：这是真事故，还是一次能自己恢复的抖动？真事故写 lesson（现象 → 根因 → 修法 → 下次怎么早发现）；抖动把结论补进已有条目，别为它新建噪声。"));
  return lines;
}
// [macro-fusion 0.2.135] 一次事故可能是抖动，同一件事第二次就不是了。可「第几次」没法从这一轮的
// 上下文里看出来：反思发生在轮末，前几轮的失败早被窗口截断。所以落一本纯文本账（jsonl，一行一次
// 硬档事故），下一轮硬档先翻 24 小时内的账，翻到了就在反思报文里点名。坏一行只丢一行，不当事故。
var INCIDENT_LEDGER = "incident-ledger.jsonl";
var INCIDENT_LEDGER_MAX = 200;
var INCIDENT_WINDOW_MS = 24 * 60 * 60 * 1e3;
var REFLECT_PENDING = "reflect-pending.json";
var NO_FOLLOWUP = "no-followup";
function incidentLedgerPath(workspace, dir) {
  return join9(workspace, dir || ".dsh-meow", INCIDENT_LEDGER);
}
function readIncidentLedger(workspace, dir, now = Date.now()) {
  const file = incidentLedgerPath(workspace, dir);
  let raw;
  try {
    raw = readFileSync8(file, "utf8");
  } catch {
    return { rows: [], missing: "no-ledger" };
  }
  const rows = [];
  for (const line of String(raw).split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    let row;
    try {
      row = JSON.parse(t);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const at = Number(row.t);
    if (!Number.isFinite(at) || at <= 0) continue;
    if (now - at > INCIDENT_WINDOW_MS) continue;
    rows.push({
      t: at,
      kinds: Array.isArray(row.kinds) ? row.kinds.filter((k) => typeof k === "string") : [],
      tool: typeof row.tool === "string" ? row.tool : void 0,
      errors: Number(row.errors ?? 0)
    });
  }
  rows.sort((a, b) => a.t - b.t);
  return { rows, missing: void 0 };
}
function incidentRepeatOf(workspace, dir, incident, now = Date.now()) {
  if (!incident || incident.level < 2) return void 0;
  const tool = incident.worstTool;
  const hasTool = typeof tool === "string" && tool !== "";
  const { rows } = readIncidentLedger(workspace, dir, now);
  const same = hasTool ? rows.filter((r) => r.tool === tool) : [];
  const unfixed = rows.filter((r) => r.kinds.includes(NO_FOLLOWUP)).length;
  if (same.length < 1 && unfixed === 0) return void 0;
  const kinds = [];
  for (const r of same) for (const k of r.kinds) if (!kinds.includes(k)) kinds.push(k);
  return {
    count: same.length,
    tool: hasTool ? tool : void 0,
    first: same.length > 0 ? same[0].t : void 0,
    last: same.length > 0 ? same[same.length - 1].t : void 0,
    kinds,
    windowHours: Math.round(INCIDENT_WINDOW_MS / 36e5),
    unfixed
  };
}
function describeRepeat(repeat) {
  const ago = Math.max(1, Math.round((Date.now() - repeat.last) / 6e4));
  const gap = ago >= 60 ? `${Math.round(ago / 60)} 小时前` : `${ago} 分钟前`;
  return `${repeat.tool}（同一工具 ${repeat.count} 次，最近一次 ${gap}）`;
}
function recordIncident(workspace, dir, incident, sid, now = Date.now()) {
  if (!incident || incident.level < 2) return false;
  const file = incidentLedgerPath(workspace, dir);
  try {
    mkdirSync6(join9(workspace, dir || ".dsh-meow"), { recursive: true });
  } catch {
  }
  try {
    const row = {
      t: now,
      sid: typeof sid === "string" ? sid.slice(0, 12) : void 0,
      kinds: incident.kinds,
      tool: incident.worstTool,
      errors: incident.toolErrors,
      memoryErrors: incident.memoryErrors
    };
    let prev = "";
    try {
      prev = readFileSync8(file, "utf8");
    } catch {
      prev = "";
    }
    const kept = String(prev).split("\n").filter((l) => l.trim() !== "");
    kept.push(JSON.stringify(row));
    writeFileSync5(file, `${kept.slice(-INCIDENT_LEDGER_MAX).join("\n")}\n`);
    return true;
  } catch {
    return false;
  }
}

// [macro-fusion 0.2.135] 反思最怕「反思了，但什么也没改」：报文发出去了、模型点了个头、
// 库里一字未动，下一个会话拿着同一份烂代码再来一遍。所以发反思时留一张待验卡，
// 到下一轮收尾时查这一轮有没有真的写进记忆（memory_remember / memory_update）。
// 没写就记一条 no-followup：下一轮再出事故时，报文里会直接点名「上次反思等于白做」。
function reflectPendingPath(workspace, dir) {
  return join9(workspace, dir || ".dsh-meow", REFLECT_PENDING);
}
function readReflectPending(workspace, dir) {
  try {
    const row = JSON.parse(readFileSync8(reflectPendingPath(workspace, dir), "utf8"));
    const at = Number(row?.t);
    if (!Number.isFinite(at) || at <= 0) return void 0;
    return {
      t: at,
      kinds: Array.isArray(row.kinds) ? row.kinds.filter((k) => typeof k === "string") : [],
      tool: typeof row.tool === "string" ? row.tool : void 0
    };
  } catch {
    return void 0;
  }
}
function writeReflectPending(workspace, dir, incident, now = Date.now()) {
  try {
    mkdirSync6(join9(workspace, dir || ".dsh-meow"), { recursive: true });
    writeFileSync5(reflectPendingPath(workspace, dir), JSON.stringify({
      t: now,
      kinds: Array.isArray(incident?.kinds) ? incident.kinds : [],
      tool: incident?.worstTool
    }));
    return true;
  } catch {
    return false;
  }
}
function clearReflectPending(workspace, dir) {
  try {
    unlinkSync(reflectPendingPath(workspace, dir));
    return true;
  } catch {
    return false;
  }
}
function appendLedgerRow(workspace, dir, row) {
  const file = incidentLedgerPath(workspace, dir);
  try {
    mkdirSync6(join9(workspace, dir || ".dsh-meow"), { recursive: true });
  } catch {
  }
  try {
    let prev = "";
    try {
      prev = readFileSync8(file, "utf8");
    } catch {
      prev = "";
    }
    const kept = String(prev).split("\n").filter((l) => l.trim() !== "");
    kept.push(JSON.stringify(row));
    writeFileSync5(file, `${kept.slice(-INCIDENT_LEDGER_MAX).join("\n")}\n`);
    return true;
  } catch {
    return false;
  }
}
function recordUnfixed(workspace, dir, pending, now = Date.now()) {
  return appendLedgerRow(workspace, dir, {
    t: now,
    kinds: [NO_FOLLOWUP],
    tool: "reflect",
    errors: 0,
    memoryErrors: 0,
    after: Array.isArray(pending?.kinds) ? pending.kinds : []
  });
}
function settleReflect(workspace, dir, memoryWrites, now = Date.now()) {
  const pending = readReflectPending(workspace, dir);
  if (!pending) return void 0;
  clearReflectPending(workspace, dir);
  if (now - pending.t > INCIDENT_WINDOW_MS) return void 0;
  if (Number(memoryWrites ?? 0) > 0) return { ok: true, kinds: pending.kinds };
  recordUnfixed(workspace, dir, pending, now);
  return { ok: false, kinds: pending.kinds, tool: pending.tool };
}
function buildReflectMessage(workspace, turnText, dir = ".dsh-meow", incident, repeat) {
  const db = getDb(workspace, dir);
  const prompt = resolveSlotText("reflect", { projectList: projectNamesText(db.listProjectNames()) });
  const head = `${REFLECT_MARKER} ${prompt}`;
  const extra = incidentLines(incident, repeat);
  const text = extra.length > 0 ? `${head}

${extra.join("\n")}` : head;
  return createUserMessage2({ content: [{ type: "text", text }], source: PLUGIN_SOURCE });
}
function projectNamesText(projectNames) {
  return projectNames.length > 0 ? projectNames.join(" / ") : keyedValue("labels", "reflect.noProjects");
}

// src/auth-gate.ts
function connectionAuthOf(ctx) {
  let connection;
  try {
    connection = ctx.connection;
  } catch {
    connection = void 0;
  }
  if ((connection === void 0 || connection.requestRejection === void 0) && typeof ctx.get === "function") {
    try {
      connection = ctx.get("connection");
    } catch {
      connection = void 0;
    }
  }
  return connection;
}
function fenceHeader(headers, name2) {
  if (headers === void 0 || headers === null || typeof headers !== "object") return void 0;
  const h = headers;
  const getter = h.get;
  if (typeof getter === "function") {
    try {
      const v = h.get(name2);
      if (typeof v === "string") return v;
    } catch {
    }
  }
  const value = h[name2];
  if (typeof value === "string") return value;
  const lower = h[name2.toLowerCase()];
  return typeof lower === "string" ? lower : void 0;
}
function parseAuthority(authority) {
  try {
    const url = new URL(`http://${authority}`);
    return { hostname: url.hostname, host: url.host, port: url.port };
  } catch {
    return void 0;
  }
}
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
  return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === void 0) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
  });
}
function legacyHostFence(req, trustedHosts) {
  const host = fenceHeader(req?.headers, "host");
  if (host === void 0) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === void 0) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (fenceHeader(req?.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = fenceHeader(req?.headers, "origin");
  if (origin === void 0) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}
function authGate(connection, handler) {
  return (req, res) => {
    const reject = connection?.requestRejection;
    if (typeof reject === "function") {
      const rejection = reject.call(connection, req);
      if (rejection !== void 0) {
        res.writeHead(rejection, { "content-type": "text/plain; charset=utf-8" });
        res.end(rejection === 401 ? "unauthorized" : "forbidden");
        return;
      }
      handler(req, res);
      return;
    }
    if (connection !== void 0) {
      if (!legacyHostFence(req, connection.trustedHosts ?? [])) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("forbidden");
        return;
      }
      handler(req, res);
      return;
    }
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("meow-memory: authentication service unavailable");
  };
}
function authGateLazy(ctx, handler, opts = {}) {
  let degradedWarned = false;
  return (req, res) => {
    const connection = connectionAuthOf(ctx);
    if (connection === void 0) {
      if (!degradedWarned) {
        degradedWarned = true;
        opts.onDegraded?.();
      }
      if (!legacyHostFence(req, [])) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("forbidden");
        return;
      }
      handler(req, res);
      return;
    }
    authGate(connection, handler)(req, res);
  };
}

// src/dream-signal.ts
import { existsSync as existsSync8 } from "node:fs";
function headerOf(s) {
  const h = s.header;
  if (h !== null && typeof h === "object") {
    return { id: typeof h.id === "string" ? h.id : "", cwd: typeof h.cwd === "string" && h.cwd.length > 0 ? h.cwd : void 0 };
  }
  return { id: typeof s.id === "string" ? s.id : "", cwd: typeof s.cwd === "string" && s.cwd.length > 0 ? s.cwd : void 0 };
}
function collectDreamStates(sessions, dir = ".dsh-meow") {
  const dreamed = [];
  const dreaming = [];
  // [macro-fusion 0.2.99] 正在整理的那一轮把规模也带出来（键=会话 id）。
  // 老调用方只读 dreamed/dreaming 两个数组，多出来的一列不影响它们。
  const plans = {};
  const opened = /* @__PURE__ */ new Set();
  for (const s of sessions) {
    const { cwd } = headerOf(s);
    if (typeof cwd !== "string" || cwd.length === 0 || opened.has(cwd)) continue;
    opened.add(cwd);
    if (!existsSync8(memoryDbPath(cwd, dir))) continue;
    try {
      const db = getDb(cwd, dir);
      for (const w of db.listWindows()) {
        const lease = db.getDreamLease(w.session_id);
        if (lease !== null && Date.now() - lease.progress_at <= DREAM_LEASE_MS) {
          dreaming.push(w.session_id);
          const rawPlan = db.getDreamMeta(`dreamdigest:${w.session_id}`);
          if (typeof rawPlan === "string" && rawPlan !== "") {
            try {
              plans[w.session_id] = JSON.parse(rawPlan);
            } catch {
            }
          }
        } else if (w.last_dream_time !== null && (w.last_event_time ?? 0) <= w.last_dream_time) {
          dreamed.push(w.session_id);
        }
      }
    } catch {
    }
  }
  return { dreamed, dreaming, plans };
}
// [macro-fusion 0.2.99] 面板要念「此刻正在整理的那一轮看到多少条」：账本是事后对账，
// 这里读的是活的 lease + dreamdigest meta。三态与 readDreamLedger 一样分开说——
// 「没工作区」「还没建库」「库读不开」都不是「现在没在整理」。
function readLiveDream(workspace, dir = ".dsh-meow") {
  const ws = String(workspace ?? "");
  if (ws === "") return { sessionIds: [], plans: {}, dbPath: "", missing: "no-workspace" };
  const path = memoryDbPath(ws, dir);
  if (!existsSync8(path)) return { sessionIds: [], plans: {}, dbPath: path, missing: "no-db" };
  try {
    const db = getDb(ws, dir);
    const sessionIds = [];
    const plans = {};
    for (const w of db.listWindows()) {
      const lease = db.getDreamLease(w.session_id);
      if (lease === null || Date.now() - lease.progress_at > DREAM_LEASE_MS) continue;
      sessionIds.push(w.session_id);
      const rawPlan = db.getDreamMeta(`dreamdigest:${w.session_id}`);
      if (typeof rawPlan === "string" && rawPlan !== "") {
        try {
          plans[w.session_id] = JSON.parse(rawPlan);
        } catch {
        }
      }
    }
    return { sessionIds, plans, dbPath: path, missing: "" };
  } catch (e) {
    return { sessionIds: [], plans: {}, dbPath: path, missing: `read-failed: ${e?.message ?? e}` };
  }
}
var DreamStateBroadcast = class {
  clients = /* @__PURE__ */ new Set();
  /**
   * SSE 连接入口（路由 handler）：应答 200 text/event-stream 并挂起连接。
   * 连接关闭（客户端断开/服务端 res.end）时自动从集合移除。
   */
  handle(_req, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    res.write(": connected\n\n");
    this.clients.add(res);
    const drop = () => {
      this.clients.delete(res);
    };
    res.on("close", drop);
  }
  /**
   * 广播一个状态变化事件：'dreamed'=整理完成加月亮、'dreaming'=dream 开始呼吸灯、
   * 'active'=有新活动去月亮、'skip'/'unskip'=用户切换跳过自动 dream 标记
   * （v0.16.0；dream-icon 端按未知状态幂等忽略，dream-skip 端据此同步本地集合）。
   */
  broadcast(sessionId, state, detail) {
    this.write(sessionId, state, detail);
  }
  /**
   * 广播一次门控变化（issue #38：state='scope' + field/value 明细）。
   * dream 档变化时 host 会同时广播旧 'skip'/'unskip'（dream-icon 旧通道兼容），
   * inject/write 档只有 scope 事件——面板与行图标的新变体消费它。
   */
  broadcastScope(sessionId, field, value) {
    this.write(sessionId, "scope", { field, value });
  }
  write(sessionId, state, detail) {
    const data = JSON.stringify(detail === void 0 ? { sessionId, state } : { sessionId, state, ...detail });
    for (const res of this.clients) {
      try {
        res.write(`event: dream
id: ${Date.now()}
data: ${data}

`);
      } catch {
        this.clients.delete(res);
      }
    }
  }
  /** 关闭全部连接（插件卸载时调用）。 */
  dispose() {
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
      }
    }
    this.clients.clear();
  }
};

// src/index.ts
var WELCOME_GUIDE_SEEN_ID = "__welcomeGuide__";
var FIRST_CREATE_NOTICE_SEEN_ID = "__firstCreateNotice__";
var name = "meow-memory";
var inject = ["tools"];
var META_SECTION_NAME2 = "__meta__";
function encodeMetaSection(meta) {
  return { name: META_SECTION_NAME2, text: JSON.stringify(meta) };
}
function createMemorySnapshotMessage(text, meta) {
  return createUserMessage3({
    content: [{ type: "text", text }],
    source: {
      ...PLUGIN_SOURCE,
      form: "snapshot",
      sections: [encodeMetaSection(meta), { name: "\u957F\u671F\u8BB0\u5FC6", text }]
    }
  });
}
function createMemoryNoticeMessage(text) {
  return createUserMessage3({
    content: [{ type: "text", text }],
    source: {
      ...PLUGIN_SOURCE,
      form: "notice",
      summary: boundContextSummary(text.replace(/\s+/g, " ").trim())
    }
  });
}
function getMemoryGuide() {
  return resolveSlotText("system-guide");
}
var applyCount = 0;
var evtCount = 0;
var perfBoot = Date.now();
var lastPerfLog = Date.now();
function perf(msg) {
  try {
    const file = join9(activeHomeDir(), "perf.log");
    mkdirSync6(dirname6(file), { recursive: true });
    appendFileSync2(file, `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`);
  } catch {
  }
}
function perfEvent() {
  evtCount++;
  const now = Date.now();
  if (now - lastPerfLog >= 5e3) {
    const elapsed = (now - perfBoot) / 1e3;
    perf(`evt total=${evtCount} elapsed=${elapsed.toFixed(1)}s rate=${(evtCount / Math.max(elapsed, 1e-3)).toFixed(1)}/s`);
    lastPerfLog = now;
  }
}
var LOG_RETENTION_MS = 48 * 60 * 60 * 1e3;
var PERF_LOG_ROTATE_BYTES = 5 * 1024 * 1024;
var HOME_LOGS = ["perf.log", "perf.log.old", "settings-register-error.log", "apply-error.log"];
function sweepHomeLogs(dir = activeHomeDir(), now = Date.now()) {
  const swept = [];
  const cutoff = now - LOG_RETENTION_MS;
  for (const name2 of HOME_LOGS) {
    if (!name2.endsWith(".log")) continue;
    try {
      const file = join9(dir, name2);
      if (statSync3(file).mtimeMs < cutoff) {
        unlinkSync(file);
        swept.push(name2);
      }
    } catch {
    }
  }
  let rotated = false;
  try {
    const cur = join9(dir, "perf.log");
    if (statSync3(cur).size > PERF_LOG_ROTATE_BYTES) {
      renameSync6(cur, join9(dir, "perf.log.old"));
      rotated = true;
    }
  } catch {
  }
  return { swept, rotated };
}
function homeDirPresetsDefault() {
  try {
    return homeDirPresets();
  } catch {
    return {};
  }
}
var config = z.object({
  /** 总开关：false 时注入、反思、工具全部停用。 */
  enabled: z.boolean().default(true),
  /** 记忆目录（相对工作区）。 */
  projectDir: z.string().default(".dsh-meow"),
  /** 全局目录（实例级数据家：日志/window-index/prompts 覆盖层/migrate 状态）。
   *  'default'=平台用户主目录 | 'dsh-storage'=<DSH home>/storages/meow-memory |
   *  'plugin-root'=<插件根>/storage | 绝对路径=自定义。''/缺省=默认。
   *  变更即自动迁移旧目录内容（同盘移动/跨盘复制，旧目录绝不自动删）。 */
  homeDir: z.string().required(false),
  /** homeDirPresets（只读 meta，非配置）：三个全局目录预设的实际落点，设置页
   *  radio 旁显示。0.1.7 的 base 视图 = 宿主 resolveConfig(inherited) 后按 schema
   *  键投影——不在 schema 声明的键宿主永远剥掉，cordis.patch.yml 通道也走不通
   * （patch config 会撞设置写入的全等比对死锁，2026-09-25 实证），所以只能住进
   *  schema 默认值，由官方深填机带进 base/value 两视图。默认值在 schema 构建时
   *  取一次：预设落点因机器/安装位置而异、进程内不变（热切换只改 active，不改
   *  预设定义）。不进 CONFIG_DEFAULTS——「恢复默认」绝不能把它当字段写进 user 层；
   *  它也不是设置页 FieldSpec，页面与 resolveConfig 都不读它。 */
  homeDirPresets: z.dict(z.string()).default(homeDirPresetsDefault()),
  /** 关键词命中条数上限（fact/lesson/rules/topic 短条目，每条用户消息命中注入）。 */
  hitTopK: z.number().min(0).max(10).default(2),
  /** 导引标题截断长度。 */
  titleMax: z.number().min(10).max(200).default(40),
  /** 是否在 ReAct 任务结束后自动注入反思。 */
  reflect: z.boolean().default(true),
  /** 单任务内连续工具 step 达到该值才在结束时触发反思（用户拍板：react ≥7 轮）。 */
  reflectTurns: z.number().min(1).max(50).default(7),
  /** 首次打开库时自动迁移旧 PROJECT.md。 */
  autoMigrate: z.boolean().default(true),
  /** prompt 语言（prompts/<lang>/ 语言包目录名）：决定注入/反思/dream 文案、工具
   *  描述与 BM25 分词的语言。**首次使用建议显式配置**——记忆条目语言必须与 BM25
   *  关键词语言一致，否则检索匹配率崩（详见 README）。zh=内置默认；en 等社区语言包
   *  放 lib/prompts/（随包）或 homedir/.dsh-meow/prompts/（实例覆盖，可只覆盖部分槽位）。
   *  不设置（undefined）：运行时按 zh 跑，且插件生效后的第一条真实用户消息会注入
   *  「首次设置」引导任务（AI 判断用户语言并完成配置，每会话至多提醒一次）。 */
  promptLang: z.string().required(false),
  /** 空闲整理（dream）。 */
  dream: z.object({
    enabled: z.boolean().default(true),
    /** 窗口空闲多少分钟后允许 dream（用户拍板 2026-08-19：3 小时）。 */
    idleMinutes: z.number().min(1).default(180),
    /** 抑制时段（目标时区，"HH:MM" 起止）：这些时段内不触发 dream。 */
    suppressWindows: z.array(z.object({ start: z.string(), end: z.string() })).default([{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }]),
    /** 每个抑制时段开始前追加的不触发分钟数（峰时前 15 分钟也不触发）。 */
    suppressLeadMinutes: z.number().min(0).max(120).default(15),
    checkMinutes: z.number().min(1).default(15),
    // 用户系统是美区时间（隐私设置），抑制时段按中国时区计算
    timeZone: z.string().default("Asia/Shanghai"),
    /** rules 防 churn（测评 2026-08-25）：updated_at 距今超该天数的稳定准则不进 dream 第 1 轮清单；0=不过滤。 */
    rulesReviewDays: z.number().min(0).default(DEFAULT_RULES_REVIEW_DAYS)
  }).default({}),
  /** 记忆停用工作区名单（#28）：cwd 精确匹配（路径归一：斜杠统一 + 去尾斜杠 + 大小写
   *  不敏感）。命中的工作区完全停用记忆（读/整理/写全拒，含手动 /dream）——一次性
   *  任务的工作区不污染记忆库。 */
  disabledWorkspaces: z.array(z.string()).default([]),
  /** 记忆库自动备份（#37，默认关）：每次 dream 收尾把 memory.db 快照轮转到
   *  memory.db.bak（VACUUM INTO 一致性备份，mtime 判增量）。注册期消费，改动需重载。 */
  backup: z.object({
    enabled: z.boolean().default(false)
  }).default({}),
  /** 整理任务的模型（可选换模型）。反思/梦境永远在主窗口执行（steer）——配置了
   *  model 时仅在这两类轮的请求上经 agent/request waterfall 覆盖 provider/model，
   *  轮次结束自动换回主模型；不再提供"独立执行"开关（v0.24 移除）。 */
  delegate: z.object({
    /** 反思/梦境轮换用模型：留空 = 全程主模型；'provider/model'（dsh route 格式）
     *  指定 provider+model，'model' 只换 model（provider 继承主会话）。 */
    model: z.string().required(false)
  }).default({})
});
Object.assign(config.meta, { volatile: true });
var SETTINGS_NS = "meow-memory";
var TIME_OF_DAY_RE = /^\d{1,2}:\d{2}$/;
function validateConfigUserLayer(value) {
  if (value === void 0 || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("\u914D\u7F6E\u5FC5\u987B\u662F\u5BF9\u8C61");
  }
  const v = value;
  const reqBool = (k) => {
    if (v[k] !== void 0 && typeof v[k] !== "boolean") throw new Error(`${k} \u5FC5\u987B\u662F\u5E03\u5C14`);
  };
  const reqStr = (k) => {
    if (v[k] !== void 0 && typeof v[k] !== "string") throw new Error(`${k} \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`);
  };
  const reqNum = (k) => {
    if (v[k] === void 0) return;
    if (typeof v[k] !== "number" || !Number.isFinite(v[k])) throw new Error(`${k} \u5FC5\u987B\u662F\u6570\u5B57`);
  };
  reqBool("enabled");
  reqStr("projectDir");
  reqStr("homeDir");
  reqNum("hitTopK");
  reqNum("titleMax");
  reqBool("reflect");
  reqNum("reflectTurns");
  reqBool("autoMigrate");
  reqStr("promptLang");
  const d = v.dream;
  if (d !== void 0) {
    if (d === null || typeof d !== "object" || Array.isArray(d)) throw new Error("dream \u5FC5\u987B\u662F\u5BF9\u8C61");
    const dd = d;
    if (dd.enabled !== void 0 && typeof dd.enabled !== "boolean") throw new Error("dream.enabled \u5FC5\u987B\u662F\u5E03\u5C14");
    reqNum("dream.idleMinutes");
    if (dd.idleMinutes !== void 0 && (typeof dd.idleMinutes !== "number" || !Number.isFinite(dd.idleMinutes))) throw new Error("dream.idleMinutes \u5FC5\u987B\u662F\u6570\u5B57");
    for (const k of ["suppressLeadMinutes", "checkMinutes", "rulesReviewDays"]) {
      if (dd[k] !== void 0 && (typeof dd[k] !== "number" || !Number.isFinite(dd[k]))) throw new Error(`dream.${k} \u5FC5\u987B\u662F\u6570\u5B57`);
    }
    if (dd.timeZone !== void 0 && typeof dd.timeZone !== "string") throw new Error("dream.timeZone \u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
    if (dd.suppressWindows !== void 0) {
      if (!Array.isArray(dd.suppressWindows)) throw new Error("dream.suppressWindows \u5FC5\u987B\u662F\u6570\u7EC4");
      for (const w of dd.suppressWindows) {
        const win = w;
        if (typeof win !== "object" || win === null || typeof win.start !== "string" || typeof win.end !== "string" || !TIME_OF_DAY_RE.test(win.start) || !TIME_OF_DAY_RE.test(win.end)) {
          throw new Error('dream.suppressWindows \u6BCF\u9879\u5FC5\u987B\u662F { start: "HH:MM", end: "HH:MM" }');
        }
      }
    }
  }
  const dg = v.delegate;
  if (dg !== void 0) {
    if (dg === null || typeof dg !== "object" || Array.isArray(dg)) throw new Error("delegate \u5FC5\u987B\u662F\u5BF9\u8C61");
    const ddg = dg;
    if (ddg.model !== void 0 && typeof ddg.model !== "string") throw new Error("delegate.model \u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
    if (ddg.effort !== void 0 && typeof ddg.effort !== "string") throw new Error("delegate.effort \u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
  }
  if (v.projectDir !== void 0) {
    if (v.projectDir === null || typeof v.projectDir !== "string") throw new Error("projectDir \u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
    if (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(v.projectDir.trim())) {
      throw new Error("projectDir \u5FC5\u987B\u662F\u76F8\u5BF9\u5DE5\u4F5C\u533A\u7684\u8DEF\u5F84\uFF08\u5982 .dsh-meow\uFF09\u2014\u2014\u8BB0\u5FC6\u5E93\u6309\u5DE5\u4F5C\u533A\u9694\u79BB\u662F\u8BBE\u8BA1\u5185\u884C\u4E3A\uFF0C\u8DE8\u5DE5\u4F5C\u533A\u5171\u4EAB\u8BB0\u5FC6\u6682\u65E0\u652F\u6301");
    }
  }
  if (v.disabledWorkspaces !== void 0) {
    if (!Array.isArray(v.disabledWorkspaces)) throw new Error("disabledWorkspaces \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4");
    for (const p of v.disabledWorkspaces) {
      if (typeof p !== "string" || p.trim().length === 0) throw new Error("disabledWorkspaces \u6BCF\u9879\u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32");
    }
  }
  if (v.backup !== void 0) {
    if (v.backup === null || typeof v.backup !== "object" || Array.isArray(v.backup)) throw new Error("backup \u5FC5\u987B\u662F\u5BF9\u8C61");
    const bkv = v.backup;
    if (bkv.enabled !== void 0 && typeof bkv.enabled !== "boolean") throw new Error("backup.enabled \u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  }
}
function readConfigRoot(value) {
  const ref = value;
  return ref !== null && typeof ref === "object" && typeof ref.get === "function" ? ref.get() : value;
}
function mergeConfigLayer(patch, user) {
  patch = readConfigRoot(patch);
  user = readConfigRoot(user);
  if (user === void 0 || user === null || typeof user !== "object") return patch;
  const base = typeof patch === "object" && patch !== null ? { ...patch } : {};
  for (const [key, value] of Object.entries(user)) {
    if (key === "dream" || key === "delegate") {
      const pv = base[key] ?? {};
      const uv = typeof value === "object" && value !== null ? value : {};
      base[key] = { ...pv, ...uv };
    } else {
      base[key] = value;
    }
  }
  return base;
}
function resolveConfig(config2) {
  const c = config2 ?? {};
  const d = c.dream ?? {};
  const dg = c.delegate ?? {};
  const bk = c.backup ?? {};
  return {
    enabled: c.enabled ?? true,
    projectDir: c.projectDir ?? ".dsh-meow",
    homeDir: typeof c.homeDir === "string" ? c.homeDir : void 0,
    hitTopK: c.hitTopK ?? 2,
    titleMax: c.titleMax ?? 40,
    reflect: c.reflect ?? true,
    reflectTurns: c.reflectTurns ?? 7,
    autoMigrate: c.autoMigrate ?? true,
    promptLang: typeof c.promptLang === "string" && c.promptLang.trim() ? c.promptLang.trim() : void 0,
    dream: {
      enabled: d.enabled ?? true,
      idleMinutes: d.idleMinutes ?? 180,
      suppressWindows: d.suppressWindows ?? [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }],
      suppressLeadMinutes: d.suppressLeadMinutes ?? 15,
      checkMinutes: d.checkMinutes ?? 15,
      timeZone: d.timeZone ?? "Asia/Shanghai",
      rulesReviewDays: d.rulesReviewDays ?? DEFAULT_RULES_REVIEW_DAYS
    },
    delegate: (() => {
      const effortRaw = typeof dg.effort === "string" ? dg.effort.trim() : "";
      return { modelSpec: parseModelSpec(dg.model), effort: effortRaw === "" ? void 0 : effortRaw };
    })(),
    disabledWorkspaces: Array.isArray(c.disabledWorkspaces) ? c.disabledWorkspaces.map((p) => String(p).trim()).filter((p) => p.length > 0) : [],
    backup: {
      enabled: bk.enabled ?? false
    }
  };
}
function workspaceOfAgent(agent) {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
}
function sessionIdOfAgent(agent) {
  const id = agent?.session?.header?.id;
  return typeof id === "string" && id.length > 0 ? id : "unknown";
}
function sessionEventsOf(session) {
  if (typeof session?.ownEvents === "function") {
    const evs2 = session.ownEvents();
    return Array.isArray(evs2) ? evs2 : [];
  }
  const evs = session?.events;
  return Array.isArray(evs) ? evs : [];
}
function wasDreamTurn(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "turn/start") break;
    if (e?.type === "user/message" && isMeowSource(e.data?.source)) {
      if ((e.data.content ?? []).some((b) => b.type === "text" && b.text?.includes(DREAM_MARKER))) return true;
    }
  }
  return false;
}
function isMemoryTaskTurn(events) {
  let startIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === "turn/start") {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return false;
  for (let i = startIdx; i < events.length; i++) {
    const e = events[i];
    if (e?.type !== "user/message") continue;
    if (e.data?.source?.kind === "user") continue;
    const text = (e.data?.content ?? []).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text ?? "").join(" ");
    if (text.includes(REFLECT_MARKER) || text.includes(DREAM_MARKER)) return true;
  }
  return false;
}
function mainRouteOf(config2) {
  return { provider: config2.provider, model: config2.model, ...config2.reasoningEffort === void 0 ? {} : { reasoningEffort: String(config2.reasoningEffort) } };
}
function userSelectedAfterOverride(events, route) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "model/selection") return true;
    if (e?.type === "request/header") {
      const c = e.data?.header?.config;
      if (c?.provider !== route.provider || c?.model !== route.model) return false;
    }
  }
  return false;
}
function lastTurnEndReason(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "turn/start") break;
    if (e?.type === "turn/end" && typeof e.data?.reason?.kind === "string") return e.data.reason.kind;
  }
  return null;
}
async function apply(ctx, config2) {
  try {
    return await applyInner(ctx, config2);
  } catch (e) {
    try {
      const errFile = join9(activeHomeDir(), "apply-error.log");
      mkdirSync6(dirname6(errFile), { recursive: true });
      appendFileSync2(errFile, `[${(/* @__PURE__ */ new Date()).toISOString()}] ${e instanceof Error ? e.stack ?? e.message : String(e)}
`);
    } catch {
    }
    throw e;
  }
}
function installSettingsSectionCompat(settingsCtx, ownerCtx, ns, schema, entry, hooks) {
  const sctx = settingsCtx;
  const settings = sctx.settings;
  if (typeof settings.installSection === "function") {
    settings.installSection(ownerCtx, ns, schema, entry, hooks);
    return;
  }
  const register = settings.register;
  if (typeof register !== "function") {
    const proto = Object.getPrototypeOf(settings);
    if (proto !== null && typeof proto.describe === "function") return;
    ownerCtx.logger.warn("meow-memory: settings \u670D\u52A1\u65E0 installSection/register\uFF08\u975E 0.1.7+ \u5F62\u6001\uFF09\uFF0C\u8DF3\u8FC7\u8BBE\u7F6E\u533A\u6CE8\u518C\uFF08\u914D\u7F6E\u8D70 patch \u5C42\uFF09");
    return;
  }
  const scope = register.call(settings, ns, schema, {
    base: entry,
    ...hooks.validate === void 0 ? {} : { validate: hooks.validate }
  });
  hooks.setSource(() => scope.get());
  sctx.effect(() => () => {
    const state = ownerCtx.fiber?.state;
    if (state === 4 || state === 5) return;
    hooks.setSource(() => entry);
    hooks.onChange();
  });
  hooks.onChange();
  scope.watch(() => {
    const state = ownerCtx.fiber?.state;
    if (state === 4 || state === 5) return;
    hooks.onChange();
  });
}
var SETTINGS_SOURCE_WAIT_MS = 250;
// [macro-fusion 0.2.81] 设置链路诊断默认关。这段诊断（describe 快照 + write/edit 失败包一层）
// 是 0.2.18–0.2.20 排查「设置页写不进去」时加的，每调一次 describe 就往 storages 里追加几十行，
// 一天能长到 100 KB 以上，还挂原型方法。正式行为不该带这个：只有显式给
// DSH_MEMORY_SETTINGS_DIAG=1 时才写；日志有 256 KiB 上限，超了从尾巴重开。
var SETTINGS_DIAG_ON = process.env.DSH_MEMORY_SETTINGS_DIAG === "1";
var SETTINGS_DIAG_MAX_BYTES = 256 * 1024;
function settingsDiagPath() {
  return join9(activeHomeDir(), "settings-diag.log");
}
function settingsDiag(line) {
  if (!SETTINGS_DIAG_ON) return;
  try {
    const f = settingsDiagPath();
    mkdirSync6(dirname6(f), { recursive: true });
    const st = statSync3(f, { throwIfNoEntry: false });
    if (st !== void 0 && st.size > SETTINGS_DIAG_MAX_BYTES) writeFileSync5(f, "");
    appendFileSync2(f, `[${(/* @__PURE__ */ new Date()).toISOString()}] ${String(line)}
`);
  } catch {
  }
}
var LIVE_CONFIG_KEYS = ["hitTopK", "titleMax", "reflect", "reflectTurns", "autoMigrate", "promptLang", "disabledWorkspaces"];
var LIVE_DREAM_KEYS = ["enabled", "idleMinutes", "suppressWindows", "suppressLeadMinutes", "checkMinutes", "timeZone", "rulesReviewDays"];
function workspaceDisabledMatch(list, ws) {
  const n = normalizeWorkspacePath(ws);
  return list.some((p) => normalizeWorkspacePath(p) === n);
}
function liveConfigReader(patch, getSource, minIntervalMs) {
  let lastSource;
  let lastPatch;
  let lastAt = Number.NEGATIVE_INFINITY;
  let cached;
  return () => {
    const now = Date.now();
    if (cached !== void 0 && now - lastAt < minIntervalMs) return cached;
    let source;
    try {
      source = readConfigRoot(getSource());
    } catch {
      source = void 0;
    }
    const currentPatch = readConfigRoot(patch);
    if (cached === void 0 || source !== lastSource || currentPatch !== lastPatch) {
      lastSource = source;
      lastPatch = currentPatch;
      cached = resolveConfig(mergeConfigLayer(currentPatch, source));
    }
    lastAt = now;
    return cached;
  };
}
function applyLiveConfig(resolved, readLiveConfig) {
  const defineLive = (obj, key, live) => {
    const fallback = obj[key];
    Object.defineProperty(obj, key, {
      configurable: true,
      enumerable: true,
      get: () => {
        const cur = live();
        return cur === obj ? fallback : cur[key];
      }
    });
  };
  for (const key of LIVE_CONFIG_KEYS) defineLive(resolved, key, readLiveConfig);
  const dreamView = {};
  for (const key of LIVE_DREAM_KEYS) defineLive(dreamView, key, () => readLiveConfig().dream);
  Object.defineProperty(resolved, "dream", { configurable: true, enumerable: true, get: () => dreamView });
  return resolved;
}
function logHomeDirSwitch(ctx, sw) {
  if (sw.mode === "copy") {
    ctx.logger.warn(`meow-memory: \u5168\u5C40\u76EE\u5F55\u5DF2\u5207\u6362\u4E3A ${sw.to}\uFF08\u81EA ${sw.from} \u590D\u5236 ${sw.files} \u9879\uFF09\u3002\u65E7\u76EE\u5F55\u4FDD\u7559\u672A\u5220\uFF0C\u786E\u8BA4\u65E0\u8BEF\u540E\u53EF\u624B\u52A8\u5220\u9664\uFF1B\u82E5\u591A\u4E2A dsh \u5B9E\u4F8B\u5171\u4EAB\u65E7\u76EE\u5F55\uFF0C\u8BF7\u540C\u6B65\u4FEE\u6539\u5176\u4ED6\u5B9E\u4F8B\u7684\u8BBE\u7F6E`);
  } else if (sw.migrated) {
    ctx.logger.info(`meow-memory: \u5168\u5C40\u76EE\u5F55\u5DF2\u5207\u6362\u4E3A ${sw.to}\uFF08\u81EA ${sw.from} \u79FB\u52A8 ${sw.files} \u9879\uFF09`);
  } else if (sw.changed) {
    ctx.logger.info(`meow-memory: \u5168\u5C40\u76EE\u5F55\u5207\u6362\u4E3A ${sw.to}\uFF08\u76EE\u6807\u5DF2\u6709\u5185\u5BB9\uFF0C\u76F4\u63A5\u542F\u7528\u672A\u8986\u76D6\uFF09`);
  } else if (sw.mode === "failed") {
    ctx.logger.warn(`meow-memory: \u5168\u5C40\u76EE\u5F55\u5207\u6362\u5931\u8D25\uFF08${sw.error}\uFF09\uFF0C\u7EE7\u7EED\u4F7F\u7528 ${sw.from}`);
  }
}
function hotSwitchHomeDir(ctx, config2, get) {
  try {
    const merged = mergeConfigLayer(config2, get?.());
    const resolved = resolveConfig(merged);
    const target = resolveHomeDir(resolved.homeDir);
    if (target === activeHomeDir()) return;
    void Promise.resolve().then(() => {
      try {
        const sw = switchHomeDir(target);
        logHomeDirSwitch(ctx, sw);
        if (sw.changed) {
          loadWindowIndex(resolved.projectDir ?? ".dsh-meow");
          enableWorkspaceTrust();
          seedTrustedWorkspaces();
        }
      } catch {
      }
    });
  } catch {
  }
}
async function applyInner(ctx, config2) {
  const settingsBase = { ...mergeConfigLayer(CONFIG_DEFAULTS, config2), homeDirPresets: homeDirPresets() };
  let settingsGet;
  let markSourceReady;
  const sourceReady = new Promise((resolve2) => {
    markSourceReady = resolve2;
  });
  let sourceWaitArmed = false;
  let resolvedView;
  const refreshPromptLang = () => {
    if (resolvedView === void 0) return;
    setPromptLang(resolvedView.promptLang ?? "zh");
  };
  try {
    ctx.inject(["settings"], (settingsCtx) => {
      try {
        const svc2 = settingsCtx.settings;
        const proto = Object.getPrototypeOf(svc2);
        if (proto !== void 0 && typeof proto.write === "function" && proto.__writeProbe !== true) {
          proto.__writeProbe = true;
          const rawWrite = proto.write.bind(svc2);
          proto.write = (...args) => {
            const result = rawWrite(...args);
            if (result instanceof Promise) {
              return result.catch((e) => {
                try {
                  settingsDiag(`[${(/* @__PURE__ */ new Date()).toISOString()}] write(ns=${String(args[0])}) rejected: ${e instanceof Error ? `${e.message}
${e.stack ?? ""}` : String(e)}
`);
                } catch {
                }
                throw e;
              });
            }
            return result;
          };
        }
      } catch {
      }
      try {
        const ce = svc.ownerContext?.configEditor;
        if (ce && typeof ce.entries === "function") {
          const rows = ce.entries().map((entry) => {
            const o = entry;
            return {
              id: o.options?.id,
              state: o.fiber?.state,
              parent: o.parent?.tree?.ctx?.fiber?.entry?.id ?? null,
              hasRuntimeConfig: o.fiber?.runtime !== void 0 && "Config" in o.fiber.runtime,
              configRaw: o.options?.config ?? null
            };
          });
          settingsDiag(`[${(/* @__PURE__ */ new Date()).toISOString()}] configEditor entries: ${JSON.stringify(rows)}
`);
        }
        if (typeof ce.edit === "function" && ce.__editProbe !== true) {
          ;
          ce.__editProbe = true;
          const origEdit = ce.edit.bind(ce);
          ce.edit = async function(entry, change) {
            const result = await origEdit(entry, change).catch((e) => {
              try {
                settingsDiag(`[${(/* @__PURE__ */ new Date()).toISOString()}] edit THREW ns=${String(entry?.options?.id)}: ${e instanceof Error ? `${e.message}
${String(e.stack).split("\n").slice(1, 4).join("\n")}` : String(e)}
`);
              } catch {
              }
              throw e;
            });
            try {
              settingsDiag(`[${(/* @__PURE__ */ new Date()).toISOString()}] edit OK ns=${String(entry?.options?.id)}
`);
            } catch {
            }
            return result;
          };
        }
      } catch {
      }
      try {
        const svcAny = settingsCtx.settings;
        if (typeof svcAny.describe === "function") {
          const dumpDescribe = () => {
            if (!SETTINGS_DIAG_ON) return;
            try {
              const view = svcAny.describe();
              const info = {
                isArray: Array.isArray(view),
                keys: view && typeof view === "object" && !Array.isArray(view) ? Object.keys(view) : null,
                length: Array.isArray(view) ? view.length : null,
                nsList: Array.isArray(view) ? view.map((row) => row?.ns) : null
              };
              settingsDiag(`describe shape: ${JSON.stringify(info)}`);
              const meowRow = Array.isArray(view) ? view.find((row) => row?.ns === "meow-memory") : void 0;
              if (meowRow !== void 0) {
                settingsDiag(`meow view: ${JSON.stringify({
                  revision: meowRow.revision,
                  value: meowRow.value,
                  base: meowRow.base,
                  user: meowRow.user
                })}`);
                const schemaObj = meowRow.schema;
                const schemaKeys = schemaObj && typeof schemaObj === "object" ? Object.keys(schemaObj) : null;
                settingsDiag(`meow schema: ${JSON.stringify({
                  schemaKeys,
                  homeDirDeclared: schemaKeys !== null && schemaKeys.includes("homeDir"),
                  schemaFull: JSON.stringify(schemaObj).slice(0, 3e3)
                })}`);
              }
            } catch (e) {
              settingsDiag(`describe dump err: ${String(e)}`);
            }
          };
          dumpDescribe();
          setTimeout(dumpDescribe, 5e3);
        }
      } catch {
      }
      if (typeof settingsCtx.settings.installSection !== "function") {
        try {
          const svcAny = settingsCtx.settings;
          const proto = Object.getPrototypeOf(svcAny);
          if (proto !== null && typeof proto.describe === "function" && proto.__meowValueRefresh !== true) {
            proto.__meowValueRefresh = true;
            const rawDescribe = proto.describe.bind(svcAny);
            proto.describe = (...args) => {
              const rows = rawDescribe(...args);
              try {
                if (Array.isArray(rows)) {
                  const row = rows.find((r) => r?.ns === SETTINGS_NS);
                  if (row !== void 0 && row.base !== void 0 && row.base !== null && typeof row.base === "object") {
                    const cleanBase = { ...row.base };
                    delete cleanBase.homeDirPresets;
                    row.base = { ...cleanBase, homeDirPresets: homeDirPresets() };
                    row.value = mergeConfigLayer(cleanBase, row.user);
                  }
                }
              } catch {
              }
              return rows;
            };
            settingsGet = () => {
              const rows = svcAny.describe();
              const row = Array.isArray(rows) ? rows.find((r) => r?.ns === SETTINGS_NS) : void 0;
              return row?.value;
            };
            markSourceReady?.();
          }
          if (proto !== null && typeof proto.write === "function" && proto.__meowWriteHook !== true) {
            proto.__meowWriteHook = true;
            const rawWriteHooked = proto.write.bind(svcAny);
            proto.write = (...args) => {
              const result = rawWriteHooked(...args);
              if (result instanceof Promise) {
                return result.then((v) => {
                  if (String(args[0]) === SETTINGS_NS) {
                    ctx.logger.info("meow-memory: \u914D\u7F6E\u5DF2\u901A\u8FC7\u8BBE\u7F6E\u9875\u66F4\u65B0\uFF08\u91CD\u8F7D/\u91CD\u542F\u63D2\u4EF6\u540E\u751F\u6548\uFF09");
                    hotSwitchHomeDir(ctx, config2, settingsGet);
                    refreshPromptLang();
                  }
                  return v;
                });
              }
              return result;
            };
          }
        } catch {
        }
      }
      installSettingsSectionCompat(settingsCtx, ctx, SETTINGS_NS, z.dict(z.any()), settingsBase, {
        validate: (value) => {
          validateConfigUserLayer(value);
        },
        setSource: (get) => {
          settingsGet = get;
          markSourceReady?.();
        },
        onChange: () => {
          ctx.logger.info("meow-memory: \u914D\u7F6E\u5DF2\u901A\u8FC7\u8BBE\u7F6E\u9875\u66F4\u65B0\uFF08\u91CD\u8F7D/\u91CD\u542F\u63D2\u4EF6\u540E\u751F\u6548\uFF09");
          hotSwitchHomeDir(ctx, config2, settingsGet);
          refreshPromptLang();
        }
      });
    });
    sourceWaitArmed = true;
  } catch (e) {
    const msg = `meow-memory: \u8BBE\u7F6E\u547D\u540D\u7A7A\u95F4\u6CE8\u518C\u5931\u8D25\uFF08\u6807\u7B7E\u9875\u4E0D\u53EF\u7528\uFF0C\u914D\u7F6E\u8D70 patch \u5C42\uFF09\uFF1A${e instanceof Error ? e.stack ?? e.message : String(e)}`;
    ctx.logger.warn(msg);
    try {
      const regErrFile = join9(activeHomeDir(), "settings-register-error.log");
      mkdirSync6(dirname6(regErrFile), { recursive: true });
      appendFileSync2(regErrFile, `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`);
    } catch {
    }
  }
  try {
    ctx.inject(["configEditor"], (ce) => {
      try {
        const rows = ce.entries().map((entry) => ({
          id: entry.options?.id,
          state: entry.fiber?.state,
          parent: entry.parent?.tree?.ctx?.fiber?.entry?.id ?? null,
          hasConfig: entry.fiber?.runtime !== void 0 && "Config" in entry.fiber.runtime
        }));
        settingsDiag(`[${(/* @__PURE__ */ new Date()).toISOString()}] configEditor entries: ${JSON.stringify(rows)}
`);
      } catch {
      }
    });
  } catch {
  }
  try {
    const settingsSvc = ctx.get?.("settings");
    const proto = settingsSvc !== void 0 ? Object.getPrototypeOf(settingsSvc) : void 0;
    if (proto !== void 0 && typeof proto.write === "function" && proto.__writeProbe !== true) {
      proto.__writeProbe = true;
      const rawWrite = proto.write.bind(settingsSvc);
      proto.write = (...args) => {
        const result = rawWrite(...args);
        if (result instanceof Promise) {
          return result.catch((e) => {
            try {
              settingsDiag(`[${(/* @__PURE__ */ new Date()).toISOString()}] write(ns=${String(args[0])}) rejected: ${e instanceof Error ? `${e.message}
${e.stack ?? ""}` : String(e)}
`);
            } catch {
            }
            throw e;
          });
        }
        return result;
      };
    }
  } catch {
  }
  if (sourceWaitArmed) {
    await Promise.race([
      sourceReady,
      new Promise((resolve2) => {
        setTimeout(resolve2, SETTINGS_SOURCE_WAIT_MS);
      })
    ]);
  }
  const merged = mergeConfigLayer(config2, settingsGet?.());
  const readLiveConfig = liveConfigReader(config2, () => settingsGet?.(), SETTINGS_SOURCE_WAIT_MS);
  const resolved = applyLiveConfig(resolveConfig(merged), readLiveConfig);
  resolvedView = resolved;
  if (sourceWaitArmed && settingsGet === void 0) {
    ctx.logger.warn("meow-memory: settings \u670D\u52A1\u5728\u6709\u754C\u7B49\u5F85\u5185\u672A\u5C31\u7EEA\u2014\u2014\u6CE8\u518C\u671F\u5B57\u6BB5\u672C\u6B21\u542F\u52A8\u6309 patch \u5C42\u9ED8\u8BA4\u503C\u751F\u6548\uFF08\u9700\u91CD\u8F7D\u7EA0\u6B63\uFF09\uFF1B\u70ED\u5B57\u6BB5\uFF08\u6CE8\u5165/\u53CD\u601D/dream\uFF09\u4F1A\u5728\u547D\u540D\u7A7A\u95F4\u5C31\u7EEA\u540E\u81EA\u52A8\u7EA0\u6B63\uFF08issue #26\uFF09");
  }
  const workspaceDisabled = (ws) => workspaceDisabledMatch(readLiveConfig().disabledWorkspaces, ws);
  const memoryReadOff = (ws, sid) => {
    if (workspaceDisabled(ws)) return true;
    if (!existsSync9(memoryDbPath(ws, resolved.projectDir))) return false;
    try {
      return getDb(ws, resolved.projectDir).getMemoryScope(sid).inject;
    } catch {
      return false;
    }
  };
  logHomeDirSwitch(ctx, switchHomeDir(resolveHomeDir(resolved.homeDir)));
  ctx.logger.info(`meow-memory: config resolved (sourceReady=${settingsGet !== void 0}, enabled=${resolved.enabled}, dream.enabled=${resolved.dream?.enabled ?? "default"}, promptLang=${resolved.promptLang ?? "zh"}, projectDir=${resolved.projectDir ?? ".dsh-meow"})`);
  if (!resolved.enabled) {
    ctx.logger.info("meow-memory: disabled by config");
    return;
  }
  setPromptLang(resolved.promptLang ?? "zh");
  applyCount++;
  perf(`apply #${applyCount} pid=${process.pid}`);
  const sweptHome = sweepHomeLogs();
  if (sweptHome.swept.length > 0 || sweptHome.rotated) {
    perf(`home-log sweep: ${sweptHome.swept.join(",") || "-"}${sweptHome.rotated ? " +perf.log->old" : ""}`);
  }
  loadWindowIndex(resolved.projectDir);
  enableWorkspaceTrust();
  const seededTrust = seedTrustedWorkspaces();
  if (seededTrust.listed > 0) {
    ctx.logger.info(`meow-memory: workspace trust gate on (seeded ${seededTrust.trusted}/${seededTrust.listed} from window-index)`);
  }
  void ensureV0SessionsMigrated(resolved.projectDir, (m) => ctx.logger.info(m)).catch((e) => {
    ctx.logger.warn(`meow-memory: migrate-v0 failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  });
  perf(`window-index restored ${windowIndex.size} windows`);
  const toolDisposers = [];
  setMemoryToolGate({
    refuseRead: (ws, sid) => {
      if (workspaceDisabled(ws)) return "\u8BB0\u5FC6\u5BF9\u8BE5\u5DE5\u4F5C\u533A\u5DF2\u505C\u7528\uFF08disabledWorkspaces \u540D\u5355\uFF09\uFF1Amemory \u5DE5\u5177\u4E0D\u53EF\u7528\uFF0C\u8BF7\u66F4\u6362\u5DE5\u4F5C\u533A\u6216\u8C03\u6574\u914D\u7F6E\u3002";
      if (isUntrustedMemoryWorkspace(ws)) return "\u6B64\u5DE5\u4F5C\u533A\u81EA\u5E26\u672A\u4FE1\u4EFB\u7684\u5916\u90E8\u8BB0\u5FC6\u5E93\uFF08.dsh-meow \u975E\u672C\u673A\u521B\u5EFA\uFF0C#64\uFF09\uFF1Amemory \u5DE5\u5177\u5DF2\u6682\u505C\u3002\u786E\u8BA4\u8FD9\u662F\u81EA\u5DF1\u7684\u9879\u76EE\uFF0C\u8BF7\u8BA9\u7528\u6237\u6267\u884C /meow-trust \u6062\u590D\u3002";
      if (sid === null || !existsSync9(memoryDbPath(ws, resolved.projectDir))) return null;
      return getDb(ws, resolved.projectDir).getMemoryScope(sid).inject ? "\u6B64\u7A97\u53E3\u5DF2\u505C\u6B62\u8BFB\u5165\u8BB0\u5FC6\uFF08\u8BB0\u5FC6\u53C2\u4E0E\u5F00\u5173\uFF09\uFF1A\u6CE8\u5165\u4E0E\u68C0\u7D22\u5747\u5DF2\u5173\u95ED\u3002" : null;
    },
    refuseWrite: (ws, sid) => {
      if (workspaceDisabled(ws)) return "\u8BB0\u5FC6\u5BF9\u8BE5\u5DE5\u4F5C\u533A\u5DF2\u505C\u7528\uFF08disabledWorkspaces \u540D\u5355\uFF09\uFF1A\u5199\u5165\u88AB\u62D2\u7EDD\u3002";
      if (isUntrustedMemoryWorkspace(ws)) return "\u6B64\u5DE5\u4F5C\u533A\u81EA\u5E26\u672A\u4FE1\u4EFB\u7684\u5916\u90E8\u8BB0\u5FC6\u5E93\uFF08.dsh-meow \u975E\u672C\u673A\u521B\u5EFA\uFF0C#64\uFF09\uFF1A\u5199\u5165\u88AB\u62D2\u7EDD\u3002\u786E\u8BA4\u8FD9\u662F\u81EA\u5DF1\u7684\u9879\u76EE\uFF0C\u8BF7\u8BA9\u7528\u6237\u6267\u884C /meow-trust \u6062\u590D\u3002";
      if (sid === null || !existsSync9(memoryDbPath(ws, resolved.projectDir))) return null;
      if (isPluginTurn.get(sid) === true) return null;
      return getDb(ws, resolved.projectDir).getMemoryScope(sid).write ? "\u6B64\u7A97\u53E3\u5DF2\u505C\u6B62\u5199\u5165\u8BB0\u5FC6\uFF08\u8BB0\u5FC6\u53C2\u4E0E\u5F00\u5173\uFF09\u3002" : null;
    }
  });
  registerMemoryTools((t) => {
    const dispose = ctx.tools.register(t);
    if (typeof dispose === "function") toolDisposers.push(dispose);
  }, resolved.projectDir);
  const broadcast = new DreamStateBroadcast(ctx.logger);
  const signalDreamState = (sessionId, state, detail) => {
    broadcast.broadcast(sessionId, state, detail);
    if (state === "dreamed" && resolved.backup.enabled) {
      const wsB = windowIndex.get(sessionId);
      if (wsB !== void 0) {
        try {
          if (backupMemoryDb(wsB, resolved.projectDir)) ctx.logger.info(`meow-memory: memory.db \u5DF2\u5907\u4EFD\uFF08dream \u6536\u5C3E\u89E6\u53D1\uFF0C${shortSessionId(sessionId)}\uFF09`);
        } catch {
        }
      }
    }
  };
  const disposeDreamTool = ctx.tools.register(dreamTool(ctx, resolved.projectDir, signalDreamState, () => resolved.dream.rulesReviewDays, workspaceDisabled, isUntrustedMemoryWorkspace));
  if (typeof disposeDreamTool === "function") toolDisposers.push(disposeDreamTool);
  ctx.logger.info("meow-memory: memory_remember/search/read/update + memory_dream registered");
  let guideRegistered = false;
  let guideTimer = 0;
  const tryRegisterGuideSection = (attempt) => {
    if (guideRegistered) return;
    const svc2 = ctx.get?.("systemPrompt");
    if (svc2 === void 0 || typeof svc2.section !== "function") {
      if (attempt < 20) {
        guideTimer = setTimeout(() => tryRegisterGuideSection(attempt + 1), 1e3);
      } else {
        ctx.logger.warn("meow-memory: systemPrompt \u670D\u52A1 20s \u5185\u672A\u5C31\u7EEA\uFF0C\u8BB0\u5FC6\u624B\u518C\u672A\u6302\u8FDB system prompt\uFF08memory_* \u5DE5\u5177\u4E0D\u53D7\u5F71\u54CD\uFF09");
      }
      return;
    }
    try {
      const dispose = svc2.section({ name: "meow-memory:guide", order: 130, text: getMemoryGuide() });
      guideRegistered = true;
      if (typeof dispose === "function") toolDisposers.push(dispose);
      ctx.logger.info("meow-memory: guide section registered into system prompt");
    } catch (e) {
      ctx.logger.warn(`meow-memory: guide section \u6CE8\u518C\u5931\u8D25\uFF08\u8BB0\u5FC6\u624B\u518C\u7F3A\u5931\uFF0C\u4E0D\u5F71\u54CD\u5176\u4F59\u529F\u80FD\uFF09: ${e instanceof Error ? e.message : String(e)}`);
      guideRegistered = true;
    }
  };
  tryRegisterGuideSection(0);
  toolDisposers.push(() => clearTimeout(guideTimer));
  const lastWindowWrite = /* @__PURE__ */ new Map();
  const isPluginTurn = /* @__PURE__ */ new Map();
  const turnHadMessage = /* @__PURE__ */ new Map();
  ctx.on("session/event", (session, event) => {
    perfEvent();
    noteActivity();
    const t = event?.type;
    const sid = session?.id;
    const cwd = session?.header?.cwd;
    if (t === "compaction/summary" || t === "compaction/start") {
      if (typeof sid === "string" && typeof cwd === "string") {
        releaseSeen(cwd, sid, resolved.projectDir);
        ctx.logger.info(`meow-memory: compaction signal, released seen memory for session ${shortSessionId(sid)}`);
      }
      return;
    }
    if (t === "compaction/end") {
      const err = event.data?.error;
      if ((err === void 0 || err === null || err === "") && typeof sid === "string" && typeof cwd === "string") {
        markReinjectPending(cwd, sid, resolved.projectDir);
        ctx.logger.info(`meow-memory: compaction finished, memory re-injection armed for session ${shortSessionId(sid)}`);
      }
      return;
    }
    if (typeof sid === "string") {
      if (t === "turn/start") {
        isPluginTurn.set(sid, false);
        turnHadMessage.set(sid, false);
        return;
      }
      if (t === "user/message") {
        turnHadMessage.set(sid, true);
        const data = event.data;
        const src = data?.source;
        if (src?.kind !== "user") {
          const msgText = (data?.content ?? []).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text ?? "").join(" ");
          if (msgText.includes(REFLECT_MARKER) || msgText.includes(DREAM_MARKER) || msgText.includes(REFLECT_DELEGATE_MARKER) || msgText.includes(DREAM_DELEGATE_MARKER) || msgText.includes(REFLECT_DONE_DELEGATE_MARKER)) {
            isPluginTurn.set(sid, true);
            return;
          }
        }
      }
      if (t === "turn/end" && event.data?.reason?.kind === "error") {
        const pluginTurn = isPluginTurn.get(sid) === true;
        const nakedTurn = turnHadMessage.get(sid) === false;
        if ((pluginTurn || nakedTurn) && typeof cwd === "string" && existsSync9(memoryDbPath(cwd, resolved.projectDir))) {
          const errCode = String(event.data?.reason?.error?.code ?? "");
          const errMsg = String(event.data?.reason?.error?.message ?? "");
          const contextWindowExceeded = errCode === "CONTEXT_WINDOW_EXCEEDED" || /contextwindow|context window/i.test(errMsg);
          if (errCode === "TRANSPORT" || contextWindowExceeded || /transport|network|connection|ECONN/i.test(errMsg)) {
            try {
              getDb(cwd, resolved.projectDir).releaseDream(sid);
              appendFileSync2(join9(cwd, resolved.projectDir, "dream-debug.log"), `[${(/* @__PURE__ */ new Date()).toISOString()}] dream ${contextWindowExceeded ? "context-window-fail" : "transport-fail"} sid=${shortSessionId(sid)} -> released (not counted, #106/#110)
`);
            } catch {
            }
            broadcast.broadcast(sid, "active");
          } else {
            const outcome = handleMemoryTurnFailure(getDb(cwd, resolved.projectDir), sid, cwd, resolved.projectDir);
            if (outcome !== "none") broadcast.broadcast(sid, "active");
          }
        }
      }
      if (isPluginTurn.get(sid)) return;
    }
    if (t !== "user/message" && t !== "turn/end" && t !== "assistant/message" && t !== "tool/result") return;
    if (session?.header?.origin === "subagent") return;
    if (typeof sid !== "string" || typeof cwd !== "string" || typeof event?.time !== "number") return;
    const now = Date.now();
    const last = lastWindowWrite.get(sid) ?? 0;
    if (now - last < 5e3) return;
    lastWindowWrite.set(sid, now);
    const db = getDb(cwd, resolved.projectDir);
    db.touchWindow(sid, cwd, event.time);
    const win = db.getWindow(sid);
    if (win !== void 0 && win.last_dream_time !== null) broadcast.broadcast(sid, "active");
    windowIndex.set(sid, cwd);
    persistWindowIndex();
  });
  const firstUserHandled = /* @__PURE__ */ new Set();
  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    const decision = await next();
    try {
      return await preStepInject({ agent, signal }, decision);
    } catch (e) {
      try {
        ctx.logger.warn(`meow-memory: pre-step \u6CE8\u5165\u5931\u8D25\uFF08fail-open \u653E\u884C\u539F\u59CB\u6D88\u606F\uFF09: ${e instanceof Error ? e.message : String(e)}`);
      } catch {
      }
      return decision;
    }
  });
  const preStepInject = async ({ agent, signal }, decision) => {
    const t0 = Date.now();
    if (decision === void 0 || decision.kind !== "enter" || signal.aborted) return decision;
    if (decision.messages.length === 0) return decision;
    if (agent.session.header.origin === "subagent") return decision;
    registerLiveAgent(agent);
    const sid = sessionIdOfAgent(agent);
    const ws = workspaceOfAgent(agent);
    const userMsgs = decision.messages.filter((m) => m.source?.kind === "user");
    if (userMsgs.length === 0) return decision;
    if (ws !== null && isUntrustedMemoryWorkspace(ws)) {
      if (!hasExternalNoticeShown(ws)) {
        markExternalNoticeShown(ws);
        try {
          const notice = resolveSlotText("external-memory-notice");
          const rewritten = [...decision.messages];
          rewritten.splice(rewritten.indexOf(userMsgs[0]), 0, createMemoryNoticeMessage(notice));
          ctx.logger.info("meow-memory: external memory library detected \u2014 paused until /meow-trust");
          return { ...decision, messages: rewritten };
        } catch {
        }
      }
      return decision;
    }
    if (ws !== null && memoryReadOff(ws, sid)) return decision;
    if (ws && isReinjectPending(ws, sid, resolved.projectDir)) {
      const lastUser = userMsgs[userMsgs.length - 1];
      const db = getDb(ws, resolved.projectDir);
      const reinj = buildReinjection(db, ws, sid, readProjectQueried(ws, sid, resolved.projectDir), {
        hitTopK: resolved.hitTopK,
        titleMax: resolved.titleMax
      }, resolved.projectDir);
      clearReinjectPending(ws, sid, resolved.projectDir);
      if (reinj !== null) {
        const rewritten = [...decision.messages];
        rewritten.splice(rewritten.indexOf(lastUser), 0, createMemorySnapshotMessage(reinj.text, { kind: "reinjection", ids: reinj.injectedIds }));
        ctx.logger.info(`meow-memory: post-compaction memory re-injected (${reinj.text.length} chars)`);
        return { ...decision, messages: rewritten };
      }
      return decision;
    }
    if (!firstUserHandled.has(sid)) {
      firstUserHandled.add(sid);
      let priorUser = 0;
      for (const e of sessionEventsOf(agent.session)) {
        const evt = e;
        if (evt?.type === "user/message" && evt.data?.source?.kind === "user") priorUser++;
      }
      if (ws) {
        try {
          appendFileSync2(join9(ws, resolved.projectDir, "dream-debug.log"), `[${(/* @__PURE__ */ new Date()).toISOString()}] pre-step first pid=${process.pid} sid=${shortSessionId(sid)} priorUser=${priorUser} userMsgs=${userMsgs.length}
`);
        } catch {
        }
      }
      if (priorUser === 0) {
        if (ws) {
          const firstUser = userMsgs[0];
          const db = getDb(ws, resolved.projectDir);
          if (resolved.autoMigrate && existsSync9(join9(ws, resolved.projectDir, "PROJECT.md"))) {
            const n = migrateLegacy(db, ws, resolved.projectDir);
            if (n !== null) ctx.logger.info(`meow-memory: migrated legacy PROJECT.md \u2192 SQLite (${n} entries)`);
          }
          const firstText = firstUser.content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text ?? "").join(" ");
          const injected = buildInjection(db, ws, sid, firstText, {
            hitTopK: resolved.hitTopK,
            titleMax: resolved.titleMax
          }, resolved.projectDir);
          if (injected) {
            const rewritten = [...decision.messages];
            rewritten.splice(rewritten.indexOf(firstUser), 0, createMemorySnapshotMessage(injected.text, { kind: "initial", ids: injected.injectedIds }));
            ctx.logger.info(`meow-memory: inserted memory snapshot (${injected.text.length} chars) before first user message`);
            return { ...decision, messages: rewritten };
          }
        }
        try {
          if (getDb(ws, resolved.projectDir).isFresh() && !readSeen(ws, sid, resolved.projectDir).has(FIRST_CREATE_NOTICE_SEEN_ID)) {
            const firstUser2 = userMsgs[0];
            markAccessed(ws, sid, [FIRST_CREATE_NOTICE_SEEN_ID], resolved.projectDir);
            const notice = resolveSlotText("first-create-notice", { dbPath: join9(ws, resolved.projectDir, "memory.db"), homePath: homedir4() });
            const rewritten = [...decision.messages];
            rewritten.splice(rewritten.indexOf(firstUser2), 0, createMemoryNoticeMessage(notice));
            ctx.logger.info("meow-memory: first-create notice injected (fresh memory.db)");
            return { ...decision, messages: rewritten };
          }
        } catch {
        }
        return decision;
      }
    }
    if (resolved.promptLang === void 0 && ws) {
      const seen = readSeen(ws, sid, resolved.projectDir);
      if (!seen.has(WELCOME_GUIDE_SEEN_ID)) {
        const lastUser = [...decision.messages].reverse().find((m) => m.source?.kind === "user");
        if (lastUser !== void 0) {
          markAccessed(ws, sid, [WELCOME_GUIDE_SEEN_ID], resolved.projectDir);
          const guide = resolveSlotText("welcome-guide", { homePath: homedir4() });
          const rewritten = [...decision.messages];
          rewritten.splice(rewritten.indexOf(lastUser), 0, createMemoryNoticeMessage(guide));
          ctx.logger.info("meow-memory: first-run lang guide injected as independent notice (promptLang unset)");
          return { ...decision, messages: rewritten };
        }
      }
    }
    if (ws) {
      const lastUser = [...decision.messages].reverse().find((m) => m.source?.kind === "user");
      if (lastUser !== void 0) {
        const text = lastUser.content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text ?? "").join(" ");
        const db = getDb(ws, resolved.projectDir);
        const hit = buildHitInjection(db, ws, sid, text, {
          hitTopK: resolved.hitTopK,
          titleMax: resolved.titleMax
        }, resolved.projectDir);
        try {
          appendFileSync2(join9(ws, resolved.projectDir, "dream-debug.log"), `[${(/* @__PURE__ */ new Date()).toISOString()}] hit-chain pid=${process.pid} sid=${shortSessionId(sid)} textLen=${text.length} hit=${hit === null ? "null" : "yes"}
`);
        } catch {
        }
        if (hit !== null) {
          const rewritten = [...decision.messages];
          rewritten.splice(rewritten.indexOf(lastUser), 0, createMemorySnapshotMessage(hit.text, { kind: "hit", ids: hit.injectedIds }));
          return { ...decision, messages: rewritten };
        }
      }
      if (Date.now() - t0 > 10) perf(`pre-step hit ${Date.now() - t0}ms sid=${shortSessionId(sid)}`);
    }
    return decision;
  };
  const reflectQueuedTurn = /* @__PURE__ */ new Map();
  const MAX_REFLECT_TRACKED = 512;
  ctx.on("agent/turn-stopping", ({ agent, turn }) => {
    try {
      turnStoppingCore(agent, turn);
    } catch (e) {
      try {
        ctx.logger.warn(`meow-memory: turn-stopping \u5904\u7406\u5931\u8D25\uFF08\u5DF2\u5FFD\u7565\uFF09: ${e instanceof Error ? e.message : String(e)}`);
      } catch {
      }
    }
  });
  const turnStoppingCore = (agent, turn) => {
    const t0 = Date.now();
    if (agent.session.header.origin === "subagent") return;
    registerLiveAgent(agent);
    const sidTs = sessionIdOfAgent(agent);
    if (delegateRestore.has(sidTs) && typeof agent.model?.select === "function") {
      try {
        const remembered = delegateRestore.get(sidTs);
        const cur = mainRouteOf(agent.model.current() ?? {});
        if (cur.provider === remembered.route.provider && cur.model === remembered.route.model) {
          ;
          agent.model.select({
            provider: remembered.main.provider,
            model: remembered.main.model,
            ...remembered.main.reasoningEffort === void 0 ? {} : { reasoningEffort: remembered.main.reasoningEffort }
          });
          delegateRestore.delete(sidTs);
          ctx.logger.info(`meow-memory: restore main model ${remembered.main.provider}/${remembered.main.model} at memory turn end (#110)`);
        }
      } catch {
      }
    }
    const endReason = lastTurnEndReason(sessionEventsOf(agent.session));
    const dreamTurn = wasDreamTurn(sessionEventsOf(agent.session));
    const wsTs = workspaceOfAgent(agent);
    if (wsTs) {
      try {
        appendFileSync2(join9(wsTs, resolved.projectDir, "dream-debug.log"), `[${(/* @__PURE__ */ new Date()).toISOString()}] turn-stopping pid=${process.pid} sid=${shortSessionId(sidTs)} reason=${endReason ?? "none"} wasDream=${dreamTurn}
`);
      } catch {
      }
    }
    if (endReason === "aborted" || endReason === "interrupted") {
      if (dreamTurn) abortDream(agent, resolved.projectDir, signalDreamState);
      return;
    }
    if (dreamTurn) {
      if (endReason === "error") {
        try {
          if (wsTs && sidTs) getDb(wsTs, resolved.projectDir).releaseDream(sidTs);
        } catch {
        }
        return;
      }
      advanceDream(agent, resolved.projectDir, signalDreamState, resolved.dream.rulesReviewDays);
      return;
    }
    if (wsTs !== null) {
      try {
        if (isUntrustedMemoryWorkspace(wsTs) || workspaceDisabled(wsTs) || existsSync9(memoryDbPath(wsTs, resolved.projectDir)) && getDb(wsTs, resolved.projectDir).getMemoryScope(sidTs).dream) return;
      } catch {
      }
    }
    if (!resolved.reflect) return;
    const ws = workspaceOfAgent(agent);
    if (!ws) return;
    const turnInfo = scanTurn(sessionEventsOf(agent.session));
    const { sawToolCall, sawNonMemory, lastToolName, sawReflect, turnText, userText } = turnInfo;
    if (sawReflect) {
      reflectQueuedTurn.delete(sidTs);
      return;
    }
    if (turn !== void 0 && reflectQueuedTurn.get(sidTs) === turn) return;
    const CUE = reflectCueHit(userText);
    // [macro-fusion 0.2.134] 事故比「干了几步」优先：记忆工具自己挂了、或这一轮以错误收场时，
    // 哪怕整轮只碰过 memory_*，也要当场反思——那正是最该被记住的一次。
    const INC = incidentOf({ ...turnInfo, cue: CUE }, endReason);
    if (!sawToolCall && INC.level === 0) return;
    // [macro-fusion 0.2.133] 老写法是「最后一步是 memory_* 就整轮免反思」——而一轮活干完，
    // 收尾那步几乎总是 memory_remember / memory_update。等于「刚把记忆写进去的那一轮，
    // 恰好不反思」，主人在 2026-11-21 明确点出了这个洞。改成只看整轮有没有非记忆的活。
    if (!sawNonMemory && INC.level === 0) return;
    const NEED = reflectNeed(INC, resolved.reflectTurns);
    if (consecutiveToolSteps(sessionEventsOf(agent.session)) < NEED) return;
    const SETTLED = settleReflect(ws, resolved.projectDir, turnInfo.memoryWrites);
    if (SETTLED && SETTLED.ok === false) {
      try {
        appendFileSync2(join9(ws, resolved.projectDir, "dream-debug.log"), `[${(/* @__PURE__ */ new Date()).toISOString()}] reflect no-followup kinds="${(SETTLED.kinds ?? []).join(",")}"
`);
      } catch {
      }
    }
    const REP = incidentRepeatOf(ws, resolved.projectDir, INC);
    const message = buildReflectMessage(ws, turnText, resolved.projectDir, INC, REP);
    if (INC.level >= 2) {
      recordIncident(ws, resolved.projectDir, INC, sidTs);
      writeReflectPending(ws, resolved.projectDir, INC);
    }
    if (sendMemoryTurn(agent, message, ws, resolved.projectDir, `reflect sid=${shortSessionId(sidTs)}`)) {
      if (turn !== void 0) {
        reflectQueuedTurn.set(sidTs, turn);
        while (reflectQueuedTurn.size > MAX_REFLECT_TRACKED) {
          const oldest = reflectQueuedTurn.keys().next().value;
          if (oldest === void 0) break;
          reflectQueuedTurn.delete(oldest);
        }
      }
      if (INC.level >= 2) {
        try {
          appendFileSync2(join9(ws, resolved.projectDir, "dream-debug.log"), `[${(/* @__PURE__ */ new Date()).toISOString()}] reflect incident="${INC.kinds.join(",")}" errors=${INC.toolErrors} memoryErrors=${INC.memoryErrors} worst=${INC.worstTool ?? "-"}\u00d7${INC.worstFail} sid=${shortSessionId(sidTs)}
`);
        } catch {
        }
      }
      ctx.logger.info(`meow-memory: reflect sent as standalone turn (cue=${CUE}, need=${NEED}, incident=${INC.kinds.join(",") || "none"}, lastTool=${lastToolName ?? "none"})`);
    } else {
      ctx.logger.warn("meow-memory: reflect \u53D1\u9001\u5931\u8D25\uFF08\u672C\u8F6E\u4E0D\u53CD\u601D\uFF0C\u4E0B\u8F6E\u91CD\u8BD5\uFF09");
    }
    if (Date.now() - t0 > 20) perf(`turn-stopping slow ${Date.now() - t0}ms`);
  };
  const delegateRestore = /* @__PURE__ */ new Map();
  const MAX_DELEGATE_TRACKED = 512;
  const rememberOverride = (sid, main, route) => {
    if (sid === "unknown") {
      ctx.logger.info("meow-memory: delegate override skipped (session id unknown) \u2014 restore pairing not recorded (#114)");
      return;
    }
    const prev = delegateRestore.get(sid);
    if (prev === void 0) {
      delegateRestore.set(sid, { main, route });
    } else {
      const complete = (r) => r.provider !== void 0 && r.model !== void 0;
      delegateRestore.set(sid, { main: complete(prev.main) ? prev.main : complete(main) ? main : prev.main, route: prev.route });
    }
    while (delegateRestore.size > MAX_DELEGATE_TRACKED) {
      const oldest = delegateRestore.keys().next().value;
      if (oldest === void 0) break;
      delegateRestore.delete(oldest);
    }
  };
  if (resolved.delegate.modelSpec !== void 0) {
    const spec = resolved.delegate.modelSpec;
    const delegateEffort = resolved.delegate.effort;
    setMemoryTurnEnqueuedHook((agent) => {
      if (typeof agent.model?.select !== "function") return;
      const sid = sessionIdOfAgent(agent);
      const cur = mainRouteOf(agent.model.current() ?? {});
      const route = { provider: spec.provider ?? cur.provider, model: spec.model ?? cur.model };
      rememberOverride(sid, cur, route);
      agent.model.select(
        delegateEffort === "inherit" && cur.reasoningEffort !== void 0 ? { provider: route.provider, model: route.model, reasoningEffort: String(cur.reasoningEffort) } : delegateEffort !== void 0 && delegateEffort !== "inherit" ? { provider: route.provider, model: route.model, reasoningEffort: delegateEffort } : { provider: route.provider, model: route.model }
      );
      ctx.logger.info(`meow-memory: memory task turn \u2192 model override at turn entry ${route.provider}/${route.model}`);
    });
    ctx.on("agent/pre-step", async (payload, next) => {
      const agent = payload?.agent;
      if (agent === void 0 || typeof agent.model?.select !== "function") return next();
      if (agent.session?.header?.origin === "subagent") return next();
      const sel = payload.modelSelection;
      const sid = sessionIdOfAgent(agent);
      const events = sessionEventsOf(agent.session);
      if (isMemoryTaskTurn(events)) {
        const route = { provider: spec.provider ?? sel?.provider, model: spec.model ?? sel?.model };
        rememberOverride(sid, mainRouteOf(sel ?? {}), route);
        ctx.logger.info(`meow-memory: memory task turn \u2192 model override ${route.provider}/${route.model}${delegateEffort === void 0 ? " (effort stripped)" : ` (effort ${delegateEffort})`}`);
        agent.model.select(
          delegateEffort === "inherit" && sel?.reasoningEffort !== void 0 ? { provider: route.provider, model: route.model, reasoningEffort: String(sel.reasoningEffort) } : delegateEffort !== void 0 && delegateEffort !== "inherit" ? { provider: route.provider, model: route.model, reasoningEffort: delegateEffort } : { provider: route.provider, model: route.model }
        );
        return next();
      }
      const remembered = delegateRestore.get(sid);
      if (remembered === void 0) return next();
      delegateRestore.delete(sid);
      if (userSelectedAfterOverride(events, remembered.route)) return next();
      if (sel?.provider !== remembered.route.provider || sel?.model !== remembered.route.model) return next();
      ctx.logger.info(`meow-memory: restore main model ${remembered.main.provider}/${remembered.main.model} after memory task turn`);
      agent.model.select({
        provider: remembered.main.provider,
        model: remembered.main.model,
        ...remembered.main.reasoningEffort === void 0 ? {} : { reasoningEffort: remembered.main.reasoningEffort }
      });
      return next();
    });
    ctx.on("agent/request", async (payload, next) => {
      const config3 = await next();
      const agent = payload?.agent;
      if (agent === void 0 || typeof agent.model?.select === "function") return config3;
      if (agent.session?.header?.origin === "subagent") return config3;
      const sid = sessionIdOfAgent(agent);
      const events = sessionEventsOf(agent.session);
      if (isMemoryTaskTurn(events)) {
        const route = { provider: spec.provider ?? config3.provider, model: spec.model ?? config3.model };
        rememberOverride(sid, mainRouteOf(config3), route);
        ctx.logger.info(`meow-memory: memory task turn \u2192 model override ${spec.provider ?? "(inherit)"}/${spec.model ?? ""}${resolved.delegate.effort === void 0 ? " (effort stripped)" : ` (effort ${resolved.delegate.effort})`}`);
        const { reasoningEffort: _mainEffort, ...rest2 } = config3;
        return {
          ...rest2,
          ...spec.provider !== void 0 ? { provider: spec.provider } : {},
          ...spec.model !== void 0 ? { model: spec.model } : {},
          ...resolved.delegate.effort !== void 0 && resolved.delegate.effort !== "inherit" ? { reasoningEffort: resolved.delegate.effort } : resolved.delegate.effort === "inherit" && _mainEffort !== void 0 ? { reasoningEffort: String(_mainEffort) } : {}
        };
      }
      const remembered = delegateRestore.get(sid);
      if (remembered === void 0) return config3;
      delegateRestore.delete(sid);
      if (userSelectedAfterOverride(events, remembered.route)) return config3;
      if (config3.provider !== remembered.route.provider || config3.model !== remembered.route.model) return config3;
      ctx.logger.info(`meow-memory: restore main model ${remembered.main.provider}/${remembered.main.model} after memory task turn`);
      const { reasoningEffort: _inherited, ...rest } = config3;
      return { ...rest, provider: remembered.main.provider, model: remembered.main.model, ...remembered.main.reasoningEffort === void 0 ? {} : { reasoningEffort: remembered.main.reasoningEffort } };
    });
    ctx.logger.info(`meow-memory: model override armed for reflect/dream turns (${spec.provider ?? "(inherit)"}/${spec.model ?? ""}, effort ${resolved.delegate.effort ?? "stripped"} \u2014 #98: target model with undeclared reasoning efforts fails UNSUPPORTED_REASONING_EFFORT unless stripped; set delegate.effort to override)`);
  }
  const dreamSweepBlocked = (ws) => workspaceDisabled(ws) || isUntrustedMemoryWorkspace(ws);
  const stopDream = scheduleDream(ctx, resolved.dream, resolved.projectDir, windowIndex, signalDreamState, dreamSweepBlocked);
  ctx.logger.info(
    `meow-memory: dream scheduled (idle ${resolved.dream.idleMinutes}m, suppress ${resolved.dream.suppressWindows.map((w) => `${w.start}-${w.end}`).join(" ")} lead ${resolved.dream.suppressLeadMinutes}m, every ${resolved.dream.checkMinutes}m, tz ${resolved.dream.timeZone}, rules review ${resolved.dream.rulesReviewDays}d)`
  );
  const routeDisposers = [];
  let routeTimer = 0;
  const tryRegisterDreamRoutes = (attempt) => {
    const ws = ctx.get?.("webServer");
    if (ws !== void 0 && typeof ws.register === "function") {
      const gated = (handler) => authGateLazy(ctx, handler, {
        onDegraded: () => {
          ctx.logger.warn("meow-memory: connection \u670D\u52A1\u4E0D\u53EF\u7528\uFF0C/meow-memory/* \u8DEF\u7531\u964D\u7EA7\u4E3A\u73AF\u56DE fence\uFF08#78\uFF1A\u65E0 cookie \u8BA4\u8BC1\uFF0C\u8DE8\u7AD9\u8BFB\u5199\u4ECD\u5168\u6321\uFF09");
        }
      });
      const registerOne = (route) => {
        try {
          routeDisposers.push(ctx.effect(() => ws.register(route)));
        } catch (e) {
          ctx.logger.warn(`meow-memory: route ${route.path} \u6CE8\u518C\u5931\u8D25: ${e instanceof Error ? e.message : String(e)}`);
        }
      };
      registerOne({
        kind: "exact",
        path: "/meow-memory/dreamed-sessions",
        handler: gated((_req, res) => {
          void (async () => {
            try {
              const sessionPersistence = ctx.get?.("sessionPersistence");
              const sessions = typeof sessionPersistence?.list === "function" ? await sessionPersistence.list() : [];
              const states = collectDreamStates(sessions, resolved.projectDir);
              writeJson(res, 200, { sessionIds: states.dreamed, dreamingIds: states.dreaming });
            } catch (e) {
              writeJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
            }
          })();
        })
      });
      registerOne({
        kind: "exact",
        path: "/meow-memory/dream-events",
        handler: gated((req, res) => broadcast.handle(req, res))
      });
      registerOne({
        kind: "exact",
        path: "/meow-memory/skip-dreams",
        handler: gated((req, res) => {
          void (async () => {
            try {
              if (req.method === "POST") {
                const body = await readJsonBody(req);
                const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
                if (sessionId.length === 0) return writeJson(res, 400, { ok: false, error: "sessionId required" });
                let field = "dream";
                let value = body.skip === true;
                if (body.field !== void 0) {
                  if (body.field !== "dream" && body.field !== "inject" && body.field !== "write") {
                    return writeJson(res, 400, { ok: false, error: "field must be dream|inject|write" });
                  }
                  field = body.field;
                  value = body.value === true;
                }
                const ws2 = await resolveWorkspaceForSession(ctx, sessionId);
                if (ws2 === null) return writeJson(res, 404, { ok: false, error: "unknown session (no workspace)" });
                getDb(ws2, resolved.projectDir).setMemoryScopeField(sessionId, field, value);
                if (field === "dream") broadcast.broadcast(sessionId, value ? "skip" : "unskip");
                broadcast.broadcastScope(sessionId, field, value);
                ctx.logger.info(`meow-memory: memory scope ${field}=${value ? "on" : "off"} for ${shortSessionId(sessionId)}`);
                return writeJson(res, 200, { ok: true, field, value });
              }
              const workspaces = /* @__PURE__ */ new Set();
              for (const [, w] of windowIndex) {
                if (typeof w === "string" && w.length > 0) workspaces.add(w);
              }
              const ids = /* @__PURE__ */ new Set();
              const scopes = [];
              for (const w of workspaces) {
                if (!existsSync9(memoryDbPath(w, resolved.projectDir))) continue;
                try {
                  for (const sc of getDb(w, resolved.projectDir).listMemoryScopes()) {
                    scopes.push({ sessionId: sc.session_id, dream: sc.dream, inject: sc.inject, write: sc.write });
                    if (sc.dream) ids.add(sc.session_id);
                  }
                } catch {
                }
              }
              writeJson(res, 200, { sessionIds: [...ids], scopes });
            } catch (e) {
              writeJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
            }
          })();
        })
      });
      ctx.logger.info("meow-memory: dreamed-sessions snapshot + dream-events SSE + skip-dreams routes registered (behind auth gate)");
      return;
    }
    if (attempt < 20) {
      routeTimer = setTimeout(() => tryRegisterDreamRoutes(attempt + 1), 1e3);
    } else {
      ctx.logger.warn("meow-memory: webServer \u670D\u52A1 20s \u5185\u672A\u5C31\u7EEA\uFF0C\u4F1A\u8BDD\u5217\u8868 dream \u56FE\u6807\u6570\u636E\u8DEF\u7531\u672A\u6CE8\u518C");
    }
  };
  tryRegisterDreamRoutes(0);
  const commandDisposers = [];
  let commandTimer = 0;
  const tryRegisterDreamCommand = (attempt) => {
    const commands = ctx.get?.("commands");
    if (commands !== void 0 && typeof commands.register === "function") {
      try {
        commandDisposers.push(ctx.effect(() => commands.register(dreamCommandDefinition(ctx, resolved.projectDir, signalDreamState, () => resolved.dream.rulesReviewDays, workspaceDisabled, isUntrustedMemoryWorkspace))));
        ctx.logger.info("meow-memory: /dream user command registered");
      } catch (e) {
        ctx.logger.warn(`meow-memory: /dream \u547D\u4EE4\u6CE8\u518C\u5931\u8D25: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        commandDisposers.push(ctx.effect(() => commands.register(trustCommandDefinition())));
        ctx.logger.info("meow-memory: /meow-trust user command registered");
      } catch (e) {
        ctx.logger.warn(`meow-memory: /meow-trust \u547D\u4EE4\u6CE8\u518C\u5931\u8D25: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    if (attempt < 20) {
      commandTimer = setTimeout(() => tryRegisterDreamCommand(attempt + 1), 1e3);
    } else {
      ctx.logger.warn("meow-memory: commands \u670D\u52A1 20s \u5185\u672A\u5C31\u7EEA\uFF0C/dream \u7528\u6237\u547D\u4EE4\u672A\u6CE8\u518C\uFF08memory_dream \u5DE5\u5177\u4E0D\u53D7\u5F71\u54CD\uFF09");
    }
  };
  tryRegisterDreamCommand(0);
  ctx.on("dispose", () => {
    for (const dispose of toolDisposers) {
      try {
        dispose();
      } catch {
      }
    }
    for (const dispose of routeDisposers) {
      try {
        dispose();
      } catch {
      }
    }
    for (const dispose of commandDisposers) {
      try {
        dispose();
      } catch {
      }
    }
    clearTimeout(routeTimer);
    clearTimeout(commandTimer);
    stopDream();
    disposeDreamHeartbeats();
    broadcast.dispose();
    try {
      closeAllDbs();
    } catch {
    }
  });
}
function writeJson(res, status, body) {
  try {
    const r = res;
    r.writeHead?.(status, { "content-type": "application/json" });
    r.end?.(JSON.stringify(body));
  } catch {
  }
}
function readJsonBody(req, maxBytes = 65536) {
  return new Promise((resolve2, reject) => {
    const r = req;
    const chunks = [];
    let size = 0;
    r.on?.("data", (chunk) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(buf);
    });
    r.on?.("end", () => {
      if (chunks.length === 0) {
        resolve2({});
        return;
      }
      try {
        resolve2(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    r.on?.("error", (e) => reject(e instanceof Error ? e : new Error(String(e))));
  });
}
async function resolveWorkspaceForSession(ctx, sessionId) {
  const direct = windowIndex.get(sessionId);
  if (typeof direct === "string" && direct.length > 0) return direct;
  try {
    const sp = ctx.get?.("sessionPersistence");
    const sessions = typeof sp?.list === "function" ? await sp.list() : [];
    const hit = sessions.map(headerOf).find((h) => h.id === sessionId);
    if (hit && typeof hit.cwd === "string" && hit.cwd.length > 0) {
      windowIndex.set(sessionId, hit.cwd);
      persistWindowIndex();
      return hit.cwd;
    }
  } catch {
  }
  return null;
}
var windowIndex = /* @__PURE__ */ new Map();
function loadWindowIndex(dir = ".dsh-meow", indexFile = join9(activeHomeDir(), "window-index.json")) {
  const workspaces = /* @__PURE__ */ new Set();
  try {
    const merged = JSON.parse(readFileSync8(indexFile, "utf8"));
    for (const [sid, ws] of Object.entries(merged)) {
      if (typeof ws === "string" && ws.length > 0) {
        windowIndex.set(sid, ws);
        workspaces.add(ws);
      }
    }
  } catch {
  }
  for (const ws of workspaces) {
    if (!existsSync9(ws) || !existsSync9(memoryDbPath(ws, dir))) continue;
    try {
      for (const w of getDb(ws, dir).listWindows()) {
        if (typeof w.workspace === "string" && w.workspace.length > 0) windowIndex.set(w.session_id, w.workspace);
      }
    } catch {
    }
  }
}
function persistWindowIndex() {
  const indexFile = join9(activeHomeDir(), "window-index.json");
  try {
    mkdirSync6(dirname6(indexFile), { recursive: true });
    let merged = {};
    try {
      merged = JSON.parse(readFileSync8(indexFile, "utf8"));
    } catch {
    }
    for (const [sid, ws] of windowIndex) merged[sid] = ws;
    writeFileSync5(indexFile, JSON.stringify(merged), "utf8");
  } catch {
  }
}
// 给 memory_search 用的入口：一次检索不阻塞在「建向量」上。
// 第一次调用顺手把预热排进后台（不 await），等向量攒齐了下一问自然变准；
// 预热失败也不影响本次结果——这条路上任何一环坏掉，退回去的答案都必须是词法原样。
let denseWarmPromise = null;
// [macro-fusion 0.5.0 · P1] 词法这一路换成 searchAdaptive：听不懂时再按「碎片 → 整词」的桥听一遍。
// 稠密这一路只要接上了就用它的融合结果（FUSION 已经做了词法+稠密的取舍），接不上则整条路走词法。
async function rankForSearch(query, docs, opts = {}) {
  // [macro-fusion 0.6.0 · P1] 产品入口默认开「规模自适应 idf」：库越大越容易把正解淹掉，
  // 这一层专治那个。引擎里自带规模闸门（N<300 时 λ 恒 0，逐位不变），所以小库零风险；
  // 要退回 0.5.0 的老行为，调用时传 `adaptiveIdf:false`，不用改代码也不用改配置。
  const o = opts.adaptiveIdf === false ? opts : { ...opts, adaptiveIdf: true };
  if (denseDisabled()) return searchAdaptive(query, docs, o);
  let fused = null;
  try { fused = await searchHybrid(query, docs, o); } catch { fused = null; }
  if (denseWarmPromise === null && denseRt.state !== 'off') {
    denseWarmPromise = denseWarm(docs, opts).catch(() => null);
  }
  return fused ?? searchAdaptive(query, docs, o);
}

// ═══════════════════════ [macro-fusion 0.2.154] 稠密向量：可选的一路 ═══════════════════════
// 为什么是「可选」而不是「多一路信号就更准」：实测（bge-small-zh-v1.5，gold 40 条）
// 纯稠密在照抄池只有 0.689–0.711，输给 bm25 的 0.911——它抓不住精确术语；但换说法池它
// 能从 0.500 抬到 0.643。两个池的结论只有一条能同时成立：融合，而且稠密的权重必须小。
// RRF(k=60, 词法 1 : 稠密 0.25) 是实测的甜点：照抄 0.911→0.933，换说法 0.500→0.571。
// 依赖不许硬要：没有 @huggingface/transformers、没有本地模型目录、模型加载失败——
// 任何一种都静悄悄退回纯词法，一次警告都不打（打警告等于每轮都花 token 说同一件事）。
// 关掉稠密的总开关（MEOW_DENSE=0）：库里那套向量可以留在磁盘上，但这一进程只走词法。
// 三处入口（rankForSearch / denseRank / denseWarm）都必须认这一个开关——
// 只认一处会让「关掉了却还在算」，排查时看到的结果就成了谎话。
function denseDisabled() {
  return typeof process !== 'undefined' && String(process.env?.MEOW_DENSE ?? '') === '0';
}
const DENSE_RRF_K = 60;
// 实测定标（逐条编码，与 denseWarm 同口径）：w=0.10 时照抄 0.911 / 换说法 0.571/0.786/0.685；
// w=0.25 时照抄 0.933 / 换说法 0.571/0.786/0.702，且照抄池里原本正确的第 1 条一条都没掉。
// 两个池同时不劣化才算升级——准确率不能靠「换一批对、换一批错」。
const DENSE_WEIGHT_DEFAULT = 0.25;
const DENSE_TOP_DOCS = 30;
// 一次只编一条：批编码在 transformers.js 里会按批内最长补 padding，实测同一段文字
// 「单独编」与「16 条一批编」的向量最大差 0.015——近分带足够翻名次，而且同一条记忆会因为
// 「库里还有谁」而拿到不同向量。宁可慢三倍，也要让向量只取决于它自己（缓存才有意义）。
const DENSE_BATCH = 1;
const DENSE_MODULE_ENV = 'MEOW_VEC_MODULE';
const DENSE_MODEL_ENV = 'MEOW_VEC_MODEL_DIR';
const DENSE_CACHE_ENV = 'MEOW_VEC_CACHE';
let denseRt = { state: 'unloaded', err: null, extractor: null, model: '', dim: 0, loadedAt: 0 };
const denseVecs = new Map();
const denseCacheMeta = { path: null, model: '', dim: 0, dirty: false, loaded: false, written: 0 };

function fnv1aOf(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 255;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= (str.charCodeAt(i) >>> 8) & 255;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
// 逐条的向量缓存键：id + 正文/标题/关键词全文。改一个字就换键，旧向量留着自己老死。
function denseHashOf(str) {
  const t = String(str ?? '');
  return fnv1aOf(t, 2166136261).toString(16).padStart(8, '0') + fnv1aOf(t, 16777619).toString(16).padStart(8, '0') + '.' + t.length.toString(16);
}
// 进向量的文本只用「标题 + 正文」：关键词是标签不是正文（0.2.152 刚把它从词法语料里拆出来），
// 稠密这边同理——把标签拼进去会把一条短结论的向量拉向它的标签，实测换说法池从 0.643 掉到 0.571。
function denseTextOf(d) {
  const kw = Array.isArray(d?.keywords) ? d.keywords.filter((x) => typeof x === 'string' && x.length > 0).join(' ') : '';
  return [String(d?.title ?? ''), kw, String(d?.content ?? '')].filter((x) => x.length > 0).join('\n');
}
function denseKeyOf(d) {
  return denseHashOf(String(d?.id ?? '') + '\u0001' + denseTextOf(d));
}
// 零配置发现顺序：显式 → 环境变量 → 记忆家目录下的几个常规位置。
// 「用户把模型文件夹丢进 memory home 就能用」比「先教他配环境变量」重要得多。
function denseModelDir(opts) {
  const explicit = opts?.modelDir ?? (typeof process !== 'undefined' ? process.env?.[DENSE_MODEL_ENV] : void 0);
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit.trim();
  try {
    const home = activeHomeDir();
    if (typeof home !== 'string' || home.length === 0) return '';
    return '';
  } catch { return ''; }
}
function denseModelCandidates(opts) {
  const explicit = opts?.modelDir ?? (typeof process !== 'undefined' ? process.env?.[DENSE_MODEL_ENV] : void 0);
  if (typeof explicit === 'string' && explicit.trim().length > 0) return [explicit.trim()];
  const out = [];
  try {
    const home = activeHomeDir();
    if (typeof home === 'string' && home.length > 0) {
      out.push(home + '/dense-model', home + '/models/bge-small-zh-v1.5', home + '/dense/models/bge-small-zh-v1.5');
    }
  } catch { /* 家目录拿不到就只剩显式路径 */ }
  return out;
}
function denseCachePath(opts) {
  const v = opts?.vecCachePath ?? (typeof process !== 'undefined' ? process.env?.[DENSE_CACHE_ENV] : void 0);
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  try {
    const home = activeHomeDir();
    if (typeof home === 'string' && home.length > 0) return home + '/dense-cache.json';
  } catch { /* 没有家目录就不落盘，只留内存 */ }
  return '';
}

function denseStatus() {
  return {
    state: denseRt.state,
    err: denseRt.err,
    model: denseRt.model,
    dim: denseRt.dim,
    vecs: denseVecs.size,
    cache: denseCacheMeta.path,
    cacheLoaded: denseCacheMeta.loaded,
    cacheDirty: denseCacheMeta.dirty
  };
}

function clearDenseCache() {
  const n = denseVecs.size;
  denseVecs.clear();
  denseCacheMeta.loaded = false;
  denseCacheMeta.dirty = false;
  return n;
}

function denseDecode(b64, dim) {
  try {
    const buf = Buffer.from(String(b64), 'base64');
    if (buf.byteLength !== dim * 4) return null;
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  } catch { return null; }
}
function denseEncode(v) {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
}

async function denseLoadCache(opts) {
  const p = denseCachePath(opts);
  if (p === '' || denseCacheMeta.loaded) return;
  denseCacheMeta.loaded = true;
  denseCacheMeta.path = p;
  try {
    const fs = await import('node:fs');
    if (!fs.existsSync(p)) return;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    // 模型换了（名字或维度不同）→ 整份作废：不同模型的向量互相点乘是没有意义的数字。
    if (String(raw?.model ?? '') !== denseRt.model || Number(raw?.dim ?? 0) !== denseRt.dim) return;
    denseCacheMeta.model = denseRt.model;
    denseCacheMeta.dim = denseRt.dim;
    const items = raw?.items ?? {};
    let n = 0;
    for (const [k, b64] of Object.entries(items)) {
      const v = denseDecode(b64, denseRt.dim);
      if (v !== null) { denseVecs.set(k, v); n++; }
    }
    denseCacheMeta.written = n;
  } catch { /* 缓存坏了等于没有缓存，不该让检索跟着坏 */ }
}

async function denseSaveCache() {
  if (!denseCacheMeta.dirty || denseCacheMeta.path === '') return false;
  try {
    const fs = await import('node:fs');
    const items = {};
    for (const [k, v] of denseVecs) items[k] = denseEncode(v);
    const body = JSON.stringify({ model: denseRt.model, dim: denseRt.dim, items });
    const tmp = denseCacheMeta.path + '.tmp';
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, denseCacheMeta.path);
    denseCacheMeta.dirty = false;
    denseCacheMeta.written = denseVecs.size;
    return true;
  } catch { return false; }
}

// 加载顺序就是「容错顺序」：先看模型目录在不在（最常见的失败），再动态 import（第二常见）。
// 任何一步失败都落成 state='off' 并记住原因，之后不再重试——每次检索都重试等于每轮付一次超时的代价。
async function denseLoad(opts = {}) {
  if (denseRt.state !== 'unloaded') return denseRt;
  denseRt.state = 'loading';
  try {
    const candidates = denseModelCandidates(opts);
    if (candidates.length === 0) throw new Error('未配置模型目录（' + DENSE_MODEL_ENV + '）');
    const fs = await import('node:fs');
    const pathMod = await import('node:path');
    const dir = candidates.find((c) => fs.existsSync(pathMod.join(c, 'config.json')));
    if (dir === void 0) throw new Error('候选目录里没有 config.json：' + candidates.join(' | '));
    const spec = String(opts?.vecModule ?? (typeof process !== 'undefined' ? process.env?.[DENSE_MODULE_ENV] : '') ?? '').trim() || '@huggingface/transformers';
    // [macro-fusion 0.2.169] 「带斜杠就是路径」这个判据把 scoped 包名一起判死了：
    // `@huggingface/transformers` 里有 "/"，于是被拼成 `file:///@huggingface/transformers`，
    // 动态 import 报 `File URL path must be absolute`——这个错被 catch 成 state='off'，
    // 于是稠密通道在本机**从未真正加载过一次**（denseStatus() 一直是 unloaded/off，
    // 0.2.154 的闸门、0.2.166 的兜底全都在空转，而且一声不响）。
    // 只有「真的像路径」的才按路径处理：file: 前缀、./ ../ 开头、盘符、或以 / 开头的绝对路径。
    const asPath = spec.startsWith('file:') || spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec);
    const mod = asPath
      ? await import(spec.startsWith('file:') ? spec : 'file:///' + spec.replace(/\\/g, '/'))
      : await import(spec);
    const pipe = mod?.pipeline ?? mod?.default?.pipeline;
    const env = mod?.env ?? mod?.default?.env;
    if (typeof pipe !== 'function' || env === void 0) throw new Error('模块里没有 pipeline/env');
    env.allowRemoteModels = false;  // 离线优先：宁可退回词法，也不在检索里等一个下载
    env.allowLocalModels = true;
    env.localModelPath = pathMod.dirname(dir) + pathMod.sep;
    const model = pathMod.basename(dir);
    const dtype = typeof opts?.dtype === 'string' ? opts.dtype : 'q8';
    const extractor = await pipe('feature-extraction', model, { dtype });
    const dim = Number(extractor?.model?.config?.hidden_size) || Number(opts?.dim) || 0;
    if (!(dim > 0)) throw new Error('拿不到向量维度');
    denseRt = { state: 'ready', err: null, extractor, model: model + '#' + dtype, dim, loadedAt: Date.now() };
    await denseLoadCache(opts);
  } catch (e) {
    denseRt = { state: 'off', err: String(e?.message ?? e), extractor: null, model: '', dim: 0, loadedAt: Date.now() };
  }
  return denseRt;
}

async function denseEmbed(texts, opts = {}) {
  const rt = await denseLoad(opts);
  if (rt.state !== 'ready' || texts.length === 0) return null;
  const out = await rt.extractor(texts, { pooling: 'mean', normalize: true });
  const dims = Array.isArray(out?.dims) ? out.dims : null;
  const data = out?.data ?? null;
  if (dims === null || data === null) return null;
  const dim = dims[dims.length - 1];
  const rows = dim > 0 ? Math.floor(data.length / dim) : 0;
  if (rows !== texts.length) return null;
  const vecs = [];
  for (let i = 0; i < rows; i++) vecs.push(data.slice(i * dim, (i + 1) * dim));
  return vecs;
}

function denseDot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

// 预热：把库里还没有向量的条目编码掉，落盘。分批是为了「一次别把事件循环按太久」。
async function denseWarm(docs, opts = {}) {
  if (denseDisabled()) return { state: 'off', err: 'disabled by MEOW_DENSE=0', embedded: 0, total: Array.isArray(docs) ? docs.length : 0, cached: 0 };
  const rt = await denseLoad(opts);
  if (rt.state !== 'ready') return { state: rt.state, err: rt.err, embedded: 0, total: Array.isArray(docs) ? docs.length : 0, cached: 0 };
  const list = Array.isArray(docs) ? docs : [];
  const todo = [];
  for (const d of list) {
    const key = denseKeyOf(d);
    if (!denseVecs.has(key)) todo.push({ key, text: denseTextOf(d) });
  }
  let embedded = 0;
  for (let i = 0; i < todo.length; i += DENSE_BATCH) {
    const batch = todo.slice(i, i + DENSE_BATCH);
    let vecs = null;
    try { vecs = await denseEmbed(batch.map((t) => t.text), opts); } catch { vecs = null; }
    if (vecs === null) break;
    for (let j = 0; j < batch.length; j++) {
      denseVecs.set(batch[j].key, vecs[j]);
      embedded++;
    }
    denseCacheMeta.dirty = true;
  }
  if (embedded > 0) await denseSaveCache();
  return { state: 'ready', err: null, embedded, total: list.length, cached: denseVecs.size };
}

// 只对「已经有向量」的条目算余弦：没预热过的条目这一轮就不参与稠密排序，
// 这是「先能用、再变准」——而不是「让第一次检索等 24 秒」。
async function denseRank(query, docs, opts = {}) {
  if (denseDisabled()) return null;
  const rt = await denseLoad(opts);
  if (rt.state !== 'ready') return null;
  const qv = await denseEmbed([String(query ?? '')], opts);
  if (qv === null || qv.length === 0) return null;
  const q0 = qv[0];
  const scored = [];
  let covered = 0;
  for (const d of docs) {
    const v = denseVecs.get(denseKeyOf(d));
    if (v === void 0) continue;
    covered++;
    scored.push({ id: String(d.id), cos: denseDot(q0, v) });
  }
  if (covered === 0) return null;
  scored.sort((a, b) => b.cos - a.cos || cmpText(a.id, b.id));
  const top = Math.max(1, Math.min(scored.length, Number.isFinite(opts.denseTop) ? opts.denseTop : DENSE_TOP_DOCS));
  return { ranked: scored.slice(0, top), covered, total: docs.length };
}

// [macro-fusion 0.2.155] 稠密空手闸门：问句与库里任何一条都不沾边时，宁可不给答案。
//
// 为什么词法做不到：负样本里「火星上一天有多少小时」命中的那个词 df=1（idf 3.31），
// 是全库最稀的词——词法上它跟「真正相关」长得一模一样，只能靠语义分。
// 实测（40 条 gold 语料，全库最大余弦）：正样本最低 0.477，负样本除一条 0.521 外全在 0.412 以下；
// 门槛 0.44 时负样本挡掉 13/14、正样本误杀 0/58。
//
// 三条约束：
//   1. 只在「全库都有向量」时判——只覆盖一部分时最大值会被低估，会把真问题当无关问题掐掉。
//   2. 稠密没就绪（没装依赖 / 没模型 / 被 MEOW_DENSE=0 关掉）一律不判，行为与 0.2.154 逐位相同。
//   3. 门槛可调：MEOW_DENSE_ABSTAIN=<0~1>；给 0 或 off 就是关掉这道闸。
const DENSE_ABSTAIN_COS_DEFAULT = 0.44;
const DENSE_ABSTAIN_ENV = 'MEOW_DENSE_ABSTAIN';
let denseGateLast = null;

function denseAbstainCos() {
  const raw = String(process.env?.[DENSE_ABSTAIN_ENV] ?? '').trim();
  if (raw === '') return DENSE_ABSTAIN_COS_DEFAULT;
  if (raw === '0' || raw.toLowerCase() === 'off') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : DENSE_ABSTAIN_COS_DEFAULT;
}

// 这一问与全库最近的一条有多近（0~1）。全库没向量就返回 null——宁可不说，也不猜。
async function denseNearest(query, docs, opts = {}) {
  if (denseDisabled()) return null;
  const rt = await denseLoad(opts);
  if (rt.state !== 'ready') return null;
  const list = Array.isArray(docs) ? docs : [];
  if (list.length === 0) return null;
  const qv = await denseEmbed([String(query ?? '')], opts);
  if (qv === null || qv.length === 0) return null;
  const q0 = qv[0];
  let max = -1;
  let id = null;
  let covered = 0;
  for (const d of list) {
    const v = denseVecs.get(denseKeyOf(d));
    if (v === void 0) continue;
    covered++;
    const c = denseDot(q0, v);
    if (c > max) { max = c; id = String(d.id); }
  }
  if (covered !== list.length) return { covered, total: list.length, max: max >= 0 ? max : 0, id };
  return { covered, total: list.length, max: max >= 0 ? max : 0, id };
}

// 闸门判决：{ fired, cos, th, why }。why 是给人看的一句话，回执里会用到。
async function denseGate(query, docs, opts = {}) {
  const th = denseAbstainCos();
  const info = { fired: false, cos: null, th, why: '', nearest: null, covered: 0, total: 0 };
  if (th <= 0) { info.why = '闸门关着（MEOW_DENSE_ABSTAIN=0）'; denseGateLast = info; return info; }
  if (denseDisabled()) { info.why = '稠密被 MEOW_DENSE=0 关掉，不判'; denseGateLast = info; return info; }
  const near = await denseNearest(query, docs, opts);
  if (near === null) { info.why = '稠密没就绪，不判'; denseGateLast = info; return info; }
  info.covered = near.covered;
  info.total = near.total;
  info.nearest = near.id;
  if (near.covered !== near.total) {
    info.why = `向量只覆盖 ${near.covered}/${near.total} 条，最大值会被低估，这一轮不判`;
    denseGateLast = info;
    return info;
  }
  info.cos = near.max;
  info.fired = near.max < th;
  info.why = info.fired
    ? `与全库最近的一条（${String(near.id).slice(0, 8)}）余弦只有 ${near.max.toFixed(3)}，低于门槛 ${th}`
    : `最近一条余弦 ${near.max.toFixed(3)}，不低于门槛 ${th}`;
  denseGateLast = info;
  return info;
}

// RRF(k=60)：名次换分，不拿余弦跟 BM25 直接相加——两个量的尺度本来就无关，
// 相加等于让「谁的单位大」决定排序（实测直接相加时照抄池掉到 0.867）。
function fuseDenseHits(lexHits, denseRes, docs, opts = {}) {
  const K = Number.isFinite(opts.denseK) ? opts.denseK : DENSE_RRF_K;
  const w = Number.isFinite(opts.denseWeight) ? opts.denseWeight : DENSE_WEIGHT_DEFAULT;
  const lexRank = new Map();
  lexHits.forEach((h, i) => lexRank.set(String(h.id), i + 1));
  const denseCos = new Map();
  denseRes.ranked.forEach((d) => denseCos.set(d.id, d.cos));
  const fuse = new Map();
  for (const [id, r] of lexRank) fuse.set(id, 1 / (K + r));
  denseRes.ranked.forEach((d, i) => fuse.set(d.id, (fuse.get(d.id) ?? 0) + w / (K + i + 1)));
  const docById = new Map(docs.map((d) => [String(d.id), d]));
  const byId = new Map(lexHits.map((h) => [String(h.id), h]));
  const order = [...fuse.entries()].sort((a, b) => b[1] - a[1] || cmpText(a[0], b[0]));
  const maxRrf = order.length > 0 ? order[0][1] : 0;
  // 分数口径：把 RRF 归一化回「词法的榜首分」——下游的 min_rel 是相对榜首的百分比，
  // 换一套尺度会让 0.35 这条线突然变成另一个意思。
  const topLex = lexHits.length > 0 ? lexHits[0].score : 0;
  const scale = topLex > 0 ? topLex : 1;
  const out = [];
  for (const [id, s] of order) {
    const score = maxRrf > 0 ? scale * (s / maxRrf) : 0;
    const base = byId.get(id);
    if (base !== void 0) {
      const h = { ...base, score };
      if (opts.explain === true) {
        h.explain = {
          ...(base.explain ?? {}),
          score: Math.round(score * 1e3) / 1e3,
          rrf: Math.round(s * 1e6) / 1e6,
          ...(denseCos.has(id) ? { dense: Math.round(denseCos.get(id) * 1e3) / 1e3 } : {})
        };
      }
      out.push(h);
      continue;
    }
    const d = docById.get(id);
    if (d === void 0) continue;
    const impW = 1 + (Math.min(4, Math.max(1, Math.round(Number(d?.importance) || 1))) - 1) * 0.25;
    const row = {
      id: d.id,
      level: d.level,
      title: d.title,
      content: d.content,
      importance: d.importance,
      updated_at: d.updated_at,
      ...d.keywords === void 0 ? {} : { keywords: d.keywords },
      ...d.project === void 0 ? {} : { project: d.project },
      ...d.created_at === void 0 ? {} : { created_at: d.created_at },
      ...d.source_session === void 0 ? {} : { source_session: d.source_session },
      score
    };
    if (opts.explain === true) {
      row.explain = {
        bm25: 0,
        importance: d.importance,
        importanceWeight: Math.round(impW * 1e3) / 1e3,
        recencyWeight: 1,
        statusWeight: statusWeight(d?.status),
        score: Math.round(score * 1e3) / 1e3,
        rrf: Math.round(s * 1e6) / 1e6,
        denseOnly: true,
        ...(denseCos.has(id) ? { dense: Math.round(denseCos.get(id) * 1e3) / 1e3 } : {})
      };
    }
    out.push(row);
  }
  const k = Number.isFinite(opts.k) ? opts.k : out.length;
  return out.slice(0, Math.max(0, k));
}

// [macro-fusion 0.2.166] 稠密兜底（rescue）：只在词法「自己知道不行」的时候才给稠密话语权。
//
// 为什么需要：词法强不等于没有盲区。真库换说池 14 题里有 7 题没进 top3，它们的榜首覆盖度
// 全落在 0.072~0.142（命中题的覆盖度中位数是 1.00）——问句与记忆的字面几乎没沾上，靠调
// 打分权重救不回来；而同一批题里稠密能把其中 1 题排到第 1、1 题排到第 2。
// 为什么不能一直混：0.2.154 的并列 RRF 在现在这套词法上是有害的——五池一起量，
// 照抄 hit@1 0.956→0.933、换说法 0.798→0.738、锚点 0.883→0.825、真库自找 0.997→0.954。
// 词法已经很强时，稠密补的那张平票会把强序打散，赚到只有尾部一条。
//
// 做法：覆盖度 < DENSE_RESCUE_COVER 时，词法前 DENSE_RESCUE_HEAD 名原样不动，其后按稠密
// 余弦重排（余弦低于 DENSE_RESCUE_COS 的不进来）。保住「已经答对的那部分」，只重排本来
// 就不可信的尾巴——这是「往下削一律伤」那条经验的加法侧版本。
// 实测（θ0.2 / head4 / cos0.45，五池 233 题）：hit@1 与 hit@3 一条不动，top5 三池各 +1
// （照抄 44→45、换说法 13→14、真库换说 12→13），MRR 0.956 / 0.810 / 0.883 / 0.997 / 0.542。
// 稠密没就绪（没模型、没依赖、MEOW_DENSE=0）时这条路径一次都不触发——行为与 0.2.165 逐位相同。
var DENSE_RESCUE_COVER = 0.2;
var DENSE_RESCUE_HEAD = 4;
var DENSE_RESCUE_COS = 0.45;
// [macro-fusion 0.2.169] 兜底也要限量：0.2.166 只写了「尾按余弦重排」，没写「补几条」，
// 于是一路参考 DENSE_TOP_DOCS=30 地往里塞——真库换说池实测回执从 4.54 条 / 943 字
// 涨到 8.23 条 / 1746 字，等于用一条正解换三四条陪跑。补位是「把话说得下去」，
// 不是「把库倒出来」：只补稠密序列里最靠前的两条（cos 已过门槛），其余原样。
var DENSE_RESCUE_MAX = 2;

function rescueByDense(lexHits, denseRes, docs, opts = {}) {
  const head = Number.isFinite(opts.rescueHead) ? Math.max(0, Math.round(opts.rescueHead)) : DENSE_RESCUE_HEAD;
  const minCos = Number.isFinite(opts.rescueCos) ? opts.rescueCos : DENSE_RESCUE_COS;
  const maxRescue = Number.isFinite(opts.rescueMax) ? Math.max(0, Math.round(opts.rescueMax)) : DENSE_RESCUE_MAX;
  const prefix = lexHits.slice(0, head);
  const seen = new Set(prefix.map((h) => String(h.id)));
  const byId = new Map();
  for (const h of lexHits) byId.set(String(h.id), h);
  const docById = new Map();
  for (const d of docs) docById.set(String(d.id), d);
  const out = prefix.slice();
  let added = 0;
  for (const r of denseRes.ranked) {
    // ranked 已按余弦降序：跌破门槛就可以停，别把「不相关的」当兜底塞回来。
    if (!(r.cos >= minCos)) break;
    if (added >= maxRescue) break;
    const id = String(r.id);
    if (seen.has(id)) continue;
    seen.add(id);
    added += 1;
    const hit = byId.get(id);
    if (hit !== void 0) { out.push(hit); continue; }
    // 词法一个字都没沾上的条目：从语料里把正文捞回来，不能只回一个 id —— 那条对调用方没用。
    const d = docById.get(id);
    if (d === void 0) continue;
    out.push({
      id: d.id,
      level: d.level,
      title: d.title,
      content: d.content,
      importance: d.importance,
      updated_at: d.updated_at,
      ...d.keywords === void 0 ? {} : { keywords: d.keywords },
      ...d.project === void 0 ? {} : { project: d.project },
      ...d.created_at === void 0 ? {} : { created_at: d.created_at },
      ...d.source_session === void 0 ? {} : { source_session: d.source_session },
      cover: 0,
      _dense: Math.round(r.cos * 1e3) / 1e3,
      score: Math.round(r.cos * 1e3) / 1e3,
      ...opts.explain === true ? { explain: { cover: 0, dense: Math.round(r.cos * 1e3) / 1e3, rescue: true, score: Math.round(r.cos * 1e3) / 1e3 } } : {}
    });
  }
  // 词法里排在 head 之后的，默认不再整段接回来：救援这条路径本来就是因为「词法这题没把握」
  // 才走的，把没把握的尾巴原样铺在后面等于既没修好、又更长。折掉的条数照 0.2.167 的规矩
  // 挂在 trimmed 上报出来（要全量仍可 band_keep:false）。
  let tailDropped = 0;
  for (const h of lexHits.slice(head)) {
    const id = String(h.id);
    if (seen.has(id)) continue;
    seen.add(id);
    if (opts.rescueDropTail === false) { out.push(h); continue; }
    tailDropped += 1;
  }
  if (tailDropped > 0) {
    try {
      Object.defineProperty(out, "trimmed", { value: tailDropped, enumerable: false, configurable: true });
      // 单独记一笔：这刀折的是「词法尾部」，和下面 band 那刀折的「同档之外」不是一回事，
      // 混在一个数里，note 里就会出现「折了 11 条」却只有 1 条真的被折掉这种自相矛盾。
      Object.defineProperty(out, "rescueTrimmed", { value: tailDropped, enumerable: false, configurable: true });
    } catch {
    }
  }
  // 补了几条也要跟着回执走：读者看到一条分数只有 0.55、榜首 14.1 的条目，
  // 不说明来路就会当成噪声删掉——它恰恰是这次唯一答对的那条。
  if (added > 0) {
    try {
      Object.defineProperty(out, "rescueAdded", { value: added, enumerable: false, configurable: true });
    } catch {
    }
  }
  return out;
}

// 该不该走兜底：词法有结果、稠密就绪、榜首覆盖度低于门槛、没被人为关掉。
function denseRescueWanted(lexHits, opts = {}) {
  if (opts.denseRescue === false) return false;
  if (lexHits.length === 0) return false;
  const theta = Number.isFinite(opts.rescueCover) ? opts.rescueCover : DENSE_RESCUE_COVER;
  if (!(theta > 0)) return false;
  const cover = Number(lexHits[0].cover);
  if (!Number.isFinite(cover)) return false;
  return cover < theta;
}

// 对外的入口：词法先算（它永远在），稠密能上就上。
// 稠密这一路失败时**返回词法原样**，不返回空、不抛错——「可选」的含意就是失败等于没有。
async function searchHybrid(query, docs, opts = {}) {
  const lex = search(query, docs, { ...opts, keepBand: true });
  // [0.2.165] 退路也要走同一个裁剪口径，否则「关掉稠密」和「纯词法」两条路的条数不一样。
  if (opts.dense === false) return trimByBand(lex, opts.k, opts);
  let denseRes = null;
  try { denseRes = await denseRank(query, docs, opts); } catch { denseRes = null; }
  if (denseRes === null || denseRes.ranked.length === 0) return trimByBand(lex, opts.k, opts);
  // [0.2.166] 词法自己说「这题我没把握」时走兜底：head 不动，只重排尾巴。
  if (denseRescueWanted(lex, opts)) {
    return trimByBand(rescueByDense(lex, denseRes, docs, opts), opts.k, { ...opts, bandKeep: false });
  }
  // 词法有把握的时候，稠密不许插话：并列投票会把已经排好的强序打散——真库自找池
  // 149/150 会掉到 138/149（多出来的 11 道正是「本来答对」的题）。省下来的算力只花在
  // 词法自己承认不行的那道闸门后面。0.2.154 的 RRF 融合保留成显式开关（denseFuse），
  // 想要那股「平票也投一票」的行为随时能开回来，能力不砍。
  if (opts.denseFuse !== true) return trimByBand(lex, opts.k, opts);
  return trimByBand(fuseDenseHits(lex, denseRes, docs, opts), opts.k, opts);
}

export {
  CONFIG_DEFAULTS,
  clearDenseCache,
  denseGate,
  denseNearest,
  denseStatus,
  denseWarm,
  config as Config,
  DEFAULT_HOME_DIR,
  DEFAULT_LANG,
  DREAM_DELEGATE_MARKER,
  DREAM_MARKER,
  GLOBAL_PROJECT_CANON,
  GLOBAL_PROJECT_CANON_EN,
  LEVELS,
  MAX_REINJECT_PROJECTS,
  MAX_REINJECT_WRITTEN,
  MemoryDb,
  PLUGIN_SOURCE,
  PROJECT_SUBCATEGORIES,
  REFLECT_DELEGATE_MARKER,
  REFLECT_DONE_DELEGATE_MARKER,
  REFLECT_MARKER,
  SETTINGS_NS,
  SLOTS,
  abortDream,
  activeHomeDir,
  advanceDream,
  apply,
  applyLiveConfig,
  authGate,
  authGateLazy,
  backupMemoryDb,
  buildDreamMessage,
  buildHitInjection,
  buildInjection,
  buildProjectSectionText,
  buildReflectMessage,
  buildReinjection,
  clearReinjectPending,
  closeAllDbs,
  collectDreamRounds,
  collectDreamStates,
  connectionAuthOf,
  consecutiveToolSteps,
  disableWorkspaceTrust,
  dreamChainBlock,
  liftSuccessors,
  dreamRepeatIssues,
  dreamRepeatBlock,
  dreamChainIssues,
  dreamCommandDefinition,
  dreamPlanDigest,
  dreamReceipt,
  dreamStoreScale,
  dreamStoreProjects,
  readDreamLedger,
  readDreamProjects,
  readDreamRecord,
  readDreamRecordByRef,
  readDreamRecords,
  readRowsByIds,
  readDreamSpan,
  readLiveDream,
  dreamSweepOnce,
  dreamSweepTick,
  dshHomeDir,
  enableWorkspaceTrust,
  conflictCandidates,
  conflictWarn,
  factTokens,
  factoryDefaultOf,
  fillTemplate,
  findSimilar,
  getCurrentProject,
  getDb,
  getMemoryGuide,
  getPromptLang,
  globalProjectMarker,
  handleMemoryTurnFailure,
  hasExternalNoticeShown,
  headerOf,
  homeDirPresets,
  hourInTimeZone,
  incidentLines,
  incidentOf,
  incidentRepeatOf,
  readIncidentLedger,
  recordIncident,
  recordUnfixed,
  readReflectPending,
  writeReflectPending,
  clearReflectPending,
  settleReflect,
  inject,
  isDreamSuppressed,
  isGlobalProject,
  isGlobalScope,
  isMemoryTaskTurn,
  isReinjectPending,
  isSubagentAgent,
  isTrustedWorkspace,
  isUntrustedMemoryWorkspace,
  keyedValue,
  liveConfigReader,
  loadWindowIndex,
  markAccessed,
  markExternalNoticeShown,
  markInjected,
  markProjectQueried,
  markReinjectPending,
  markSearched,
  markWritten,
  memoryDbPath,
  mergeConfigLayer,
  migrateLegacy,
  minutesInTimeZone,
  name,
  newId,
  normalizeWorkspacePath,
  noteActivity,
  parseModelSpec,
  pluginRootDir,
  projectCovers,
  projectLabel,
  projectList,
  readInjected,
  readProjectQueried,
  readSeen,
  readWritten,
  recencyWeight,
  recoverInterruptedDream,
  reflectNeed,
  registerCreatedWorkspace,
  registerMemoryTools,
  relativeTime,
  releaseSeen,
  resolveHomeDir,
  resolveSlotText,
  resumeAndDream,
  scanTurn,
  search,
  searchHybrid,
  searchAdaptive,
  indexSignature,
  indexSignatureStats,
  resetIndexSignatureStats,
  verbatimHayStats,
  resetVerbatimHayStats,
  searchIndexOf,
  searchIndexCacheInfo,
  clearSearchIndexCache,
  keywordHitScore,
  // [macro-fusion 0.6.12] 定序原语对探针开放：`probe-order` 要拿它跟「全量排序再取前 k」逐位对拍。
  bandize,
  statusWeight,
  foldNearDupes,
  pickKeeper,
  seedTrustedWorkspaces,
  sendMemoryTurn,
  sessionEventsOf,
  sessionsFile,
  setActiveHomeDir,
  setCurrentProject,
  setMemoryToolGate,
  setMemoryTurnEnqueuedHookForTest,
  setPromptLang,
  startWindowDream,
  stemEn,
  sweepHomeLogs,
  switchHomeDir,
  tokenize,
  stripQuestionFrame,
  QUESTION_FRAME,
  SYN_GROUPS,
  SYN_W,
  SYN_MAX_DF_RATIO,
  SYN_MAX_PER_TERM,
  synExpandOf,
  COOC_W_SAME,
  COOC_W_PROJ,
  COOC_SHARE_HAN_W,
  COOC_MIN_COUNT,
  COOC_MIN_RATIO,
  COOC_TOP_PER_TERM,
  buildCoocSyn,
  identsOf,
  timeAnchorOf,
  TIME_ANCHOR_RE,
  weakHitOf,
  weakNoteOf,
  hintWordsOf,
  WEAK_COVER,
  WEAK_GAP,
  COORD_W_DEF,
  COORD_POW_DEF,
  DENSE_RESCUE_COVER,
  DENSE_RESCUE_HEAD,
  DENSE_RESCUE_COS,
  KW_TF_W,
  FIELD_KW_W_DEF,
  verbatimOf,
  topicDrift,
  trustCommandDefinition,
  trustWorkspace,
  validateConfigUserLayer,
  windowNeedsDream,
  workspaceDisabledMatch
};
//# sourceMappingURL=index.js.map
