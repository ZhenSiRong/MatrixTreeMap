#!/usr/bin/env node
/**
 * record.mjs —— 用 CDP 驱动真实 Chrome，把「人的操作」录成帧，再交给 assemble.sh 拼成 GIF/MP4。
 *
 * 为什么自己写而不用录屏软件：我们要的帧是**确定性的**——每一帧对应一次真实的
 * 鼠标按下/移动/抬起、滚轮、键盘输入，停顿时长可控。录屏 + 剪辑拿不到这种精度，
 * 而且改一个交互就要重剪一遍。
 *
 * 用法：
 *   node tools/record.mjs <scenario> [--out /tmp/frames] [--port 9228]
 *
 * 场景在 SCENARIOS 里，每个场景是一串步骤：等待、移动、按下、抬起、滚轮、截图（带字幕）。
 * 截图节点写成 { shot: 'name', caption: '① 说明', hold: 1200 }，hold 是这一帧停留的毫秒。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const scenarioName = args[0]
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const OUT = flag('out', '/tmp/gifrec')
const PORT = Number(flag('port', '9228'))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ---------- CDP ----------

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = targets.find(t => t.type === 'page')
  if (!page) throw new Error('没有可用的 page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  })
  await new Promise(r => ws.addEventListener('open', r, { once: true }))
  const send = (method, params = {}) => new Promise((resolve) => {
    const n = ++id
    pending.set(n, resolve)
    ws.send(JSON.stringify({ id: n, method, params }))
  })
  return { send, close: () => ws.close() }
}

// ---------- 场景 ----------

const SCENARIOS = {
  /** 旅程一：折叠 → 下钻 → 面包屑回退 */
  'navigate': {
    url: 'http://127.0.0.1:4477/',
    viewport: { width: 1280, height: 800 },
    steps: [
      { wait: 2600 },
      { shot: '01-open', caption: '① 打开：面积 = 行数，颜色 = churn 密度', hold: 1800 },
      { move: [640, 300] },
      { wait: 500 },
      { shot: '02-hover', caption: '② 悬停：路径 / 行数 / churn 直接给出', hold: 1600 },
      { click: [640, 300] },
      { wait: 600 },
      { shot: '03-fold', caption: '③ 单击目录：折叠成一块，×倍率标出被压掉多少', hold: 1800 },
      { click: [640, 300] },
      { wait: 500 },
      { dblclick: [430, 300] },
      { wait: 800 },
      { shot: '04-drill', caption: '④ 双击下钻：层级块出现在左上角', hold: 1800 },
      { click: [60, 78] },
      { wait: 700 },
      { shot: '05-back', caption: '⑤ 点面包屑「根目录」：回到上一层', hold: 1600 },
    ],
  },

  /** 旅程二：滚轮缩放 + 拖动平移（手感） */
  'zoom-pan': {
    url: 'http://127.0.0.1:4477/#design',
    viewport: { width: 1280, height: 800 },
    steps: [
      { wait: 2600 },
      { shot: '01-fit', caption: '① 初始：整块铺满，标签在头部栏里', hold: 1600 },
      { wheel: [700, 420, -320] },
      { wait: 260 },
      { shot: '02-zoom', caption: '② 滚轮缩放：以光标为中心放大，即时重绘', hold: 1600 },
      { wheel: [700, 420, -320] },
      { wait: 260 },
      { shot: '03-zoom2', caption: '③ 连续缩放：格子变大，小文件才开始可读', hold: 1500 },
      { drag: [[700, 420], [520, 300]] },
      { wait: 300 },
      { shot: '04-pan', caption: '④ 按住拖动平移（位移超过 5px 不触发打开）', hold: 1600 },
      { wheel: [640, 400, 700] },
      { wait: 300 },
      { shot: '05-out', caption: '⑤ 反向滚回：这一步以前要点一下才生效', hold: 1500 },
    ],
  },

  /** 旅程四：悬停看数据 */
  'hover': {
    url: 'http://127.0.0.1:4477/',
    viewport: { width: 1280, height: 800 },
    steps: [
      { wait: 2600 },
      { shot: '01-idle', caption: '① 初始：每个块是一个目录或文件', hold: 1600 },
      { move: [1050, 200] },
      { wait: 450 },
      { shot: '02-hover-a', caption: '② 悬停小文件：路径 + 行数 + churn', hold: 1700 },
      { move: [980, 520] },
      { wait: 450 },
      { shot: '03-hover-b', caption: '③ 换个块，数据跟着换', hold: 1700 },
      { move: [420, 260] },
      { wait: 900 },
      { shot: '04-hover-big', caption: '④ 悬停大目录：会标出「已折叠」与阈值', hold: 1800 },
    ],
  },

  /** 旅程五：折叠 / 展开 */
  'expand-collapse': {
    url: 'http://127.0.0.1:4477/#design',
    viewport: { width: 1280, height: 800 },
    steps: [
      { wait: 2600 },
      { shot: '01-before', caption: '① 展开态：大目录内部铺开成子块', hold: 1600 },
      { click: [430, 320] },
      { wait: 600 },
      { shot: '02-folded', caption: '② 单击折叠成一块，×倍率标出被压掉多少', hold: 1800 },
      { click: [430, 320] },
      { wait: 600 },
      { shot: '03-expanded', caption: '③ 再点还原：内部结构回来', hold: 1800 },
      { click: [430, 320] },
      { wait: 1500 },
      { shot: '04-folded-again', caption: '④ 折叠态稳定：面积不变，内部收起', hold: 1600 },
    ],
  },

  /** 旅程六：面包屑逐级回退 */
  'breadcrumb': {
    url: 'http://127.0.0.1:4477/',
    viewport: { width: 1280, height: 800 },
    steps: [
      { wait: 2600 },
      { dblclick: [430, 320] },
      { wait: 800 },
      { shot: '01-level1', caption: '① 双击下钻：面包屑出现第一级', hold: 1700 },
      { dblclick: [300, 300] },
      { wait: 800 },
      { shot: '02-level2', caption: '② 再下钻一层：面包屑变成三段', hold: 1700 },
      { click: [95, 78] },
      { wait: 700 },
      { shot: '03-back1', caption: '③ 点中间那段：回到上一级，不是直接回根', hold: 1700 },
      { click: [45, 78] },
      { wait: 700 },
      { shot: '04-back-root', caption: '④ 点「根目录」：整棵树回来', hold: 1600 },
    ],
  },

  /** 旅程三：窄屏 ⚙ 弹层 */
  'narrow': {
    url: 'http://127.0.0.1:4477/#design',
    viewport: { width: 480, height: 900, mobile: false },
    steps: [
      { wait: 2600 },
      { shot: '01-narrow', caption: '① 窄屏：工具栏收成一行，参数隐藏', hold: 1600 },
      { click: [143, 35] },
      { wait: 450 },
      { shot: '02-gear', caption: '② 点 ⚙：折叠阈值与面积上限弹出来', hold: 1800 },
      { click: [300, 700] },
      { wait: 450 },
      { shot: '03-close', caption: '③ 点空白处关闭，画布继续可交互', hold: 1500 },
    ],
  },
}

