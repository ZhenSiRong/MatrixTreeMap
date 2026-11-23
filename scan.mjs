// scan.mjs —— 把一个目录扫成 { lines, churn } 的嵌套树。
//
// 三条口径（对应设计决定）：
// - 面积 = 行数（二进制/无扩展名文件不计；行数按换行符统计）
// - 颜色 = git churn（git log --name-only 里该路径出现的次数；不追踪重命名）
// - **不排除任何目录**：node_modules 也在树里，靠前端"折叠"而不是过滤

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'

const run = promisify(execFile)

const TEXT = new Set([
  '.py', '.md', '.txt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.rs', '.go',
  '.java', '.c', '.h', '.cpp', '.hpp', '.css', '.scss', '.html', '.json', '.yaml',
  '.yml', '.toml', '.sh', '.sql', '.vue', '.svelte', '.rb', '.php', '.kt', '.swift',
])

export async function countLines(abs) {
  try {
    const buf = await readFile(abs)
    if (buf.length === 0) return 0
    let n = 0
    for (let i = 0; i < buf.length; i += 1) if (buf[i] === 10) n += 1
    return n + (buf[buf.length - 1] === 10 ? 0 : 1)
  } catch {
    return 0
  }
}

export async function scanChurn(root, timeoutMs = 20000) {
  const churn = new Map()
  try {
    const { stdout } = await run('git', ['-C', root, 'log', '--pretty=format:', '--name-only'], {
      maxBuffer: 256 * 1024 * 1024,
      timeout: timeoutMs,
    })
    for (const line of stdout.split('\n')) {
      const p = line.trim()
      if (p) churn.set(p, (churn.get(p) ?? 0) + 1)
    }
  } catch {
    // 不是 git 仓库时 churn 全 0
  }
  return churn
}

/** 扫一棵树。返回 { root: 节点, files: Map<相对路径, 行数> } */
export async function scanTree(root, { churn = new Map() } = {}) {
  const files = new Map()

  async function walk(abs, name, relPath) {
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => [])
    const children = []
    let lines = 0
    let churnSum = 0
    for (const entry of entries) {
      const childAbs = join(abs, entry.name)
      const childRel = relPath ? `${relPath}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        const sub = await walk(childAbs, entry.name, childRel)
        if (sub.lines > 0) children.push(sub)
        lines += sub.lines
        churnSum += sub.churn
      } else if (entry.isFile()) {
        if (!TEXT.has(extname(entry.name).toLowerCase())) continue
        const n = await countLines(childAbs)
        if (n === 0) continue
        files.set(childRel, n)
        const c = churn.get(childRel) ?? 0
        lines += n
        churnSum += c
        children.push({ name: entry.name, path: `${relPath ? `${relPath}/` : ''}${entry.name}`, type: 'file', lines: n, churn: c })
      }
    }
    children.sort((a, b) => b.lines - a.lines)
    return { name, path: relPath, type: 'dir', lines, churn: churnSum, children }
  }

  const rootNode = await walk(root, root.split(sep).filter(Boolean).pop() ?? 'root', '')
  return { root: rootNode, files }
}

/** 单个文件的行数，用于增量更新 */
export async function updateFile(files, root, relPath) {
  const abs = join(root, ...relPath.split('/'))
  const info = await stat(abs).catch(() => null)
  if (info === null || !info.isFile()) {
    files.delete(relPath)
    return 0
  }
  if (!TEXT.has(extname(relPath).toLowerCase())) {
    files.delete(relPath)
    return 0
  }
  const n = await countLines(abs)
  if (n === 0) files.delete(relPath)
  else files.set(relPath, n)
  return n
}

export const relOf = (root, abs) => relative(root, abs).split(sep).join('/')
