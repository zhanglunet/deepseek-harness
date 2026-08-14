/**
 * Build the plugin directory: every repository carrying the dsh-plugin topic,
 * described from its own README rather than from its one-line GitHub blurb.
 *
 * For each repository this extracts an intro paragraph, feature bullets, and a
 * usage excerpt, all quoted from the README. Nothing is inferred or written on
 * the project's behalf — a repository whose README says nothing useful is
 * listed with whatever it does say, and the page links to the source.
 *
 * Run from the repository root:
 *   node analysis-site/scripts/fetch-plugins.mjs
 *   DSH_PLUGIN_LIMIT=40 node analysis-site/scripts/fetch-plugins.mjs   # short run
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'

const OUT = 'analysis-site/data/plugins.json'
const TOPIC = process.env.DSH_TOPIC || 'dsh-plugin'
const UPSTREAM = 'deepseek-ai/deepseek-harness'
const API = 'https://api.github.com'
const PER_PAGE = 100
/** GitHub caps search result retrieval at 1000 items regardless of total_count. */
const SEARCH_CAP = 1000
const PROBE_CONCURRENCY = 8
const limit = Number(process.env.DSH_PLUGIN_LIMIT || 0)

const INTRO_MAX = 300
const USAGE_MAX = 400
const BULLET_MAX = 100
const BULLET_COUNT = 5
/** Bump when the extraction rules change, so cached descriptions are re-read. */
const DOC_VERSION = 4

const token = process.env.GITHUB_TOKEN ?? ''
const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': 'deepseek-harness-analysis-site',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
}

