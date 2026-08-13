/**
 * Build the plugin directory: every repository carrying the dsh-plugin topic,
 * enriched with whatever its package.json actually declares.
 *
 * Install commands are only emitted when the repository's own manifest proves
 * one — a `dsh.bundle` declaration makes it a profile bundle, and the npm
 * `name` is what `dsh plugin add` takes. Everything else is reported as
 * unknown and linked to its README rather than guessed at, because a wrong
 * install command is worse than none.
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

/**
 * Read a repository's package.json and decide what, if anything, can be
 * installed from it. Absent or unparsable manifests yield kind 'unknown'.
 */
async function probeManifest(fullName) {
  const file = await api(`/repos/${fullName}/contents/package.json`, { allow404: true }).catch(() => null)
  if (!file || !file.content) return { kind: 'unknown' }
  let pkg
  try {
    pkg = JSON.parse(Buffer.from(file.content, file.encoding).toString('utf8'))
  } catch {
    // A package.json that does not parse tells us nothing installable.
    return { kind: 'unknown' }
  }
  const dsh = pkg.dsh ?? {}
  const isBundle = Boolean(dsh.bundle)
  const isProfile = Boolean(dsh.profile)
  const npmName = typeof pkg.name === 'string' && !pkg.private ? pkg.name : null
  return {
    kind: isBundle ? 'bundle' : isProfile ? 'profile' : npmName ? 'package' : 'unknown',
    npmName,
    isBundle,
    isProfile,
    private: Boolean(pkg.private),
    pkgDescription: typeof pkg.description === 'string' ? pkg.description.slice(0, 200) : null,
  }
}

/** Group a repository by what its topics and description say it does. */
function classify(repo) {
  const topics = (repo.topics ?? []).map((t) => t.toLowerCase())
  const text = `${repo.name} ${repo.description ?? ''}`.toLowerCase()
  const has = (...words) => words.some((w) => text.includes(w) || topics.includes(w))

  if (has('awesome', 'curated', 'directory', 'index', 'hub')) return 'catalog'
  if (has('skill', 'persona', 'character', 'roleplay')) return 'skill'
  if (has('theme', 'skin', 'ui', 'sidebar', 'tui', 'terminal-ui', 'workbench', 'desktop')) return 'ui'
  if (has('vision', 'image', 'ocr', 'browser', 'search', 'memory', 'voice', 'speech')) return 'capability'
  if (has('workflow', 'agent-team', 'orchestrat', 'subagent', 'multi-agent')) return 'orchestration'
  if (has('sandbox', 'security', 'guardrail', 'permission', 'proxy', 'gateway')) return 'infra'
  // 'desktop' belongs to the ui rule above; a desktop workbench is a UI, not a product.
  if (has('agent', 'app', 'client', 'os')) return 'app'
  return 'other'
}

const CATEGORY_LABELS = {
  ui: 'UI / 工作台',
  capability: '能力扩展',
  orchestration: '编排 / 多 agent',
  skill: '技能 / 人格',
  infra: '基础设施 / 安全',
  catalog: '目录 / 索引',
  app: '应用 / 产品',
  other: '其他',
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

  // Reuse a previous probe when the repository has not been pushed since.
  const cache = new Map()
  if (existsSync(OUT)) {
    try {
      for (const p of JSON.parse(readFileSync(OUT, 'utf8')).plugins ?? []) {
        if (p.manifestFor) cache.set(p.name, { manifestFor: p.manifestFor, manifest: p.manifest })
      }
    } catch {
      // A corrupt cache only costs re-probing; the fresh data still wins.
    }
  }

  let probed = 0
  const manifests = await pool(
    repos,
    async (r) => {
      const hit = cache.get(r.full_name)
      if (hit && hit.manifestFor === r.pushed_at) return hit.manifest
      probed++
      return probeManifest(r.full_name).catch(() => ({ kind: 'unknown' }))
    },
    PROBE_CONCURRENCY,
  )
  console.log(`probed ${probed} manifests (${repos.length - probed} reused from cache)`)

  const plugins = repos.map((r, i) => {
    const m = manifests[i] ?? { kind: 'unknown' }
    return {
      name: r.full_name,
      owner: r.owner?.login ?? r.full_name.split('/')[0],
      url: r.html_url,
      description: (r.description ?? m.pkgDescription ?? '').slice(0, 240),
      stars: r.stargazers_count,
      language: r.language,
      topics: (r.topics ?? []).slice(0, 8),
      license: r.license?.spdx_id ?? null,
      pushedAt: r.pushed_at,
      createdAt: r.created_at,
      category: classify(r),
      kind: m.kind,
      npmName: m.npmName ?? null,
      isBundle: Boolean(m.isBundle),
      manifestFor: r.pushed_at,
      manifest: m,
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
    installable: plugins.filter((p) => p.isBundle && p.npmName).length,
    plugins,
  }

  mkdirSync('analysis-site/data', { recursive: true })
  writeFileSync(OUT, JSON.stringify(data) + '\n')
  console.log(
    `wrote ${OUT}\n` +
      `  listed      ${data.listed} of ${data.total}\n` +
      `  installable ${data.installable} declare a dsh bundle with an npm name\n` +
      `  categories  ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ')}`,
  )
}

await main()
