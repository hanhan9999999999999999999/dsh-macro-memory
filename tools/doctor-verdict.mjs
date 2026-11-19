/**
 * 体检的判决器：打印一行，并记账。
 *
 * [macro-fusion 0.2.73] 为什么单独一个文件：判决原来写在 doctor.mjs 里，而 doctor 是
 * 「跑起来就有副作用」的脚本（顶层 readFileSync、process.exit），verify 没法 import 它来
 * 单测判决规则。判决是这套体检的**唯一出结论的地方**，它自己必须被测到，所以抽出来。
 *
 * 判决只看 tag：
 *   - tag === 'FAIL'  → 计失败（哪怕 ok 是 true）
 *   - tag === 'PASS' 且 ok 为假 → 计失败（声明通过却说没过）
 *   - tag === 'WARN' 或 ok 为假 → 计警告
 * 0.2.72 之前这里看的是第二参 ok，而 22 处调用写的是
 *   line(<cond> ? 'PASS' : 'FAIL', true, …)
 * —— ok 恒为 true，于是那些 FAIL 只是打印出来的四个字母：不打紧，结果照样 ALL PASS、exit 0。
 */
export function makeVerdict(log = console.log) {
  const state = { fails: 0, warns: 0 }

  const line = (tag, ok, name, extra = '') => {
    const failed = tag === 'FAIL' || (tag === 'PASS' && !ok)
    if (failed) state.fails++
    else if (tag === 'WARN' || !ok) state.warns++
    log(`${tag}  ${name}${extra ? `  ${extra}` : ''}`)
    return !failed
  }

  return {
    line,
    pass: (name, extra) => line('PASS', true, name, extra),
    fail: (name, extra) => line('FAIL', false, name, extra),
    warn: (name, extra) => line('WARN', false, name, extra),
    get fails() {
      return state.fails
    },
    get warns() {
      return state.warns
    },
  }
}

export default makeVerdict
