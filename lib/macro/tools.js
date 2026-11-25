/**
 * macro-memory 的统一工具面装配器：把 8 个 `defs/*.js` 拼成工具数组。
 *
 * 规矩（DESIGN §7 R2）：写路径一律复用子插件自己的工具定义，
 * 这里只做「选哪个子插件工具 + 参数路由 + 结果拼接」，绝不重写记忆逻辑。
 *
 * 0.2.5 起工具定义按「一个工具一个文件」放在 `lib/macro/defs/`，
 * 本文件只剩装配 + 兼容别名；加点工具时改一个文件、在下面 push 一行即可（DESIGN §16）。
 */
import { TEXT_OUT } from './shared.js'
import { createLinkFlow } from './linkflow.js'
import { createRemember } from './defs/remember.js'
import { createUpdate } from './defs/update.js'
import { createSearch } from './defs/search.js'
import { createRead } from './defs/read.js'
import { createProject } from './defs/project.js'
import { createLink } from './defs/link.js'
import { createDream } from './defs/dream.js'
import { createAdmin } from './defs/admin.js'

export { LEVELS, PROJECT_SUBCATEGORIES, neighborSection } from './shared.js'
export { LINKS_SCHEMA, normalizeLinks } from './linkflow.js'

export function createUnifiedTools({ bridge, config = {}, meowDir }) {
  const flow = createLinkFlow({ bridge, config })

  return [
    createRemember({ flow, config }),
    createUpdate({ flow, meowDir }),
    createSearch({ flow, config }),
    createRead({ flow, meowDir }),
    createProject({ flow }),
    createLink({ flow, meowDir }),
    createDream({ flow }),
    createAdmin({ flow, bridge, config, meowDir }),
  ]
}

/**
 * 兼容别名：把子插件原来的工具原样暴露（默认关）。
 * 只在主人明确要做 A/B 对比或第三方提示词还写着 nebula_* 时才打开。
 */
export function createAliasTools({ bridge }) {
  const wanted = [
    'memory_find_similar',
    'memory_home',
    'nebula_recall',
    'nebula_inspect',
    'nebula_link',
    'nebula_path',
    'nebula_stats',
    'nebula_hygiene',
    'nebula_bridge',
    'nebula_sources',
    'nebula_ingest',
  ]
  return wanted.map((name) => ({
    name,
    description: `兼容别名 → 建议改用 memory_* 统一工具（原 ${name}）。`,
    parameters: { type: 'object', additionalProperties: true, properties: {} },
    output: TEXT_OUT,
    async execute(args, exec) {
      const r = await bridge.call(name, args, exec)
      return r.text
    },
  }))
}
