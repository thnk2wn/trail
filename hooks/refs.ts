import type { TrailKind, TrailRef, TrailRole } from '../types'

export type TrailConfig = {
  /** The Atlassian MCP server's name as /mcp lists it; used only when permission rules allow its search. */
  atlassianServer: string
  jiraBaseUrl: string
  /** TeamCity server that build ids link to. */
  teamcityUrl: string
  jiraProjects: readonly string[]
  githubOrg: string
  incidentOrg: string
}

/** A ref spotted in some text, before it is merged into the session's list. */
export type Found = {
  id: string
  kind: TrailKind
  label: string
  href: string
  role: TrailRole
  title?: string
}

export const ROLE_RANK: Record<TrailRole, number> = { created: 0, updated: 1, mentioned: 2 }

export const KIND_ORDER: readonly TrailKind[] = ['jira', 'pr', 'inc', 'run', 'build', 'doc']

export const KIND_TITLE: Record<TrailKind, string> = {
  build: 'TeamCity builds',
  doc: 'Docs',
  inc: 'Incidents',
  jira: 'Jira',
  pr: 'Pull requests',
  run: 'GitHub Actions',
}

const PR_URL = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g
const API_PR = /repos\/([\w.-]+)\/([\w.-]+)\/(?:pulls|issues)\/(\d+)/g
const INC = /\bINC-(\d{1,6})\b/g
const GH_RUN = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/(\d+)/g
const TEAMCITY = /https?:\/\/([\w.-]+)\/buildConfiguration\/(\w+)\/(\d+)/g
const TEAMCITY_VIEWLOG = /https?:\/\/([\w.-]+)\/viewLog\.html\?buildId=(\d+)/g
// The teamcity CLI prints this short form for a queued run (`URL: https://tc.example.com/build/110433`).
const TEAMCITY_SHORT = /https?:\/\/([\w.-]*teamcity[\w.-]*|tc\.[\w.-]+)\/build\/(\d+)\b/g

