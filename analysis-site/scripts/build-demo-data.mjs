import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const BASE = 'examples/headless-agent/tests/snapshots'
const OUT = 'analysis-site/demo-data'

const SCENARIOS = [
  {
    id: 'pty-tools',
    title: '持久终端',
    desc: '依次操作六个 PTY 工具，包含一次「会话不存在」的错误路径，最后回复 DONE。',
    teaches: '工具调用与结果如何成对落进日志；失败的工具调用同样是持久事件，不是被吞掉的异常。',
  },
  {
    id: 'advanced-toolchain',
    title: '自我修改 + 委派 + 编排',
    desc: '定义一个动态 Cordis 包、用 run_code 运行并检视、委派给子 agent、跑一个工作流、再把包撤回。',
    teaches: 'Code Mode 的嵌套调用（tool/code-dispatch）、子 agent 委派与 workflow 事件，全部在同一条事件流里。',
  },
  {
    id: 'compaction-recovery',
    title: '上下文压缩',
    desc: '触发一次压缩，然后验证被压缩掉的前提仍然成立。',
    teaches: '压缩不是删日志：compaction/summary 带 shadowedRange，遮蔽掉的 seq 仍在日志里，只是不再进入模型历史。',
  },
  {
    id: 'subagent-settlement',
    title: '子 agent 结算',
    desc: '委派一个后台子 agent，等它结算后把结果带回父会话。',
    teaches: '父子会话各有独立日志，子 agent 的结果以一条普通事件回到父会话。',
  },
  {
    id: 'ralph-loop',
    title: 'Ralph 循环',
    desc: '固定策略的迭代工作流：每轮开一个全新子 agent 继续同一个目标。',
    teaches: '长任务如何靠「每轮换新上下文」避免上下文腐烂。',
  },
]

/** Event types that carry no reader value in a transcript view. */
const SKIP = new Set(['agent/inbox/spliced'])

const textOf = (content) =>
  (content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')

function convert(scenario) {
  const lines = readFileSync(`${BASE}/${scenario.id}/stream-json.expected.jsonl`, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

  const events = []
  let pendingChunks = 0
  let prompt = null
  let final = null

  const flushChunks = () => {
    if (pendingChunks > 0) {
      events.push({ kind: 'chunks', n: pendingChunks })
      pendingChunks = 0
    }
  }

  for (const line of lines) {
    if (line.type === 'result') {
      final = line.output
      continue
    }
    if (line.type !== 'session_event') continue
    const ev = line.event
    if (SKIP.has(ev.type)) continue

    if (ev.type === 'assistant/chunk') {
      pendingChunks++
      continue
    }
    flushChunks()

    const d = ev.data ?? {}
    const base = { seq: ev.seq, type: ev.type, raw: JSON.stringify(ev, null, 2) }

    switch (ev.type) {
      case 'turn/start':
        events.push({ ...base, kind: 'turn-start', turn: d.turn })
        break
      case 'turn/end':
        events.push({ ...base, kind: 'turn-end', turn: d.turn, reason: d.reason?.kind })
        break
      case 'step/start':
        events.push({ ...base, kind: 'step-start', turn: d.turn, step: d.step })
        break
      case 'step/end':
        events.push({ ...base, kind: 'step-end', turn: d.turn, step: d.step })
        break
      case 'user/message': {
        const text = textOf(d.content)
        if (prompt === null) prompt = text
        events.push({ ...base, kind: 'user', text, source: d.source?.kind })
        break
      }
      case 'assistant/message': {
        const blocks = d.message?.content ?? []
        const text = textOf(blocks)
        const calls = blocks
          .filter((b) => b.type === 'tool-call')
          .map((b) => ({ name: b.name, args: b.arguments }))
        events.push({ ...base, kind: 'assistant', text, calls })
        break
      }
      case 'tool/call':
        events.push({ ...base, kind: 'tool-call', name: d.name, args: d.arguments })
        break
      case 'tool/result': {
        const block = (d.message?.content ?? []).find((b) => b.type === 'tool-result')
        events.push({
          ...base,
          kind: 'tool-result',
          text: textOf(block?.content),
          isError: block?.isError === true,
        })
        break
      }
      case 'request/header':
        events.push({
          ...base,
          kind: 'header',
          provider: d.header?.config?.provider,
          model: d.header?.config?.model,
          reason: d.reason,
        })
        break
      case 'compaction/summary':
        events.push({
          ...base,
          kind: 'compaction',
          summary: textOf(d.summary),
          shadowed: d.shadowedSeqs ?? [],
          shadowedTokens: d.shadowedTokenCount,
        })
        break
      default:
        events.push({ ...base, kind: 'other' })
    }
  }
  flushChunks()

  return { ...scenario, prompt, final, events }
}

mkdirSync(OUT, { recursive: true })
const index = []
for (const s of SCENARIOS) {
  const data = convert(s)
  const path = `${OUT}/${s.id}.json`
  writeFileSync(path, JSON.stringify(data))
  const counts = data.events.reduce((a, e) => ((a[e.kind] = (a[e.kind] ?? 0) + 1), a), {})
  index.push({ id: s.id, title: s.title, desc: s.desc, teaches: s.teaches, steps: data.events.length })
  console.log(
    `${s.id.padEnd(22)} ${String(data.events.length).padStart(3)} steps  ` +
      `${String(Buffer.byteLength(JSON.stringify(data))).padStart(6)}B  ` +
      Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' '),
  )
}
writeFileSync(`${OUT}/index.json`, JSON.stringify(index))
console.log('\nindex.json written with', index.length, 'scenarios')
