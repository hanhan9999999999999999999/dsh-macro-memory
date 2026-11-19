/**
 * 项目根的单一出处。
 *
 * tools/ 下的脚本大部分要读两处东西：本仓（lib/、tools/、README）与 vendor/（两个真引擎）。
 * 以前每个脚本各算一遍，结果出现了 13 种写法：`dirname(dirname(fileURLToPath(…)))`、
 * 带 `/tools$` 的 replace、`process.cwd()`，还有两条把 `D:/dsh-home/...` 写死的绝对路径。
 * 前两种只是啰嗦；后两种是真毛病——换个目录跑就从别处找了（param-audit 会直接
 * ERR_MODULE_NOT_FOUND），而写死路径在别的机器上必定失效。
 *
 * 现在只有这里算一次：脚本一律 `import { root, vendorDir } from './_root.mjs'`。
 * 判据：根是「本文件所在目录的上一级」，与 cwd 无关、与安装位置无关。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** vendor/：两个真引擎（meow-memory / dsh-memory-nebula）所在目录。 */
export const vendorDir = join(root, 'vendor')

/** 拼一个仓内路径：at('lib', 'index.js')。 */
export function at(...segs) {
  return join(root, ...segs)
}