async function api(path, { allow404 = false } = {}) {
  const res = await fetch(`${API}${path}`, { headers })
  if (res.status === 404 && allow404) return null
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText}\n${body.slice(0, 200)}`)
  }
  return res.json()
}

/** Walk every search page up to the API's retrieval cap. */
async function allTopicRepos() {
  const out = []
  let total = 0
  for (let page = 1; page <= Math.ceil(SEARCH_CAP / PER_PAGE); page++) {
    const q = encodeURIComponent(`topic:${TOPIC}`)
    const res = await api(`/search/repositories?q=${q}&sort=stars&order=desc&per_page=${PER_PAGE}&page=${page}`)
    total = res.total_count
    out.push(...res.items)
    if (res.items.length < PER_PAGE || out.length >= Math.min(total, SEARCH_CAP)) break
    if (limit && out.length >= limit) break
  }
  return { total, items: limit ? out.slice(0, limit) : out }
}

const clip = (s, n) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s)

/** Reduce one markdown line to readable text: no badges, links, code fences, or tags. */
function plain(line) {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')          // images and badges
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')       // links keep their text
    .replace(/<[^>]+>/g, ' ')                      // inline HTML
    .replace(/[*_~`]+/g, '')                       // emphasis and code ticks
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/
const BULLET = /^\s{0,3}[-*+]\s+(.+)$/
const FENCE = /^\s*```/

const USAGE_WORDS = ['usage', 'how to use', 'getting started', 'quick start', 'quickstart',
  '使用', '用法', '快速开始', '快速上手', '开始使用', '怎么用', '如何使用']
const FEATURE_WORDS = ['feature', 'capabilit', 'what it does', 'highlights',
  '功能', '特性', '能力', '亮点']
const SKIP_WORDS = ['license', 'contributing', 'acknowledg', 'star history', 'sponsor',
  '许可', '协议', '贡献', '致谢', '赞助']

/** Share of CJK characters, used to tell an already-Chinese README from an English one. */
function cjkRatio(text) {
  if (!text) return 0
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  const letters = (text.match(/[A-Za-z]/g) || []).length
  return cjk + letters === 0 ? 0 : cjk / (cjk + letters)
}

/**
 * Length thresholds have to be language-aware: 24 English characters is half a
 * clause, while 24 Chinese characters is a whole paragraph. CJK-heavy text
 * therefore clears the same bar at half the character count.
 */
const minLen = (text, asciiMin) => (cjkRatio(text) > 0.3 ? Math.ceil(asciiMin / 2) : asciiMin)

const matches = (heading, words) => {
  const h = heading.toLowerCase()
  return words.some((w) => h.includes(w))
}

/** Language names that appear in the translation switcher many READMEs open with. */
const LANG_NAMES = ['english', '简体中文', '繁體中文', '繁体中文', '中文', '日本語', '한국어',
  'español', 'français', 'deutsch', 'português', 'русский', 'italiano', 'tiếng việt', 'العربية']

/**
 * A translation switcher ("English · 简体中文 · 日本語") is navigation, not prose.
 * The signature is that removing the language names and their separators leaves
 * almost nothing — a sentence that merely mentions two languages keeps its body.
 */
function isLanguageBar(text) {
  if (text.length > 120) return false
  let rest = text.toLowerCase()
  let found = 0
  for (const n of LANG_NAMES) {
    if (!rest.includes(n)) continue
    found++
    rest = rest.split(n).join(' ')
  }
  if (found < 2) return false
  return rest.replace(/[\s·|/•,\-–—()[\]{}:：、。.]+/g, '').length <= 8
}

/**
 * Split a README into sections keyed by heading, dropping fenced code so a
 * shell snippet cannot be mistaken for prose.
 */
function sections(markdown) {
  const out = []
  let current = { heading: '', lines: [] }
  let fenced = false
  for (const raw of markdown.split('\n')) {
    if (FENCE.test(raw)) { fenced = !fenced; continue }
    if (fenced) continue
    const h = raw.match(HEADING)
    if (h) {
      out.push(current)
      current = { heading: plain(h[1]), lines: [] }
      continue
    }
    current.lines.push(raw)
  }
  out.push(current)
  return out
}

/** Pull an intro, feature bullets, and a usage excerpt out of README markdown. */
function describe(markdown) {
  const secs = sections(markdown)

  let intro = ''
  for (const s of secs) {
    if (intro) break
    if (s.heading && matches(s.heading, SKIP_WORDS)) continue
    for (const line of s.lines) {
      const t = plain(line)
      // Skip badge rows, table rows, quotes, and stray bullets before the prose.
      if (!t || t.length < minLen(t, 24) || t.startsWith('|') || t.startsWith('>')) continue
      if (BULLET.test(line) || isLanguageBar(t)) continue
      intro = clip(t, INTRO_MAX)
      break
    }
  }

  const bullets = []
  for (const s of secs) {
    if (!s.heading || !matches(s.heading, FEATURE_WORDS)) continue
    for (const line of s.lines) {
      const m = line.match(BULLET)
      if (!m) continue
      const t = plain(m[1])
      if (t.length < minLen(t, 6)) continue
      bullets.push(clip(t, BULLET_MAX))
      if (bullets.length >= BULLET_COUNT) break
    }
    if (bullets.length) break
  }

  let usage = ''
  for (const s of secs) {
    if (!s.heading || !matches(s.heading, USAGE_WORDS)) continue
    const text = s.lines.map(plain).filter((t) => t && t.length >= minLen(t, 12) && !t.startsWith('|')).join(' ')
    if (text) { usage = clip(text, USAGE_MAX); break }
  }

  // A usage section that merely repeats the intro adds nothing to the card.
  if (usage && intro && (usage.startsWith(intro.replace(/…$/, '')) || intro.startsWith(usage.replace(/…$/, '')))) {
    usage = ''
  }

  return { intro, bullets, usage }
}

const ZH_README_PATHS = [
  'README.zh.md', 'README.zh-CN.md', 'README_zh.md', 'README_CN.md', 'README-zh.md',
  'README.zh_CN.md', 'README_zh-CN.md', 'README_zh_CN.md', 'README.cn.md', 'docs/README.zh.md',
]

const EMPTY_DOC = { intro: '', bullets: [], usage: '' }

/** Decode a contents-API file payload into text, or null when it cannot be read. */
function decode(file) {
  if (!file || !file.content) return null
  try {
    return Buffer.from(file.content, file.encoding).toString('utf8')
  } catch {
    // An undecodable README leaves the repository described by its blurb alone.
    return null
  }
}

/**
 * Describe a repository in both languages where possible.
 *
 * The default README is the primary source. When it is already Chinese, that
 * doubles as the Chinese description. Otherwise a translated README committed
 * by the author (README.zh.md and its common spellings) supplies Chinese in the
 * author's own words, which is always preferred over any machine rendering.
 */
async function probeReadme(fullName) {
  const main = decode(await api(`/repos/${fullName}/readme`, { allow404: true }).catch(() => null))
  if (!main) return { doc: EMPTY_DOC, zh: null, en: null, lang: 'none', zhSource: 'none' }

  const mainDoc = describe(main)
  const mainIsZh = cjkRatio(mainDoc.intro || main.slice(0, 2000)) > 0.2

  if (mainIsZh) return { doc: mainDoc, zh: mainDoc, en: null, lang: 'zh', zhSource: 'readme' }

  for (const path of ZH_README_PATHS) {
    const alt = decode(await api(`/repos/${fullName}/contents/${path}`, { allow404: true }).catch(() => null))
    if (!alt) continue
    const altDoc = describe(alt)
    if (!altDoc.intro || cjkRatio(altDoc.intro) < 0.2) continue
    return { doc: mainDoc, zh: altDoc, en: mainDoc, lang: 'en', zhSource: 'readme-zh' }
  }

  return { doc: mainDoc, zh: null, en: mainDoc, lang: 'en', zhSource: 'none' }
}

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || ''
const DEEPSEEK_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com') + '/chat/completions'
const TRANSLATE_MAX = Number(process.env.DSH_TRANSLATE_MAX || 400)
const TRANSLATE_CONCURRENCY = 4

/**
 * Translate an English description into Chinese, used only when the author
 * published no Chinese README. Returns null when no key is configured, so the
 * directory still builds — those entries stay English-only and say so.
 */
async function translate(doc) {
  if (!DEEPSEEK_KEY) return null
  const payload = JSON.stringify({
    intro: doc.intro || '',
    bullets: doc.bullets || [],
    usage: doc.usage || '',
  })
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({
      model: process.env.DSH_TRANSLATE_MODEL || 'deepseek-chat',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: '把 JSON 中的英文软件说明翻译成简体中文。保持 JSON 结构与键名不变，' +
            '数组长度不变。保留产品名、命令、代码标识符与专有名词的原文。只输出 JSON。',
        },
        { role: 'user', content: payload },
      ],
    }),
  })
  if (!res.ok) throw new Error(`translate -> ${res.status} ${res.statusText}`)
  const body = await res.json()
  const raw = body?.choices?.[0]?.message?.content
  if (!raw) return null
  const out = JSON.parse(raw)
  return {
    intro: typeof out.intro === 'string' ? out.intro : '',
    bullets: Array.isArray(out.bullets) ? out.bullets.filter((b) => typeof b === 'string') : [],
    usage: typeof out.usage === 'string' ? out.usage : '',
  }
}

/**
 * Ordered classification rules. First match wins, so the specific capabilities
 * come before the broad "it is an agent" catch-alls. Matching runs over the
 * repository name, its blurb, its topics, and its README intro.
 */
const RULES = [
  ['catalog', ['awesome', 'curated list', 'directory of', 'plugin list', 'hub', 'navigation', '导航', '索引', '合集']],
  ['vision', ['vision', 'ocr', 'image', 'screenshot', 'multimodal', 'diagram', '视觉', '图片', '截图', '识图']],
  ['voice', ['voice', 'speech', 'tts', 'asr', 'audio', 'whisper', '语音', '朗读', '配音']],
  ['browser', ['browser', 'chrome', 'puppeteer', 'playwright', 'crawl', 'scrap', '浏览器', '爬虫', '抓取']],
  ['search', ['search engine', 'web-search', 'websearch', 'retrieval', 'rag', 'wiki', '搜索', '检索']],
  ['memory', ['memory', 'knowledge base', 'note', 'obsidian', 'embedding', 'vector', '记忆', '知识库', '笔记']],
  ['model', ['provider', 'openai-compatible', 'gemini', 'claude', 'anthropic', 'ollama', 'router', 'llm-', '模型接入', '模型路由']],
  ['skill', ['skill', 'persona', 'character', 'roleplay', 'prompt pack', '技能', '人格', '角色', '提示词']],
  ['ui', ['theme', 'skin', 'ui', 'sidebar', 'tui', 'workbench', 'desktop', 'dashboard', 'render', 'style',
    '皮肤', '主题', '侧栏', '界面', '面板', '美化']],
  ['orchestration', ['workflow', 'orchestrat', 'subagent', 'multi-agent', 'agent-team', 'pipeline', 'scheduler',
    '工作流', '编排', '多智能体', '调度']],
  ['devtool', ['git', 'code review', 'lint', 'test', 'debug', 'refactor', 'ide', 'vscode', 'lsp', 'terminal',
    '代码', '调试', '重构', '测试']],
  ['integration', ['notification', 'notify', 'slack', 'discord', 'telegram', 'feishu', 'lark', 'dingtalk',
    'wechat', 'email', 'webhook', 'mcp', '通知', '飞书', '钉钉', '微信', '推送']],
  ['infra', ['sandbox', 'security', 'guardrail', 'permission', 'proxy', 'gateway', 'auth', 'observab', 'telemetry',
    '沙箱', '安全', '权限', '网关', '监控']],
  ['data', ['database', 'sql', 'excel', 'spreadsheet', 'csv', 'chart', 'analytics', 'report',
    '数据库', '表格', '报表', '数据分析']],
  ['app', ['agent', 'app', 'client', 'platform', ' os', '应用', '客户端']],
]

const CATEGORY_LABELS = {
  ui: 'UI / 界面美化',
  vision: '视觉 / 图像',
  voice: '语音',
  browser: '浏览器 / 抓取',
  search: '搜索 / 检索',
  memory: '记忆 / 知识库',
  model: '模型接入',
  skill: '技能 / 人格',
  orchestration: '编排 / 多 agent',
  devtool: '开发工具',
  integration: '通知 / 集成',
  infra: '基础设施 / 安全',
  data: '数据 / 报表',
  catalog: '目录 / 索引',
  app: '应用 / 产品',
  other: '其他',
}

/**
 * Keyword matchers. An ASCII keyword must begin at a word boundary, so a short
 * one cannot fire inside an unrelated word — "ide" must not match "deeptide",
 * nor "git" match "digit". The end is deliberately open so ordinary suffixes
 * still match: "sandbox" finds "sandboxes", "agent-team" finds "agent-teams".
 * CJK has no such boundaries, so those keywords match as substrings.
 */
const MATCHERS = new Map(
  RULES.flatMap(([, words]) => words).map((w) => {
    const ascii = /^[a-z0-9 \-]+$/.test(w)
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return [w, ascii ? new RegExp(`(^|[^a-z0-9])${escaped}`) : null]
  }),
)

const hits = (text, word) => {
  const re = MATCHERS.get(word)
  return re ? re.test(text) : text.includes(word)
}

/** Group a repository by what its own text says it does; first matching rule wins. */
function classify(repo, intro = '') {
  const topics = (repo.topics ?? []).map((t) => t.toLowerCase())
  const text = `${repo.name} ${repo.description ?? ''} ${intro}`.toLowerCase()
  for (const [key, words] of RULES) {
    if (words.some((w) => hits(text, w) || topics.includes(w.trim()))) return key
  }
  return 'other'
}

/** Run tasks with a fixed worker pool so a large probe does not open 700 sockets. */
async function pool(items, worker, size) {
  const out = new Array(items.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++
        out[i] = await worker(items[i], i)
      }
    }),
  )
  return out
}

async function main() {
  const { total, items } = await allTopicRepos()
  const repos = items.filter((r) => r.full_name !== UPSTREAM)
  console.log(`topic:${TOPIC} -> ${total} total, ${repos.length} fetched (upstream excluded)`)

  // Reuse a previous description when the repository has not been pushed since.
  const cache = new Map()
  if (existsSync(OUT)) {
    try {
      for (const p of JSON.parse(readFileSync(OUT, 'utf8')).plugins ?? []) {
        if (p.readFor) cache.set(p.name, { readFor: p.readFor, docVersion: p.docVersion,
          probe: { doc: p.doc, zh: p.zh, en: p.en, lang: p.lang, zhSource: p.zhSource } })
      }
    } catch {
      // A corrupt cache only costs re-reading; the fresh data still wins.
    }
  }

  let probed = 0
  const docs = await pool(
    repos,
    async (r) => {
      const hit = cache.get(r.full_name)
      if (hit && hit.readFor === r.pushed_at && hit.docVersion === DOC_VERSION && hit.probe) return hit.probe
      probed++
      return probeReadme(r.full_name).catch(() => ({ doc: EMPTY_DOC, zh: null, en: null, lang: 'none', zhSource: 'none' }))
    },
    PROBE_CONCURRENCY,
  )
  console.log(`read ${probed} READMEs (${repos.length - probed} reused from cache)`)

  // Fill the Chinese gap for English-only repositories, newest-and-most-starred
  // first, capped so a large ecosystem cannot run away with the token budget.
  const needTranslation = repos
    .map((r, i) => ({ r, i }))
    .filter(({ i }) => docs[i] && docs[i].lang === 'en' && !docs[i].zh && docs[i].doc.intro)
    .slice(0, TRANSLATE_MAX)

  let translated = 0
  if (DEEPSEEK_KEY && needTranslation.length) {
    await pool(
      needTranslation,
      async ({ i }) => {
        const zh = await translate(docs[i].doc).catch(() => null)
        if (zh && zh.intro) {
          docs[i] = { ...docs[i], zh, zhSource: 'machine' }
          translated++
        }
      },
      TRANSLATE_CONCURRENCY,
    )
  }
  console.log(
    DEEPSEEK_KEY
      ? `translated ${translated} of ${needTranslation.length} English-only entries`
      : `no DEEPSEEK_API_KEY: ${needTranslation.length} English-only entries stay untranslated`,
  )

  const plugins = repos.map((r, i) => {
    const probe = docs[i] ?? { doc: EMPTY_DOC, zh: null, en: null, lang: 'none', zhSource: 'none' }
    const doc = probe.doc
    return {
      name: r.full_name,
      owner: r.owner?.login ?? r.full_name.split('/')[0],
      url: r.html_url,
      blurb: (r.description ?? '').slice(0, 240),
      stars: r.stargazers_count,
      language: r.language,
      topics: (r.topics ?? []).slice(0, 8),
      license: r.license?.spdx_id ?? null,
      pushedAt: r.pushed_at,
      createdAt: r.created_at,
      category: classify(r, doc.intro),
      readFor: r.pushed_at,
      docVersion: DOC_VERSION,
      doc,
      zh: probe.zh,
      en: probe.en,
      lang: probe.lang,
      zhSource: probe.zhSource,
    }
  })

  const counts = {}
  for (const p of plugins) counts[p.category] = (counts[p.category] ?? 0) + 1

  const data = {
    generatedAt: new Date().toISOString(),
    topic: TOPIC,
    total,
    listed: plugins.length,
    truncated: total > SEARCH_CAP,
    categoryLabels: CATEGORY_LABELS,
    counts,
    described: plugins.filter((p) => p.doc.intro).length,
    withUsage: plugins.filter((p) => p.doc.usage).length,
    chinese: plugins.filter((p) => p.zh && p.zh.intro).length,
    chineseByAuthor: plugins.filter((p) => p.zhSource === 'readme' || p.zhSource === 'readme-zh').length,
    chineseMachine: plugins.filter((p) => p.zhSource === 'machine').length,
    plugins,
  }

  mkdirSync('analysis-site/data', { recursive: true })
  writeFileSync(OUT, JSON.stringify(data) + '\n')
  console.log(
    `wrote ${OUT}\n` +
      `  listed     ${data.listed} of ${data.total}\n` +
      `  described  ${data.described} have a README intro; ${data.withUsage} have a usage section\n` +
      `  chinese    ${data.chinese} (${data.chineseByAuthor} author-written, ${data.chineseMachine} machine)\n` +
      `  categories ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ')}`,
  )
}

/** Exported for tests; the module still runs its collection on import. */
export { describe, classify, plain, sections, isLanguageBar }

await main()
