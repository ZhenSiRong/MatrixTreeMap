// server.mjs —— 本地服务：扫描 + 文件监听 + SSE 推送 + 点击跳回 Zed。
//
//   node server.mjs <仓库目录> [端口]
//
// 为什么用 SSE 而不是 WebSocket：只需要服务端单向推，SSE 自带重连，浏览器端一行
// EventSource 就够，不用引依赖。
//
// 实时策略（对应"卡就想办法极致优化"）：
// - 初始全量扫描一次；
// - 之后只监听事件里的那个文件路径，**增量更新单文件行数**，不重扫整棵树；
// - churn 需要跑 git log，代价高，默认 5 分钟才刷新一次，且刷新失败就沿用旧值。

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { scanChurn, scanTree, updateFile } from './scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(process.argv[2] ?? process.cwd())
const PORT = Number(process.argv[3] ?? 4477)
const CHURN_TTL = 5 * 60 * 1000

let files = new Map()
let churn = new Map()
let churnAt = 0
const clients = new Set()

function treeFromFiles(filesMap, churnMap) {
  const root = { name: ROOT.split('/').filter(Boolean).pop() ?? 'root', path: '', type: 'dir', lines: 0, churn: 0, children: [] }
  const dirs = new Map([['', root]])

  const dirFor = (path) => {
    if (dirs.has(path)) return dirs.get(path)
    const idx = path.lastIndexOf('/')
    const parentPath = idx === -1 ? '' : path.slice(0, idx)
    const parent = dirFor(parentPath)
    const node = { name: path.slice(idx + 1), path, type: 'dir', lines: 0, churn: 0, children: [] }
    parent.children.push(node)
    dirs.set(path, node)
    return node
  }

  for (const [path, lines] of filesMap) {
    const idx = path.lastIndexOf('/')
    const parentPath = idx === -1 ? '' : path.slice(0, idx)
    const parent = dirFor(parentPath)
    const c = churnMap.get(path) ?? 0
    parent.children.push({ name: path.slice(idx + 1), path, type: 'file', lines, churn: c })
  }

  // 自底向上汇总
  const rollup = (node) => {
    if (node.type === 'file') return node
    let lines = 0
    let churnSum = 0
    for (const child of node.children) {
      rollup(child)
      lines += child.lines
      churnSum += child.churn
    }
    node.lines = lines
    node.churn = churnSum
    node.children.sort((a, b) => b.lines - a.lines)
    return node
  }
  rollup(root)
  return root
}

function snapshot() {
  return {
    root: ROOT,
    at: Date.now(),
    churnAt,
    tree: treeFromFiles(files, churn),
  }
}

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`
  for (const res of clients) res.write(payload)
}

async function refreshChurn() {
  if (Date.now() - churnAt < CHURN_TTL) return
  try {
    churn = await scanChurn(ROOT)
    churnAt = Date.now()
  } catch { /* 保留旧值 */ }
}

// ---------- 启动 ----------

const t0 = Date.now()
await refreshChurn()
const first = await scanTree(ROOT, { churn })
files = first.files
console.log(`[treemap] 扫描 ${files.size} 个文本文件，${Date.now() - t0}ms`)

// 增量监听：debounce 后只更新变化的路径
const pending = new Map()
let flushTimer
function schedule(absPath) {
  pending.set(absPath, true)
  clearTimeout(flushTimer)
  flushTimer = setTimeout(async () => {
    const batch = [...pending.keys()]
    pending.clear()
    let changed = 0
    for (const abs of batch) {
      const rel = abs.startsWith(`${ROOT}/`) ? abs.slice(ROOT.length + 1) : null
      if (rel === null) continue
      await updateFile(files, ROOT, rel)
      changed += 1
    }
    if (changed > 0) {
      await refreshChurn()
      broadcast()
    }
  }, 220)
}

try {
  watch(ROOT, { recursive: true }, (_event, filename) => {
    if (filename) schedule(join(ROOT, filename.toString()))
  })
  console.log('[treemap] 监听已启动（recursive）')
} catch (error) {
  console.log('[treemap] recursive 监听不可用，降级为不监听：', String(error))
}

// ---------- HTTP ----------

const openZed = async (path) => {
  const abs = join(ROOT, ...path.split('/'))
  // 先试 -a（加到当前窗口），失败再 -e（聚焦已有窗口），最后才 -n（新窗口）。
  for (const flag of ['-a', '-e', '-n']) {
    const ok = await new Promise((resolve) => {
      execFile('zed', [flag, abs], (error) => resolve(!error || error.code === 0))
    }).catch(() => false)
    if (ok) return
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

  if (url.pathname === '/') {
    const html = await readFile(join(HERE, 'public/index.html'))
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(html)
    return
  }

  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(snapshot()))
    return
  }

  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }

  if (url.pathname === '/api/open' && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try {
        const { path } = JSON.parse(body || '{}')
        if (typeof path === 'string' && path.length > 0) void openZed(path)
        res.writeHead(204).end()
      } catch {
        res.writeHead(400).end()
      }
    })
    return
  }

  res.writeHead(404).end()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[treemap] http://127.0.0.1:${PORT}  →  ${ROOT}`)
})