/** A TeamCity build by id; one id per build whichever way it was spelled (URL, CLI, REST path). */
export function buildRef(cfg: TrailConfig, id: string, role: TrailRole, config?: string, href?: string): Found {
  return {
    href: href ?? `${trimSlash(cfg.teamcityUrl)}/viewLog.html?buildId=${id}`,
    id: `build:tc/${id}`,
    kind: 'build',
    label: config ? `${config} #${id}` : `build ${id}`,
    role,
  }
}
const CONFLUENCE = /https?:\/\/([\w-]+)\.atlassian\.net\/wiki\/spaces\/(\w+)\/pages\/(\d+)(?:\/([^\s)"'\]<>\\|`]+))?/g
const ARTIFACT = /https:\/\/claude\.ai\/(?:code\/)?artifact\/([\w-]+)/g

export function parseProjects(raw: string): string[] {
  return raw
    .split(',')
    .map(one => one.trim().toUpperCase())
    .filter(one => /^[A-Z][A-Z0-9]{1,9}$/.test(one))
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

export function prRef(cfg: TrailConfig, owner: string, repo: string, n: string, role: TrailRole): Found {
  const isOrg = owner.toLowerCase() === cfg.githubOrg.toLowerCase()

  return {
    href: `https://github.com/${owner}/${repo}/pull/${n}`,
    id: `pr:${owner.toLowerCase()}/${repo.toLowerCase()}#${n}`,
    kind: 'pr',
    label: isOrg ? `${repo} #${n}` : `${owner}/${repo} #${n}`,
    role,
  }
}

export function jiraRef(cfg: TrailConfig, key: string, role: TrailRole): Found {
  return {
    href: `${trimSlash(cfg.jiraBaseUrl)}/browse/${key}`,
    id: `jira:${key}`,
    kind: 'jira',
    label: key,
    role,
  }
}

function titleFromSlug(slug: string | undefined): string | undefined {
  if (slug === undefined) {
    return undefined
  }

  let text = slug.replace(/\+/g, ' ')

  try {
    text = decodeURIComponent(text)
  } catch {
    // Keep the raw slug when it is not valid percent-encoding.
  }

  text = text.trim()

  return text.length > 48 ? `${text.slice(0, 47)}…` : text
}

/** Every ref spelled in `text`, each once, all with the same role. */
export function findRefs(text: string, cfg: TrailConfig, role: TrailRole = 'mentioned'): Found[] {
  const out = new Map<string, Found>()
  const add = (one: Found) => {
    if (!out.has(one.id)) {
      out.set(one.id, one)
    }
  }

  for (const m of text.matchAll(PR_URL)) {
    add(prRef(cfg, (m[1] ?? ''), (m[2] ?? ''), (m[3] ?? ''), role))
  }

  // Keys need a site to link to; until one is set or detected, Jira stays off.
  if (cfg.jiraProjects.length > 0 && cfg.jiraBaseUrl !== '') {
    const jira = new RegExp(`(?<![A-Za-z0-9])(${cfg.jiraProjects.join('|')})-(\\d{1,6})(?![0-9])`, 'g')

    for (const m of text.matchAll(jira)) {
      add(jiraRef(cfg, `${(m[1] ?? '')}-${(m[2] ?? '')}`, role))
    }
  }

  if (cfg.incidentOrg !== '') {
    for (const m of text.matchAll(INC)) {
      add({
        href: `https://app.incident.io/${cfg.incidentOrg}/incidents/${(m[1] ?? '')}`,
        id: `inc:${(m[1] ?? '')}`,
        kind: 'inc',
        label: `INC-${(m[1] ?? '')}`,
        role,
      })
    }
  }

  for (const m of text.matchAll(TEAMCITY)) {
    add(buildRef(cfg, m[3] ?? '', role, m[2] ?? '', `https://${m[1] ?? ''}/buildConfiguration/${m[2] ?? ''}/${m[3] ?? ''}`))
  }

  for (const m of text.matchAll(TEAMCITY_VIEWLOG)) {
    add(buildRef(cfg, m[2] ?? '', role, undefined, m[0]))
  }

  for (const m of text.matchAll(TEAMCITY_SHORT)) {
    add(buildRef(cfg, m[2] ?? '', role, undefined, m[0]))
  }

  for (const m of text.matchAll(GH_RUN)) {
    add(ghRunRef(cfg, m[1] ?? '', m[2] ?? '', m[3] ?? '', role))
  }

  for (const m of text.matchAll(CONFLUENCE)) {
    // A link ending a sentence carries its full stop (`…/Incident.io+Response.`).
    const slug = m[4]?.replace(/[.,;:!?]+$/, '') || undefined
    const title = titleFromSlug(slug)

    add({
      href: `https://${(m[1] ?? '')}.atlassian.net/wiki/spaces/${(m[2] ?? '')}/pages/${(m[3] ?? '')}${slug ? `/${slug}` : ''}`,
      id: `doc:confluence:${(m[3] ?? '')}`,
      kind: 'doc',
      label: title ?? `${(m[2] ?? '')} page ${(m[3] ?? '')}`,
      role,
    })
  }

  for (const m of text.matchAll(ARTIFACT)) {
    add({
      href: (m[0] ?? ''),
      id: `doc:artifact:${(m[1] ?? '')}`,
      kind: 'doc',
      label: `Artifact ${(m[1] ?? '').slice(0, 8)}`,
      role,
    })
  }

  return [...out.values()]
}

/** A GitHub Actions run (its own section: lint, tests, reviews and deploys, not only builds), however it was named (URL, `gh run`, `gh api …/actions/runs/<id>`). */
export function ghRunRef(cfg: TrailConfig, owner: string, repo: string, id: string, role: TrailRole): Found {
  const isOrg = owner.toLowerCase() === cfg.githubOrg.toLowerCase()

  return {
    href: `https://github.com/${owner}/${repo}/actions/runs/${id}`,
    id: `run:gh/${owner.toLowerCase()}/${repo.toLowerCase()}/${id}`,
    kind: 'run',
    label: `${isOrg ? '' : `${owner}/`}${repo} run ${id}`,
    role,
  }
}

const GH_RUN_CMD = /\bgh\s+run\s+(view|watch|rerun|cancel)\b([^\n;&|]*)/g
const API_RUN = /repos\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/(\d+)/g

const GH_PR = /\bgh\s+pr\s+(create|merge|edit|comment|review|ready|close|reopen|view|checks|diff)\b([^\n;&|]*)/g
const GH_PR_WRITES = new Set(['merge', 'edit', 'comment', 'review', 'ready', 'close', 'reopen'])

/** `R=owner/repo; gh pr ready 1 -R $R`: shell variables the command sets, so `$R` / `${R}` can be read. */
export function expandShellVars(command: string, text: string): string {
  const vars = new Map<string, string>()

  for (const m of command.matchAll(/(?:^|[;&|\s])([A-Za-z_]\w*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/g)) {
    vars.set(m[1] ?? '', m[2] ?? m[3] ?? m[4] ?? '')
  }

  return text.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (whole, name: string) => vars.get(name) ?? whole)
}

function repoFor(command: string, args: string, cfg: TrailConfig, repoHint: string | null): [string, string] | null {
  const repoArg = /(?:--repo|-R)[=\s]+(\S+)/.exec(expandShellVars(command, args))?.[1]

  if (repoArg !== undefined) {
    const flag = /^["']?(?:https?:\/\/github\.com\/)?([\w.-]+)(?:\/([\w.-]+))?["']?$/.exec(repoArg)

    // A repo flag we can't read (an unset variable, a substitution) is skipped, never guessed.
    if (!flag) {
      return null
    }

    return (flag[2] ?? '') ? [(flag[1] ?? ''), (flag[2] ?? '')] : [cfg.githubOrg, (flag[1] ?? '')]
  }

  const cd = /(?:^|&&|;)\s*cd\s+["']?([^\s"'&;]+)/.exec(command)

  if (cd) {
    const base = (cd[1] ?? '').replace(/\/+$/, '').split('/').pop()

    if (base && base !== '..' && base !== '.' && base !== '~') {
      return [cfg.githubOrg, base]
    }
  }

  if (repoHint) {
    const [owner, repo] = repoHint.split('/')

    if (owner && repo) {
      return [owner, repo]
    }
  }

  return null
}

/**
 * Refs from one Bash call: `gh pr` verbs are the strong signal (a create's
 * URL is read from the output), anything else the command spells is a mention.
 * Output is otherwise ignored: listings and logs would flood the trail.
 */
export function bashRefs(command: string, output: string, cfg: TrailConfig, repoHint: string | null): Found[] {
  const found: Found[] = []

  command = stripHeredocs(command)

  for (const m of command.matchAll(GH_PR)) {
    const verb = (m[1] ?? '')
    const args = (m[2] ?? '')

    if (verb === 'create') {
      const title = /(?:--title|-t)[=\s]+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(args)
      const named = title ? (title[1] ?? title[2]) : undefined

      found.push(...findRefs(output, cfg, 'created').filter(one => one.kind === 'pr').map(one => ({ ...one, title: named })))
      continue
    }

    const role: TrailRole = GH_PR_WRITES.has(verb) ? 'updated' : 'mentioned'
    const url = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(args)

    if (url) {
      found.push(prRef(cfg, (url[1] ?? ''), (url[2] ?? ''), (url[3] ?? ''), role))
      continue
    }

    const num = /(?:^|\s)#?(\d{1,6})(?=\s|$)/.exec(args)
    const repo = num ? repoFor(command, args, cfg, repoHint) : null

    if (num && repo) {
      found.push(prRef(cfg, repo[0], repo[1], (num[1] ?? ''), role))
    }
  }

  found.push(...teamcityRefs(command, output, cfg))

  // `gh run list` is ignored, as `teamcity run list` is: it lists everything.
  // Ids fed through a loop (`for id in 1 2; do gh run watch $id`) count, as they do for teamcity.
  for (const m of command.matchAll(GH_RUN_CMD)) {
    const args = m[2] ?? ''
    const id = buildIdArg(args)
    const ids = id ? [id] : /^[^"']*\$\w/.test(args) ? shellLoopIds(command) : []
    const repo = ids.length > 0 ? repoFor(command, args, cfg, repoHint) : null

    for (const each of repo ? ids : []) {
      found.push(ghRunRef(cfg, (repo as [string, string])[0], (repo as [string, string])[1], each, m[1] === 'rerun' || m[1] === 'cancel' ? 'updated' : 'mentioned'))
    }
  }

  const isApiWrite = /\s-X\s*(POST|PATCH|PUT|DELETE)\b|--method\s+(POST|PATCH|PUT|DELETE)\b/.test(command)

  for (const m of command.matchAll(API_RUN)) {
    found.push(ghRunRef(cfg, m[1] ?? '', m[2] ?? '', m[3] ?? '', isApiWrite ? 'updated' : 'mentioned'))
  }

  for (const m of command.matchAll(API_PR)) {
    const isWrite = /\s-X\s*(POST|PATCH|PUT)\b|--method\s+(POST|PATCH|PUT)\b|\s(-f|-F|--input)\s/.test(command)

    found.push(prRef(cfg, (m[1] ?? ''), (m[2] ?? ''), (m[3] ?? ''), isWrite ? 'updated' : 'mentioned'))
  }

  // Anything else a command spells is a mention, unless its number is a stand-in
  // (`attach.sh INC-1 https://x`, `…/pull/999`): trying a script out, not naming work.
  found.push(...findRefs(command, cfg).filter(one => !isPlaceholder(one)))

  return found
}

/** Numbers that stand in for a real one in examples and trial runs: 0, 1, 12, 123…, 42, 99, 999…. */
const PLACEHOLDER_NUMBER = /^(?:0|1|12|123|1234|12345|123456|42|9{2,6})$/

/** A PR, incident or Jira key whose number is a stand-in. */
export function isPlaceholder(one: Found): boolean {
  if (one.kind !== 'pr' && one.kind !== 'inc' && one.kind !== 'jira') {
    return false
  }

  return PLACEHOLDER_NUMBER.test(/(\d+)$/.exec(one.id)?.[1] ?? '')
}

/** Heredoc bodies are file contents (scripts, fixtures, tests), not references the session made. */
export function stripHeredocs(command: string): string {
  return command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g, '<<heredoc')
}

/** Tools whose input is file content: scanning it would list every key a test or doc happens to spell. */
const CONTENT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read'])

const JIRA_TITLE = /"key"\s*:\s*"([A-Z][A-Z0-9]+-\d+)"\s*,\s*"fields"\s*:\s*\{\s*"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/g

/** `key → summary` pairs from a Jira API or MCP response (search, get, create). */
export function parseJiraTitles(text: string): Map<string, string> {
  const out = new Map<string, string>()

  for (const m of text.matchAll(JIRA_TITLE)) {
    try {
      out.set(m[1] ?? '', JSON.parse(`"${m[2] ?? ''}"`))
    } catch {
      out.set(m[1] ?? '', m[2] ?? '')
    }
  }

  return out
}

/** `jira issue list --plain --columns key,summary --no-headers` output. */
export function parseJiraCli(text: string): Map<string, string> {
  const out = new Map<string, string>()

  for (const line of text.split('\n')) {
    const m = /^([A-Z][A-Z0-9]+-\d+)\t+(.+)$/.exec(line.trim())

    if (m) {
      out.set(m[1] ?? '', (m[2] ?? '').trim())
    }
  }

  return out
}

const TC_RUN = /\bteamcity\s+run\s+(view|show|log|watch|cancel|restart|pin|unpin|tag|untag|artifacts|download|comment)\b([^\n;&|]*)/g
const TC_REST_BUILD = /\/builds\/id:(\d{3,})/g
const SHELL_LOOP = /\bfor\s+\w+\s+in\s+([\d\s]+?)\s*;\s*do\b/g

/** Numeric ids a command feeds through a shell loop (`for r in 110 111; do …`). */
export function shellLoopIds(command: string): string[] {
  return [...command.matchAll(SHELL_LOOP)].flatMap(m => (m[1] ?? '').trim().split(/\s+/).filter(id => /^\d{3,}$/.test(id)))
}

/**
 * Builds a command names through the teamcity CLI: `run view|log|watch <id>`
 * (and cancel/restart, which change it), REST paths `…/builds/id:<id>`, ids fed
 * through a shell loop (`for r in 1 2; do teamcity run view $r`), and what
 * `run start` reports it started. `run list` is ignored: it lists everything.
 */
export function teamcityRefs(command: string, output: string, cfg: TrailConfig): Found[] {
  if (!/\bteamcity\b/.test(command)) {
    return []
  }

  const found: Found[] = []
  const loopIds = shellLoopIds(command)

  for (const m of command.matchAll(TC_RUN)) {
    const role: TrailRole = m[1] === 'cancel' || m[1] === 'restart' ? 'updated' : 'mentioned'
    const args = m[2] ?? ''
    const id = buildIdArg(args)

    for (const each of id ? [id] : /^[^"']*\$\w/.test(args) ? loopIds : []) {
      found.push(buildRef(cfg, each, role))
    }
  }

  for (const m of command.matchAll(TC_REST_BUILD)) {
    found.push(buildRef(cfg, m[1] ?? '', 'mentioned'))
  }

  if (/\$\w+/.test(command) && /\/builds\/id:\$/.test(command)) {
    found.push(...loopIds.map(id => buildRef(cfg, id, 'mentioned')))
  }

  if (/\bteamcity\s+run\s+start\b/.test(command)) {
    found.push(...findRefs(output, cfg, 'created').filter(one => one.kind === 'build'))
  }

  return found
}

/**
 * Build id ↔ number pairs a teamcity command printed: table rows
 * (`110322 #1.0.366 running main`) and JSON (`{"id": 110322, "number": "1.0.366"}`).
 * Claude often finds a build through a query and then calls it by its number
 * ("#1.0.366"), which is how the build is matched later.
 */
export function teamcityBuildNumbers(output: string): Array<{ id: string; number: string }> {
  const pairs: Array<{ id: string; number: string }> = []

  for (const m of output.matchAll(/(?:^|[\s|])(\d{5,})\s+#(\d[\w.-]*)/gm)) {
    pairs.push({ id: m[1] ?? '', number: m[2] ?? '' })
  }

  for (const m of output.matchAll(/"id"\s*:\s*(\d{5,})[^{}]*?"number"\s*:\s*"([^"]+)"/g)) {
    pairs.push({ id: m[1] ?? '', number: m[2] ?? '' })
  }

  for (const m of output.matchAll(/"number"\s*:\s*"([^"]+)"[^{}]*?"id"\s*:\s*(\d{5,})/g)) {
    pairs.push({ id: m[2] ?? '', number: m[1] ?? '' })
  }

  return pairs
}

/** Adds pairs to a number → id index; a number seen for several builds keeps the newest (largest) id. */
export function indexBuildNumbers(index: Map<string, string>, pairs: ReadonlyArray<{ id: string; number: string }>): void {
  for (const { id, number } of pairs) {
    const had = index.get(number)

    if (had === undefined || Number(id) > Number(had)) {
      index.set(number, id)
    }
  }
}

/** Builds the text names by a number (`#1.0.366`, `build 13359`, `1.0.366 is live`) that a teamcity command printed earlier. */
export function buildNumberRefs(text: string, index: ReadonlyMap<string, string>, cfg: TrailConfig): Found[] {
  if (index.size === 0) {
    return []
  }

  const found = new Map<string, Found>()

  // A dotted number (1.0.366, #1.0.366) reads as a build; a plain integer only with
  // "build" or "deploy" before it, since "#412" is far more often a PR, issue or run.
  for (const m of text.matchAll(/(?:\b(?:build|deploy)\s+#?(\d{3,})\b|#?\b(\d+(?:\.\d+){1,3})\b)/gi)) {
    const id = index.get(m[1] ?? m[2] ?? '')

    if (id !== undefined) {
      found.set(id, buildRef(cfg, id, 'mentioned'))
    }
  }

  return [...found.values()]
}

/**
 * The one build id a `teamcity run <verb>` takes: the first number standing as
 * a positional argument. A number right after a flag is that flag's value
 * (`--tail 500`), unless nothing else qualifies and it looks like a build id
 * (5+ digits: `--json 107554`). Quoted text (a comment) is never read.
 */
export function buildIdArg(args: string): string | undefined {
  const tokens = (args.split(/["']/)[0] ?? '').trim().split(/\s+/)
  let afterFlag: string | undefined

  for (let i = 0; i < tokens.length; i++) {
    const token = (tokens[i] ?? '').replace(/^#/, '')

    if (!/^\d{3,}$/.test(token)) {
      continue
    }

    if ((tokens[i - 1] ?? '').startsWith('-') && !(tokens[i - 1] ?? '').includes('=')) {
      afterFlag = afterFlag ?? (token.length >= 5 ? token : undefined)
      continue
    }

    return token
  }

  return afterFlag
}

/** The job a `teamcity run start <job>` command starts, if it names one. */
export function teamcityStartJob(command: string): string | undefined {
  const m = /\bteamcity\s+run\s+start\s+([^\n;&|]*)/.exec(command)

  return (m?.[1] ?? '').trim().split(/\s+/).find(token => token !== '' && !token.startsWith('-'))
}

/**
 * A finished run a teamcity command reported in its output (`run start --watch`,
 * `run watch`): `✓ Api_Test 110434  #295 succeeded` → its id, name, number and outcome.
 */
export function teamcityFinishLines(output: string): Array<{ id: string; name: string; number: string; isGood: boolean; outcome: string }> {
  return [...output.matchAll(/([✓✗])\s+(\S+)\s+(\d{3,})\s+#(\S+)\s+(succeeded|failed|canceled|cancelled|finished)/g)].map(m => ({
    id: m[3] ?? '',
    isGood: m[1] === '✓',
    name: m[2] ?? '',
    number: m[4] ?? '',
    outcome: m[5] ?? '',
  }))
}

/**
 * Errors that say nothing about the thing looked up (offline, asleep, signed
 * out, timed out): the lookup is asked again later. Anything else, such as
 * "could not resolve", is a final answer for that item.
 */
export function isTransientError(message: string): boolean {
  // The message usually names the PR, repo or build too (a number with 401 in
  // it, a repo called network-tools): rule out "not found" first, and match the
  // transient phrases as phrases.
  if (/could not resolve|not found|no build|\bHTTP 404\b/i.test(message)) {
    return false
  }

  return /error connecting|could not connect|connection (refused|reset)|\bnetwork is unreachable\b|\btimed out\b|\btimeout\b|ENOTFOUND|ECONN|EAI_AGAIN|dial tcp|no such host|i\/o timeout|gh auth login|not logged in|\bHTTP 401\b|\b401 Unauthorized\b|rate limit|\bHTTP 50[234]\b/i.test(
    message,
  )
}

const JIRA_WRITES = /__(editJiraIssue|transitionJiraIssue|addCommentToJiraIssue|addWorklogToJiraIssue|createIssueLink)$/

/**
 * Refs from one tool call other than Bash. Jira and incident.io creates read
 * the new key from the output; their writes promote what the input names.
 */
export function toolRefs(tool: string, input: unknown, output: string, cfg: TrailConfig): Found[] {
  if (CONTENT_TOOLS.has(tool)) {
    return []
  }

  const inputText = JSON.stringify(input ?? {})
  const found: Found[] = []

  if (/__createJiraIssue$/.test(tool)) {
    const summary = (input as { summary?: unknown } | null)?.summary

    found.push(
      ...findRefs(output, cfg, 'created')
        .filter(one => one.kind === 'jira')
        .slice(0, 1)
        .map(one => ({ ...one, title: typeof summary === 'string' ? summary : undefined })),
    )
  } else if (JIRA_WRITES.test(tool)) {
    // Only the issue acted on: a comment body naming other tickets only mentions them.
    const fields = input as { issueIdOrKey?: unknown; inwardIssue?: unknown; outwardIssue?: unknown } | null
    const targets = [fields?.issueIdOrKey, fields?.inwardIssue, fields?.outwardIssue].map(v => JSON.stringify(v ?? '')).join(' ')

    found.push(...findRefs(targets, cfg, 'updated').filter(one => one.kind === 'jira'))
  } else if (/incident_io__incident_create$/.test(tool)) {
    found.push(...findRefs(output, cfg, 'created').filter(one => one.kind === 'inc').slice(0, 1))
  } else if (tool === 'Artifact') {
    // Only a publish makes or updates an artifact, and its result names it first
    // ("Published … at <url>"). Quickstart, list and read results are catalogs of
    // type and gallery links, not the session's work.
    const { type_url: typeUrl, ...rest } = (input ?? {}) as { type_url?: unknown }
    const typeIds = new Set(findRefs(String(typeUrl ?? ''), cfg).map(one => one.id))

    if (isArtifactPublish(input)) {
      const label = artifactLabel(input)
      const made = findRefs(output, cfg, 'created').find(one => one.id.startsWith('doc:artifact:') && !typeIds.has(one.id))

      if (made !== undefined) {
        found.push({ ...made, label: label ?? made.label })
      }
    }

    // A type_url is a template link, never the session's own artifact.
    found.push(...findRefs(JSON.stringify(rest), cfg))

    return found
  }

  found.push(...findRefs(inputText, cfg))

  // Jira reads name their issues' summaries: keep them as titles of what the session already lists.
  if (/Atlassian__|jira/i.test(tool) && output !== '') {
    const titles = parseJiraTitles(output)

    for (const one of found) {
      const title = titles.get(one.label)

      if (one.kind === 'jira' && title !== undefined) {
        one.title = title
      }
    }
  }

  return found
}

function isArtifactPublish(input: unknown): boolean {
  const fields = (input ?? {}) as { action?: unknown; asset?: unknown }

  return (fields.action === undefined || fields.action === 'publish') && fields.asset !== true
}

/** An artifact's name from its publish call: the title given, else its page's file (a folder's `index` names the folder). */
function artifactLabel(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined
  }

  const { file_path: path, title } = input as { file_path?: unknown; title?: unknown }

  if (typeof title === 'string' && title.trim() !== '') {
    return title.trim()
  }

  if (typeof path !== 'string') {
    return undefined
  }

  const parts = path.split('/').filter(Boolean)
  const name = parts.pop()?.replace(/\.(html|md)$/, '')

  return name === 'index' ? (parts.pop() ?? name) : name
}

/** The `<title>` of an HTML page, when it has one. */
export function htmlTitle(html: string): string | undefined {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim()

  if (!raw) {
    return undefined
  }

  return raw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

/** Folds what was found into the list: stronger roles win, hits count up, dismissals stick. */
export function mergeRefs(list: readonly TrailRef[], found: readonly Found[], now: number): TrailRef[] {
  if (found.length === 0) {
    return [...list]
  }

  const byId = new Map(list.map(one => [one.id, one]))

  for (const one of found) {
    const had = byId.get(one.id)

    if (had === undefined) {
      byId.set(one.id, { ...one, firstSeen: now, hits: 1, isDismissed: false, isStarred: false, lastSeen: now })
      continue
    }

    const isStronger = ROLE_RANK[one.role] < ROLE_RANK[had.role]
    // An artifact takes the name from its latest publish; a bare link to it keeps that name.
    const isBetterLabel = one.id.startsWith('doc:artifact:') && !one.label.startsWith('Artifact ')

    byId.set(one.id, {
      ...had,
      hits: had.hits + 1,
      title: had.title ?? one.title,
      label: isBetterLabel ? one.label : had.label,
      lastSeen: now,
      role: isStronger ? one.role : had.role,
    })
  }

  return capRefs([...byId.values()])
}

const CAP = 300

/**
 * Keeps the trail bounded without losing the session's own work: starred,
 * created and edited refs always stay; past the cap, dismissed and
 * mention-only refs go first, oldest activity first.
 */
export function capRefs(all: TrailRef[], cap = CAP): TrailRef[] {
  if (all.length <= cap) {
    return all
  }

  const isKept = (one: TrailRef) => one.isStarred || (one.role !== 'mentioned' && !one.isDismissed)
  const spare = all
    .filter(one => !isKept(one))
    .sort((a, b) => Number(a.isDismissed) - Number(b.isDismissed) || b.lastSeen - a.lastSeen)
  const room = Math.max(0, cap - all.filter(isKept).length)
  const survivors = new Set(spare.slice(0, room).map(one => one.id))

  return all.filter(one => isKept(one) || survivors.has(one.id))
}

export const DEFAULT_LIMITS: Record<TrailKind, number> = { build: 3, doc: 5, inc: 5, jira: 5, pr: 5, run: 3 }

/** `jira=5,pr=5,inc=5,build=3,run=3,doc=5` → per-section display limits; anything missing or malformed keeps its default. */
export function parseLimits(raw: string): Record<TrailKind, number> {
  const out = { ...DEFAULT_LIMITS }

  for (const part of raw.split(',')) {
    const m = /^\s*(jira|pr|inc|build|run|doc)\s*=\s*(\d{1,3})\s*$/.exec(part)

    if (m) {
      out[(m[1] ?? 'jira') as TrailKind] = Math.max(1, Number(m[2]))
    }
  }

  return out
}

/** Newly created refs in `after` that `before` did not have as created. */
export function newlyCreated(before: readonly TrailRef[], after: readonly TrailRef[]): TrailRef[] {
  const was = new Map(before.map(one => [one.id, one.role]))

  return after.filter(one => one.role === 'created' && was.get(one.id) !== 'created')
}

/**
 * What the trail shows: a Jira key only once Jira confirmed the issue (its
 * summary came back), so examples, typos and lookalikes never surface. With
 * no way to ask Jira (`canVerifyJira` false), keys show unconfirmed.
 */
export function visibleRefs(list: readonly TrailRef[], canVerifyJira: boolean, canVerify: CanVerify = { gh: true, incident: true, teamcity: true }): TrailRef[] {
  return list.filter(one => {
    if (one.kind === 'jira') {
      return !(canVerifyJira && one.title === undefined)
    }

    // Builds and Actions runs likewise show once their lookup confirmed them (it titles them),
    // unless the tool that confirms them can't run here at all.
    if (one.id.startsWith('build:tc/')) {
      return !(canVerify.teamcity && one.title === undefined)
    }

    if (one.id.startsWith('run:gh/')) {
      return !(canVerify.gh && one.title === undefined)
    }

    if (one.kind === 'inc') {
      return !(canVerify.incident && one.title === undefined)
    }

    // A PR shows while its lookup is pending, but not once gh said it doesn't exist
    // (a lookup that failed because gh isn't installed said nothing).
    if (one.kind === 'pr') {
      return !(canVerify.gh && one.isTitleTried === true && one.title === undefined)
    }

    return true
  })
}

/** Whether the CLIs that confirm builds can run here; false once one failed to start. */
export type CanVerify = { gh: boolean; teamcity: boolean; incident: boolean }

/** A lookup that failed because its CLI isn't installed: nothing can confirm those refs here. */
export function isMissingTool(message: string): boolean {
  // Only the process failing to start: a CLI's own "cannot find build" is an answer, not a missing tool.
  return /\bENOENT\b|command not found|cannot start|executable file not found in \$PATH/i.test(message)
}

/** Starred first, then most recent activity first. */
export function sortRefs(list: readonly TrailRef[]): TrailRef[] {
  return [...list].sort((a, b) => Number(b.isStarred) - Number(a.isStarred) || b.lastSeen - a.lastSeen)
}

export function groupRefs(list: readonly TrailRef[]): Array<[TrailKind, TrailRef[]]> {
  const visible = list.filter(one => !one.isDismissed)

  return KIND_ORDER.map(kind => [kind, sortRefs(visible.filter(one => one.kind === kind))] as [TrailKind, TrailRef[]]).filter(
    ([, refs]) => refs.length > 0,
  )
}

/** The trail as markdown, ready for a Jira comment or a PR body. */
export function toMarkdown(list: readonly TrailRef[]): string {
  const groups = groupRefs(list)

  if (groups.length === 0) {
    return 'Trail is empty: no tickets, PRs, incidents, builds or docs seen yet this session.'
  }

  return groups
    .map(([kind, refs]) =>
      [
        `**${KIND_TITLE[kind]}**`,
        ...refs.map(
          one =>
            `- [${one.label.replace(/([[\]])/g, '\\$1')}](${one.href})${one.title ? ` ${one.title.replace(/([[\]])/g, '\\$1')}` : ''}${one.role === 'mentioned' ? '' : ` (${one.role})`}`,
        ),
      ].join('\n'),
    )
    .join('\n\n')
}

/** The site in the jira CLI's YAML config (`server: https://acme.atlassian.net`). */
export function parseJiraCliServer(yaml: string): string | null {
  const server = /^server:\s*["']?(https?:\/\/[^\s"']+)/m.exec(yaml)?.[1]

  return server ? trimSlash(server) : null
}

/** Project keys from `jira project list` (a KEY column first, then a header-less table). */
export function parseJiraProjectList(out: string): string[] {
  const keys = out
    .split('\n')
    .map(line => line.trim().split(/\s+/)[0] ?? '')
    .filter(key => key !== 'KEY')

  return parseProjects(keys.join(','))
}

/** Project keys of the issues in a Jira search reply (`"key": "ABC-123"`). */
export function projectsFromIssueKeys(text: string): string[] {
  const keys = new Set<string>()

  for (const m of text.matchAll(/"key"\s*:\s*"([A-Z][A-Z0-9]{1,9})-\d+"/g)) {
    keys.add(m[1] ?? '')
  }

  return [...keys].sort()
}

/** The first Atlassian Cloud site in a reply (the connector's accessible resources). */
export function atlassianSiteFromText(text: string): string | null {
  return /https:\/\/[\w-]+\.atlassian\.net/.exec(text)?.[0] ?? null
}

/** The first authenticated server in `teamcity auth status --json`. */
export function parseTeamcityServer(json: string): string | null {
  try {
    const list = JSON.parse(json) as Array<{ server?: string; status?: string }>
    const one = (Array.isArray(list) ? list : [list]).find(entry => entry.status === 'authenticated' && entry.server)

    return one?.server ? trimSlash(one.server) : null
  } catch {
    return null
  }
}

/** The incident.io org slug from a permalink (`app.incident.io/<slug>/incidents/…`). */
export function incidentOrgFromText(text: string): string | null {
  return /app\.incident\.io\/([\w-]+)\/incidents\//.exec(text)?.[1] ?? null
}

const DURATION_UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, w: 604_800_000 }

/** `30m`, `4h`, `2d`, `1w` or a run of them (`1d12h`) in milliseconds; null when it isn't one. */
export function parseDuration(text: string): number | null {
  const trimmed = text.trim().toLowerCase()

  if (!/^(\d+[mhdw])+$/.test(trimmed)) {
    return null
  }

  let total = 0

  for (const m of trimmed.matchAll(/(\d+)([mhdw])/g)) {
    total += Number(m[1] ?? 0) * (DURATION_UNIT_MS[m[2] ?? ''] ?? 0)
  }

  return total > 0 ? total : null
}

/** What `/trail clean` hides: shown, unstarred items with no activity since `cutoff`. */
export function staleRefs(list: readonly TrailRef[], cutoff: number): TrailRef[] {
  return list.filter(one => !one.isDismissed && !one.isStarred && one.lastSeen < cutoff)
}

/** Refs from one finished tool call, whatever the tool. */
export function harvest(cfg: TrailConfig, tool: string, input: unknown, output: string, hint: string | null, isError: boolean): Found[] {
  if (tool === 'Bash') {
    const command = String((input as { command?: unknown } | null)?.command ?? '')

    return bashRefs(command, isError ? '' : output, cfg, hint)
  }

  return toolRefs(tool, input, isError ? '' : output, cfg)
}

/** Calls whose output names what they made, so the transcript pass pairs them with their result. */
function readsOutput(tool: string, input: unknown): boolean {
  if (tool === 'Bash') {
    return /\bgh\s+pr\s+create\b|\bteamcity\s+(run\s+(start|list)|api)\b/.test(String((input as { command?: unknown } | null)?.command ?? ''))
  }

  return /__createJiraIssue$|incident_io__incident_create$|Atlassian__(getJiraIssue|searchJiraIssuesUsingJql|editJiraIssue)$/.test(tool) || tool === 'Artifact'
}

type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }

function resultText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  return Array.isArray(content) ? content.map(one => (one as Block).text ?? '').join('\n') : ''
}

/**
 * Fixed strings a transcript line must contain to be worth parsing: a superset
 * of what `transcriptScan` looks for, so a host `grep -F` can drop the rest
 * (most of a long transcript) before it reaches the plugin.
 */
export function transcriptNeedles(cfg: TrailConfig): string[] {
  return [
    'github.com/',
    'buildConfiguration/',
    'viewLog.html',
    'teamcity',
    'gh run',
    'actions/runs/',
    '.atlassian.net/wiki/',
    'claude.ai/',
    'gh pr',
    'INC-',
    'createJiraIssue',
    'incident_create',
    '"Artifact"',
    ...cfg.jiraProjects.map(p => `${p}-`),
  ]
}

/**
 * Every ref of a session from its transcript (JSONL), fed one line at a time,
 * compactions and all: the file keeps every row, where the live message list
 * starts at the last compaction. Lines that cannot hold a ref are skipped
 * unparsed. Streams, so a transcript of any size fits.
 */
export function transcriptScan(
  cfg: TrailConfig,
  hint: string | null,
): { line: (line: string) => void; refs: () => TrailRef[]; buildNumbers: () => Map<string, string>; pages: () => Map<string, string> } {
  const hintAt = new RegExp(
    ['github\\.com/', 'buildConfiguration/', 'viewLog\\.html', '\\bteamcity\\s', '\\bgh\\s+run\\b', 'actions/runs/', '\\.atlassian\\.net/wiki/', 'claude\\.ai/', '\\bgh\\s+pr\\b', '\\bINC-\\d', ...cfg.jiraProjects.map(p => `\\b${p}-\\d`)].join('|'),
  )
  const pending = new Map<string, Block>()
  const buildNumbers = new Map<string, string>()
  // Artifact id → the HTML page it was last published from, whose <title> names it.
  const pages = new Map<string, string>()
  let list: TrailRef[] = []
  let at = 0

  const line = (text: string) => {
    const isPaired = pending.size > 0 && text.includes('"tool_result"') && [...pending.keys()].some(id => text.includes(id))

    if (!isPaired && !hintAt.test(text) && !(text.includes('"tool_use"') && /createJiraIssue|incident_create|"Artifact"/.test(text))) {
      return
    }

    let row: { type?: string; isSidechain?: boolean; isMeta?: boolean; timestamp?: string; message?: { content?: unknown } }

    try {
      row = JSON.parse(text)
    } catch {
      return
    }

    if (row.isSidechain || row.isMeta) {
      return
    }

    at = Math.max(at + 1, Date.parse(row.timestamp ?? '') || 0)
    const content = row.message?.content
    const found: Found[] = []

    if (row.type === 'user' && typeof content === 'string' && !content.startsWith('<')) {
      found.push(...findRefs(content, cfg))
    }

    if (Array.isArray(content)) {
      for (const block of content as Block[]) {
        if (row.type === 'assistant' && block.type === 'text') {
          found.push(...findRefs(block.text ?? '', cfg), ...buildNumberRefs(block.text ?? '', buildNumbers, cfg))
        } else if (block.type === 'tool_use' && block.id && block.name) {
          // Input refs now, whether or not the result line survives a grep filter;
          // a call whose output names what it made is parked for that output too.
          found.push(...harvest(cfg, block.name, block.input, '', hint, false))

          if (readsOutput(block.name, block.input)) {
            pending.set(block.id, block)
          }
        } else if (block.type === 'tool_result' && block.tool_use_id && pending.has(block.tool_use_id)) {
          const use = pending.get(block.tool_use_id) as Block

          pending.delete(block.tool_use_id)

          if (use.name === 'Bash' && /\bteamcity\b/.test(String((use.input as { command?: unknown } | null)?.command ?? ''))) {
            indexBuildNumbers(buildNumbers, teamcityBuildNumbers(resultText(block.content)))
          }

          const made = harvest(cfg, use.name ?? '', use.input, resultText(block.content), hint, block.is_error === true)
          const page = (use.input as { file_path?: unknown } | null)?.file_path

          if (use.name === 'Artifact' && typeof page === 'string' && /\.html?$/i.test(page)) {
            for (const one of made.filter(m => m.role === 'created' && m.id.startsWith('doc:artifact:'))) {
              pages.set(one.id, page)
            }
          }

          found.push(...made)
        }
      }
    }

    list = mergeRefs(list, found, at)
  }

  return { buildNumbers: () => buildNumbers, line, pages: () => pages, refs: () => list }
}

/** `transcriptScan` over a whole transcript held in memory. */
export function transcriptRefs(jsonl: string, cfg: TrailConfig, hint: string | null): TrailRef[] {
  const scan = transcriptScan(cfg, hint)

  for (const line of jsonl.split('\n')) {
    scan.line(line)
  }

  return scan.refs()
}
