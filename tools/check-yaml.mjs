import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const appRequire = createRequire('D:/DSH/DSH NEXT/resources/app/package.json')
const yaml = appRequire('js-yaml')

const profileDir = 'D:/dsh-home/profiles/desktop'
const patchPath = profileDir + '/cordis.patch.yml'
const doc = yaml.load(readFileSync(patchPath, 'utf8'))

console.log('parsed OK, top-level type =', Array.isArray(doc) ? 'array' : typeof doc)
console.log('entries =', doc.length)

const ids = doc.map((e) => e && e.id).filter(Boolean)
const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
console.log('duplicate ids =', dup.length ? dup : 'none')

for (const want of ['memory-nebula', 'meow-memory', 'macro-memory']) {
  const hits = doc.filter((e) => e && e.id === want)
  console.log(`  ${want}: ${hits.length}`)
  for (const h of hits) console.log('    ' + JSON.stringify(h))
}

// bundles
const pkg = JSON.parse(readFileSync(profileDir + '/package.json', 'utf8'))
const bundles = pkg?.dsh?.profile?.bundles ?? []
console.log('bundles =', bundles.length)
console.log('  has dsh-macro-memory:', bundles.includes('dsh-macro-memory'))
console.log('  has meow-memory:', bundles.includes('meow-memory'))
console.log('  has dsh-memory-nebula:', bundles.includes('dsh-memory-nebula'))

// every patch id must exist in some bundle layer patch or be a known root entry
import { existsSync } from 'node:fs'

// DSH 自带的基础包由 app 的 resources/app/node_modules 提供，不在 profile 里，
// 所以它们「不在 profile」是正常的；这里只报真正该由 profile 装的东西缺失。
const HOST_PROVIDED = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
let missing = 0
for (const b of bundles) {
  const p = `${profileDir}/node_modules/${b}/package.json`
  if (existsSync(p)) continue
  if (HOST_PROVIDED.has(b)) {
    console.log('  host-provided (来自 app resources):', b)
    continue
  }
  missing += 1
  console.log('  MISSING package:', b)
}
console.log(missing === 0 ? '  bundle 依赖齐全' : `  bundle 缺 ${missing} 个包`)