// ---------- 执行 ----------

const scenario = SCENARIOS[scenarioName]
if (!scenario) {
  console.error(`未知场景：${scenarioName}\n可用：${Object.keys(SCENARIOS).join(', ')}`)
  process.exit(2)
}

mkdirSync(OUT, { recursive: true })
const { send, close } = await connect()
const frames = []

await send('Emulation.setDeviceMetricsOverride', {
  width: scenario.viewport.width,
  height: scenario.viewport.height,
  deviceScaleFactor: 1,
  mobile: scenario.viewport.mobile === true,
})
await send('Page.navigate', { url: scenario.url })
await sleep(1200)
// 改过 viewport 之后主动触发一次 resize：让页面按新尺寸重置 canvas 位图并重绘
await send('Runtime.evaluate', { expression: 'window.dispatchEvent(new Event("resize"))' })
await sleep(400)

const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', clickCount: 1, ...extra,
})

for (const step of scenario.steps) {
  if (step.wait) { await sleep(step.wait); continue }
  if (step.move) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: step.move[0], y: step.move[1], button: 'none' }); continue }
  if (step.click) { await mouse('mousePressed', step.click[0], step.click[1]); await sleep(45); await mouse('mouseReleased', step.click[0], step.click[1]); continue }
  if (step.dblclick) {
    await mouse('mousePressed', step.dblclick[0], step.dblclick[1]);
    await mouse('mouseReleased', step.dblclick[0], step.dblclick[1]);
    await sleep(60)
    await mouse('mousePressed', step.dblclick[0], step.dblclick[1], { clickCount: 2 });
    await mouse('mouseReleased', step.dblclick[0], step.dblclick[1], { clickCount: 2 });
    continue
  }
  if (step.wheel) {
    const [x, y, dy] = step.wheel
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, button: 'none', clickCount: 0 })
    continue
  }
  if (step.drag) {
    const [[x1, y1], [x2, y2]] = step.drag
    await mouse('mousePressed', x1, y1)
    for (let i = 1; i <= 10; i += 1) {
      await mouse('mouseMoved', x1 + ((x2 - x1) * i) / 10, y1 + ((y2 - y1) * i) / 10, { buttons: 1 })
      await sleep(22)
    }
    await mouse('mouseReleased', x2, y2)
    continue
  }
  if (step.shot) {
    const png = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = join(OUT, `${step.shot}.png`)
    writeFileSync(file, Buffer.from(png.result.data, 'base64'))
    frames.push({ file, caption: step.caption ?? '', hold: step.hold ?? 1400 })
    continue
  }
}

writeFileSync(join(OUT, 'frames.json'), JSON.stringify(frames, null, 2))
console.log(`场景 ${scenarioName}：${frames.length} 帧 → ${OUT}`)
close()
