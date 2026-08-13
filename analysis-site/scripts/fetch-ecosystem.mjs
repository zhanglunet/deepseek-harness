/**
 * Collect the public GitHub facts the analysis site reports about DeepSeek
 * Harness, and write them to analysis-site/data/ecosystem.json.
 *
 * Reads only public REST endpoints. GITHUB_TOKEN raises the rate limit
 * (5000/h core, 30/min search) but is not required; unauthenticated runs get
 * 60/h core and 10/min search, which this script stays well inside.
 *
 * Run from the repository root:  node analysis-site/scripts/fetch-ecosystem.mjs
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'

const OUT = 'analysis-site/data/ecosystem.json'
const UPSTREAM = 'deepseek-ai/deepseek-harness'
const TOPIC = 'dsh-plugin'
const API = 'https://api.github.com'

const token = process.env.GITHUB_TOKEN ?? ''
const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': 'deepseek-harness-analysis-site',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
}

/** Fetch one API path as JSON, failing loudly with the status and body. */
async function api(path) {
  const res = await fetch(`${API}${path}`, { headers })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText}\n${body.slice(0, 300)}`)
  }
  return res.json()
}

/** The fields the page renders for one repository row. */
const repoRow = (r) => ({
  name: r.full_name,
  url: r.html_url,
  stars: r.stargazers_count,
  language: r.language,
  description: (r.description ?? '').slice(0, 220),
  pushedAt: r.pushed_at,
  createdAt: r.created_at,
})

const firstLine = (s) => String(s ?? '').split('\n')[0].slice(0, 140)

async function main() {
  const repo = await api(`/repos/${UPSTREAM}`)

  const releases = await api(`/repos/${UPSTREAM}/releases?per_page=5`).catch(() => [])
  const tags = releases.length ? [] : await api(`/repos/${UPSTREAM}/tags?per_page=5`).catch(() => [])

  const commits = await api(`/repos/${UPSTREAM}/commits?per_page=8`).catch(() => [])

  const byStars = await api(
    `/search/repositories?q=${encodeURIComponent(`topic:${TOPIC}`)}&sort=stars&order=desc&per_page=20`,
  )
  const byUpdated = await api(
    `/search/repositories?q=${encodeURIComponent(`topic:${TOPIC}`)}&sort=updated&order=desc&per_page=20`,
  )

  // The upstream repository carries the topic too; it is not a community plugin.
  const notUpstream = (r) => r.full_name !== UPSTREAM

  const data = {
    generatedAt: new Date().toISOString(),
    upstream: {
      name: repo.full_name,
      url: repo.html_url,
      description: repo.description,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      openIssues: repo.open_issues_count,
      pushedAt: repo.pushed_at,
      license: repo.license?.spdx_id ?? null,
    },
    releases: releases.slice(0, 5).map((r) => ({
      tag: r.tag_name,
      name: r.name,
      publishedAt: r.published_at,
      url: r.html_url,
      prerelease: r.prerelease,
    })),
    tags: tags.slice(0, 5).map((t) => ({ name: t.name, url: `${repo.html_url}/releases/tag/${t.name}` })),
    commits: commits.slice(0, 8).map((c) => ({
      sha: c.sha.slice(0, 7),
      message: firstLine(c.commit?.message),
      date: c.commit?.author?.date ?? c.commit?.committer?.date ?? null,
      url: c.html_url,
    })),
    plugins: {
      topic: TOPIC,
      total: byStars.total_count,
      top: byStars.items.filter(notUpstream).slice(0, 12).map(repoRow),
      recentlyActive: byUpdated.items.filter(notUpstream).slice(0, 10).map(repoRow),
    },
  }

  mkdirSync('analysis-site/data', { recursive: true })

  // Keep the file byte-stable when only the timestamp would move, so the
  // scheduled job does not commit a no-op change every day.
  if (existsSync(OUT)) {
    const prev = JSON.parse(readFileSync(OUT, 'utf8'))
    const same = JSON.stringify({ ...prev, generatedAt: null }) === JSON.stringify({ ...data, generatedAt: null })
    if (same) {
      console.log('no change; leaving', OUT, 'untouched')
      return
    }
  }

  writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n')
  console.log(
    `wrote ${OUT}\n` +
      `  upstream  ${data.upstream.stars} stars / ${data.upstream.forks} forks, pushed ${data.upstream.pushedAt}\n` +
      `  releases  ${data.releases.length} (tags fallback: ${data.tags.length})\n` +
      `  commits   ${data.commits.length}\n` +
      `  plugins   ${data.plugins.total} tagged; ${data.plugins.top.length} top, ${data.plugins.recentlyActive.length} recent`,
  )
}

await main()
