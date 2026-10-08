import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TrailRef, TrailRole, TrailStatus } from '../types'
import {
  KIND_TITLE,
  findRefs,
  groupRefs,
  harvest,
  buildNumberRefs,
  indexBuildNumbers,
  isMissingTool,
  teamcityFinishLines,
  teamcityStartJob,
  isTransientError,
  visibleRefs,
  mergeRefs,
  newlyCreated,
  atlassianSiteFromText,
  incidentOrgFromText,
  parseJiraCli,
  parseJiraCliServer,
  parseJiraProjectList,
  parseTeamcityServer,
  projectsFromIssueKeys,
  parseJiraTitles,
  parseDuration,
  parseLimits,
  parseProjects,
  staleRefs,
  sortRefs,
  teamcityBuildNumbers,
  toMarkdown,
  transcriptNeedles,
  transcriptScan,
} from './refs'
import type { Found, TrailConfig } from './refs'
import { ACCENTS, WARN, bar, gitLabel, levelColor, parseGitStatus, prettyModel, untilLabel } from './status'

const PANE = 'trail'
const TITLE = 'Trail'
const PANE_COLUMNS = 44
/** Bump when extraction rules change: a session's trail built by older rules is rebuilt from its transcript. */
const BUILD = 7
const ROLE_TAG: Record<TrailRole, string> = { created: 'new', mentioned: '', updated: 'edited' }
const MARKS_KEPT = 50
/** Prompts a person sent (typed, from a phone, an SDK host); the rest are relayed model output. */
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk'])

const refsAtom = atom({ plugin: 'trail', key: 'refs' } as const, [])
const statusAtom = atom({ plugin: 'trail', key: 'status' } as const, null)
const builtAtom = atom({ plugin: 'trail', key: 'built' } as const, 0)
const expandedAtom = atom({ plugin: 'trail', key: 'expanded' } as const, [])
const loadingAtom = atom({ plugin: 'trail', key: 'isLoading' } as const, false)
const jiraHelpAtom = atom({ plugin: 'trail', key: 'jiraHelp' } as const, '')
const collapsedAtom = atom({ plugin: 'trail', key: 'collapsed' } as const, [])
const filterAtom = atom({ plugin: 'trail', key: 'filter' } as const, '')
const latestAtom = atom({ plugin: 'trail', key: 'latest' } as const, null)
const freshSinceAtom = atom({ plugin: 'trail', key: 'freshSince' } as const, Number.MAX_SAFE_INTEGER)

type $ = EngineInterface
type StatusStyle = 'bottom' | 'band' | 'off'
type Marks = { starred: string[]; dismissed: string[] }

/**
 * Which Jira title source works here: Atlassian MCP first, then the jira CLI.
 * Undecided until MCP answers, or until the session has been up SETTLE_MS
 * (connectors often connect after startup); only then does the CLI become the
 * settled source. With neither answering by then, the probe gives up
 * (`isJiraGivenUp`: keys show unconfirmed), yet every later round still tries
 * MCP first, so a late connector recovers.
 */
let jiraSource: { kind: 'mcp'; server: string } | { kind: 'cli' } | undefined
let isJiraGivenUp = false
let jiraError: string | undefined
/** Why the Atlassian MCP isn't being used (often a missing permission rule); kept after the CLI settles. */
let mcpSkipReason: string | undefined
/** The MCP search's tool name and verdict when it is connected but the rules don't plainly allow it. */
let mcpBlockedTool: string | undefined
let mcpVerdict: 'ask' | 'deny' | undefined
/** Which source answered the last Jira lookup, settled or not, for /trail status. */
let lastJiraAnswer: 'mcp' | 'cli' | undefined
/** Why gh title lookups fail (not installed, not signed in), until one succeeds. */
let ghError: string | undefined
/** The last TeamCity lookup error that wasn't the build's own (offline, signed out), for /trail status. */
let tcError: string | undefined
/** The gh or teamcity CLI failed to start: builds it would confirm show unconfirmed instead of hidden. */
let isGhMissing = false
let isTeamcityMissing = false
/** Why incident titles can't be looked up (no incident.io connector, or its tool not allowed); incidents then show unconfirmed. */
let incidentSkipReason: string | undefined
/** The last incident lookup error that wasn't an answer about the incident (a dropped connector, an auth error). */
let incidentError: string | undefined
/** Why the last backfill could not read the transcript file, for /trail status. */
let backfillError: string | undefined
/** How the last backfill filled the trail, for /trail status. */
let backfillSource: 'transcript' | 'messages' | 'skipped' | undefined
let probes = 0
let startedAt = 0
/**
 * Bumped at session end: work started for an earlier session (a lookup in
 * flight during /clear) checks it and drops its results instead of writing
 * them into the next one.
 */
let generation = 0
const SETTLE_MS = 60_000
const MCP_TIMEOUT_MS = 20_000
let isResolving = false
/** How long pop-ups stay (the `toastSeconds` setting). */
let toastMs = 8000

/**
 * One notification: a pop-up (text only, it can't take a link) plus the status row's
 * latest-event slot, which is a clickable link to the PR, ticket or build until your
 * next message. Fire and forget: nothing waits on it.
 */
function notify($: $, text: string, href?: string): void {
  $.ui.toast(text, { timeoutMs: toastMs })
  void update($, latestAtom, () => ({ href: href ?? null, text })).catch(() => undefined)
}
/** Ids already announced as created this session, so a pop-up fires once, right when it's noticed. */
let announced = new Set<string>()
/** Build start/finish pop-ups only after load: what a session already had isn't news. */
let isLive = false
/** The `sounds` setting: a chime with the created and merged toasts. */
let isSoundOn = true

/** Plays one of the plugin's chimes; never lets a missing player or file disturb anything. */
function chime($: $, name: 'created' | 'merged' | 'failed'): void {
  if (isSoundOn) {
    void $.audio.play({ asset: `sounds/${name}.wav` }, { gain: 0.6 }).catch(() => undefined)
  }
}
/**
 * What the hooks saw since the last flush. Events only collect here (no
 * engine calls), so a tool call, prompt or reply is never held up; the
 * trail catches up once per turn, at its end.
 */
let pending: Found[] = []
/** Build number → id from teamcity output this session, so "#1.0.366" in a reply finds its build. */
let buildNumbers = new Map<string, string>()
/** You've sent a message since load (its freshness window must not be overwritten by the load). */
let hasPrompted = false
/** A mid-turn update is already scheduled (debounces the immediate-flush path). */
let isFlushScheduled = false

/**
 * Brings the sidebar up to date soon, mid-turn: for a create, merge or edit, which you
 * shouldn't have to wait for a long turn to end to see. Debounced; nothing waits on it.
 */
function flushSoon($: $, cfg: TrailConfig, style: StatusStyle): void {
  if (isFlushScheduled) {
    return
  }

  isFlushScheduled = true
  $.clock.after(2000, () => {
    isFlushScheduled = false
    void flush($, cfg, style).catch(() => undefined)
  })
}

/** Bounded, so a session whose turns never complete (a headless run) cannot grow it without end. */
function queue(found: readonly Found[]): void {
  if (found.length > 0 && !isDemo) {
    pending = [...pending, ...found].slice(-2000)
  }
}

/** The session repo as `owner/name`, read at load and each turn end, for bare `gh pr 12` calls. */
let repo: string | null = null

/** Jira keys wait for confirmation unless no source could confirm them by the time the probe settled. */
function canVerifyJira(): boolean {
  return !isJiraGivenUp
}

async function shownRefs($: $): Promise<TrailRef[]> {
  return visibleRefs(await read($, refsAtom), canVerifyJira(), {
    gh: !isGhMissing,
    incident: incidentSkipReason === undefined,
    teamcity: !isTeamcityMissing,
  })
}

function repoFromRemote(remote: string | null): string | null {
  if (remote === null) {
    return null
  }

  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote)

  return m ? `${m[1]}/${m[2]}` : null
}

/** `3h12m`, `45m`, `2d4h`: how long a session has been going. */
function durationLabel(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60000))

  if (mins < 60) {
    return `${mins}m`
  }

  const hours = Math.floor(mins / 60)

  if (hours < 24) {
    return `${hours}h${String(mins % 60).padStart(2, '0')}m`
  }

  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function windowLabel(tokens: number | null): string | null {
  if (!tokens) {
    return null
  }

  return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M` : `${Math.round(tokens / 1000)}k`
}

async function addFound($: $, found: readonly Found[], style: StatusStyle): Promise<void> {
  if (found.length === 0) {
    return
  }

  const before = await read($, refsAtom)
  const now = await $.clock.now()
  const after = mergeRefs(before, found, now)

  await update($, refsAtom, list => mergeRefs(list, found, now))

  // Catches creates the immediate pop-up in tool.call didn't announce. Builds and runs
  // never say "created": they get started/finished pop-ups from announceBuilds.
  const created = newlyCreated(before, after)
    .filter(one => one.kind !== 'build' && one.kind !== 'run' && !announced.has(one.id))

  for (const one of created) {
    announced.add(one.id)
    notify($, `🔗 ${popupName(one)} created`, one.href)
  }

  if (created.length > 0) {
    chime($, 'created')
  }

  await paintStatus($, style)
}

async function repoHint($: $): Promise<string | null> {
  const found = await $.session.repo()

  return found === null ? null : (found.name ?? repoFromRemote(found.remote))
}

/** End of turn: folds in what the turn touched, refreshes the status, and looks up missing titles. */
async function flush($: $, cfg: TrailConfig, style: StatusStyle): Promise<void> {
  if (isDemo) {
    return
  }

  // The session this flush was scheduled for; a /clear during the awaits below makes it stale.
  const gen = generation
  const found = pending

  pending = []
  repo = await repoHint($).catch(() => repo)
  await addFound($, found, style)
  await refreshStatus($, style)
  await drainTitles($, cfg, gen, 3)
}

async function refreshStatus($: $, style: StatusStyle): Promise<void> {
  // A demo's status row is the fixture's; the real one comes back when it ends.
  if (isDemo) {
    return
  }

  const [model, cwd, usage, sessionId] = await Promise.all([
    $.session.model(),
    $.session.cwd(),
    $.session.usage(),
    $.session.id(),
  ])

  let git = null

  try {
    const ran = await $.process.run(['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'], {
      cwd,
      timeoutMs: 5000,
    })

    git = ran.exitCode === 0 ? parseGitStatus(ran.stdout) : null
  } catch {
    git = null
  }

  const five = usage.rateLimits.find(one => one.kind === 'five_hour')
  const next: TrailStatus = {
    contextPercent: usage.context.percent ?? null,
    contextWindow: usage.context.window,
    dir: cwd.split('/').filter(Boolean).pop() ?? cwd,
    fiveHourPercent: five?.percentUsed ?? null,
    fiveHourResetsAt: five?.resetsAt ?? null,
    git,
    model: prettyModel(model),
    repo: await repoHint($).catch(() => null),
    sessionId,
    startedAt: usage.startedAt ?? null,
  }

  await update($, statusAtom, was => (JSON.stringify(was) === JSON.stringify(next) ? was : next))
  await paintStatus($, style)
}

/**
 * The bottom status line: plain text pinned under the prompt (the native
 * status line slot is the statusLine command's alone, and this one cannot
 * carry color or clicks). Says how to bring the sidebar back while hidden.
 */
async function paintStatus($: $, style: StatusStyle): Promise<void> {
  const status = await read($, statusAtom)

  if (style !== 'bottom' || status === null) {
    $.ui.status(undefined)

    return
  }

  const live = (await shownRefs($)).filter(one => !one.isDismissed).length
  const isOpen = await isPaneOpen($)
  const parts = [status.model, `📁 ${status.dir}`]

  if (status.git) {
    parts.push(`🔀 ${status.git.branch} ${gitLabel(status.git)}`)
  }

  if (status.contextPercent !== null) {
    const window = windowLabel(status.contextWindow)

    parts.push(`${bar(status.contextPercent).map(c => c.cell).join('')} ${Math.round(status.contextPercent)}%${window ? ` of ${window}` : ''}`)
  }

  if (status.fiveHourPercent !== null) {
    const until = untilLabel(status.fiveHourResetsAt, await $.clock.now())

    parts.push(`5h ${Math.round(status.fiveHourPercent)}%${until ? ` ↻ ${until}` : ''}`)
  }

  parts.push(`⧉ ${status.sessionId.slice(0, 8)}`)
  parts.push(isOpen ? `🔗 trail: ${live}` : `🔗 trail: ${live} (/trail shows it)`)
  $.ui.status(parts.join(' │ '))
}

async function isPaneOpen($: $): Promise<boolean> {
  return (await $.ui.panes()).some(one => one.id === PANE)
}

async function openPane($: $, style: StatusStyle): Promise<void> {
  await $.store.set('autoOpen', true)
  await $.ui.open({ columns: PANE_COLUMNS, id: PANE, title: TITLE })
  await paintStatus($, style)
}

async function hidePane($: $, style: StatusStyle): Promise<void> {
  await $.store.set('autoOpen', false)
  await $.ui.close({ id: PANE })
  await paintStatus($, style)
}

async function togglePane($: $, style: StatusStyle): Promise<boolean> {
  if (await isPaneOpen($)) {
    await hidePane($, style)

    return false
  }

  await openPane($, style)

  return true
}

async function copyResume($: $, surface?: Parameters<$['ui']['copy']>[0]['surface']): Promise<void> {
  // A demo shows its own session id; the real one never appears in a recording.
  const id = (isDemo ? (await read($, statusAtom))?.sessionId : undefined) || (await $.session.id())
  const done = await $.ui.copy({ surface, text: `claude --resume ${id}` })

  $.ui.toast(done.isCopied ? `Copied: claude --resume ${id}` : `claude --resume ${id}`)
}

/** Opens a link in the default browser (macOS `open`, else `xdg-open`). */
async function openUrl($: $, href: string): Promise<void> {
  if (!/^https?:\/\//.test(href)) {
    return
  }

  // A demo's links lead nowhere real: say where it would go instead of opening a dead page.
  if (isDemo) {
    $.ui.toast(`↗ ${href.replace(/^https?:\/\//, '')}`, { timeoutMs: toastMs })

    return
  }

  const ran = await $.process.run(['open', href], { timeoutMs: 5000 }).catch(() => null)

  if (ran === null || ran.exitCode !== 0) {
    await $.process.run(['xdg-open', href], { timeoutMs: 5000 }).catch(() => $.ui.toast(`Could not open ${href}`))
  }
}

/** Opens the session's folder in the desktop's file manager (Finder on macOS). */
async function revealDir($: $): Promise<void> {
  const cwd = await $.session.cwd()
  const ran = await $.process.run(['open', cwd], { timeoutMs: 5000 }).catch(() => null)

  if (ran === null || ran.exitCode !== 0) {
    await $.process.run(['xdg-open', cwd], { timeoutMs: 5000 }).catch(() => $.ui.toast(`Could not open ${cwd}`))
  }
}

/** Collapses or expands one section; the choice is kept across sessions. */
async function toggleSection($: $, kind: string): Promise<void> {
  await update($, collapsedAtom, was => (was.includes(kind) ? was.filter(one => one !== kind) : [...was, kind]))
  await $.store.set('collapsedKinds', await read($, collapsedAtom))
}

async function copyAllowRule($: $, surface?: Parameters<$['ui']['copy']>[0]['surface']): Promise<void> {
  const rule = mcpBlockedTool ?? 'mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql'
  const done = await $.ui.copy({ surface, text: rule })

  $.ui.toast(done.isCopied ? `Copied ${rule}: paste it in /permissions → Allow` : `Add ${rule} in /permissions → Allow`, { timeoutMs: 8000 })
}

async function copyMarkdown($: $, surface?: Parameters<$['ui']['copy']>[0]['surface']): Promise<void> {
  const done = await $.ui.copy({ surface, text: toMarkdown(await shownRefs($)) })

  $.ui.toast(done.isCopied ? 'Trail copied as markdown' : 'Copy failed: try /trail md')
}

/** Stars and dismissals outlive the process: kept per session in the store, the newest sessions only. */
async function saveMarks($: $, list: readonly TrailRef[]): Promise<void> {
  // A demo's stars and dismissals are the demo's: the session's own marks stay as they were.
  if (isDemo) {
    return
  }

  const id = await $.session.id()
  const marks: Marks = {
    dismissed: list.filter(one => one.isDismissed).map(one => one.id),
    starred: list.filter(one => one.isStarred).map(one => one.id),
  }
  const order = ((await $.store.get('marksOrder')) as string[] | undefined) ?? []
  const kept = [id, ...order.filter(one => one !== id)]

  for (const old of kept.slice(MARKS_KEPT)) {
    await $.store.delete(`marks:${old}`)
  }

  await $.store.set(`marks:${id}`, marks)
  await $.store.set('marksOrder', kept.slice(0, MARKS_KEPT))
}

async function setMark($: $, id: string, change: (one: TrailRef) => TrailRef, style: StatusStyle): Promise<void> {
  await update($, refsAtom, list => list.map(one => (one.id === id ? change(one) : one)))
  await saveMarks($, await read($, refsAtom))
  await paintStatus($, style)
}

async function restoreAll($: $, style: StatusStyle): Promise<void> {
  await update($, refsAtom, list => list.map(one => ({ ...one, isDismissed: false })))
  await saveMarks($, await read($, refsAtom))
  await paintStatus($, style)
}

/** The session's transcript file: under its working directory's project folder, else found by id in any project folder. */
async function transcriptPath($: $, sessionId: string): Promise<string | null> {
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  const project = (await $.session.cwd()).replace(/[^A-Za-z0-9]/g, '-')
  const path = `${configDir}/projects/${project}/${sessionId}.jsonl`

  if (await $.fs.exists(path)) {
    return path
  }

  for (const dir of await $.fs.list(`${configDir}/projects`)) {
    const candidate = `${configDir}/projects/${dir.name}/${sessionId}.jsonl`

    if (dir.kind === 'dir' && (await $.fs.exists(candidate))) {
      return candidate
    }
  }

  return null
}

/**
 * Streams the transcript through a host `grep -F` that keeps only lines that
 * can hold a ref, then scans them line by line. Streaming, because a long
 * session's transcript is tens of MB and a single plugin read stops at 4 MiB.
 */
async function streamTranscript($: $, path: string, cfg: TrailConfig, hint: string | null): Promise<{ refs: TrailRef[]; numbers: Map<string, string> }> {
  const scan = transcriptScan(cfg, hint)
  // -a: never let a stray byte make grep call the file binary and stop printing lines.
  const argv = ['grep', '-a', '-F', ...transcriptNeedles(cfg).flatMap(needle => ['-e', needle]), '--', path]
  const child = $.process.spawn({ argv })
  let carry = ''
  let errors = ''

  for await (const { stream, text } of child) {
    if (stream === 'stderr') {
      errors += text
      continue
    }

    const parts = (carry + text).split('\n')

    carry = parts.pop() ?? ''

    for (const part of parts) {
      scan.line(part)
    }
  }

  if (carry !== '') {
    scan.line(carry)
  }

  // grep: 0 matched, 1 nothing matched, 2+ (or a signal) failed, possibly after printing part of the file.
  const { code, signal } = await child.result

  if (code === null || code >= 2) {
    throw new Error(`grep ${signal ? `killed by ${signal}` : `exited ${code}`}${errors.trim() ? `: ${errors.trim().slice(0, 200)}` : ''}`)
  }

  return { numbers: scan.buildNumbers(), refs: scan.refs() }
}

/**
 * Fills the trail from what the session already did: the transcript file
 * when there is one (every row, through compactions), the live message list
 * otherwise; then puts back this session's stars and dismissals. Rebuilds
 * a trail an older build of these rules made.
 */
async function backfill($: $, cfg: TrailConfig, style: StatusStyle, gen: number): Promise<void> {
  const isCurrent = (await read($, builtAtom)) === BUILD

  if (isCurrent && (await read($, refsAtom)).length > 0) {
    backfillSource = 'skipped'

    return
  }

  await update($, loadingAtom, () => true)

  try {
    await fillFromHistory($, cfg, style, isCurrent, gen)
  } finally {
    // A newer session's backfill owns the indicator now.
    if (gen === generation) {
      await update($, loadingAtom, () => false)
    }
  }
}

async function fillFromHistory($: $, cfg: TrailConfig, style: StatusStyle, isCurrent: boolean, gen: number): Promise<void> {
  const hint = await repoHint($)
  const sessionId = await $.session.id()
  const path = await transcriptPath($, sessionId).catch(() => null)
  let found: TrailRef[] = []

  let fromFile: { refs: TrailRef[]; numbers: Map<string, string> } | null = null

  if (path === null) {
    backfillError = 'no transcript file found for this session'
  } else {
    fromFile = await streamTranscript($, path, cfg, hint).catch(err => {
      backfillError = `${path}: ${errorText(err)}`

      return null
    })
  }

  if (fromFile !== null) {
    // History's build numbers seed the live index, so "#1.0.366" right after a resume still matches.
    indexBuildNumbers(buildNumbers, [...fromFile.numbers].map(([number, id]) => ({ id, number })))
    found = fromFile.refs
    backfillError = undefined
    backfillSource = 'transcript'
  } else {
    backfillSource = 'messages'

    const messages = await $.session.messages()
    // One step per message, ending at now, so backfilled activity never ranks newer than live activity.
    let at = (await $.clock.now()) - messages.length

    for (const msg of messages) {
      at += 1

      // As in the transcript pass, injected user rows (notifications, peer and subagent messages) aren't read.
      const isInjected = msg.role === 'user' && /^(?:<|Another Claude session sent a message)/.test(msg.text)
      const fromMsg = isInjected ? [] : [...findRefs(msg.text, cfg)]

      for (const use of msg.toolUses) {
        fromMsg.push(...harvest(cfg, use.tool, use.input, use.text ?? '', hint, use.isError === true))
      }

      found = mergeRefs(found, fromMsg, at)
    }
  }

  const marks = ((await $.store.get(`marks:${sessionId}`)) as Marks | undefined) ?? { dismissed: [], starred: [] }

  found = found.map(one => ({
    ...one,
    isDismissed: one.isDismissed || marks.dismissed.includes(one.id),
    isStarred: one.isStarred || marks.starred.includes(one.id),
  }))

  // The session ended while history was read: these refs belong to no one now.
  if (gen !== generation) {
    return
  }

  // Backfilled creates are history, not news: no toasts. A rebuild replaces
  // the list; otherwise what arrived while the file was read is kept.
  await update($, refsAtom, list => {
    if (!isCurrent) {
      return found
    }

    const live = new Set(list.map(one => one.id))

    return [...found.filter(one => !live.has(one.id)), ...list]
  })
  await update($, builtAtom, () => BUILD)
  await paintStatus($, style)
}

/** Settings worked out on this machine, kept in the store so the next load starts with them. */
type Detected = { incidentOrg?: string; jiraBaseUrl?: string; jiraProjects?: string[]; teamcityUrl?: string }

/** Where each setting came from, for `/trail status`. */
const settingSources = new Map<string, string>()

/** Which settings the person set; the rest are detected. */
type Configured = Record<'githubOrg' | 'incidentOrg' | 'jiraBaseUrl' | 'jiraProjects' | 'teamcityUrl', boolean>

function applyDetected(cfg: TrailConfig, configured: Configured, found: Detected, source: string): void {
  if (!configured.jiraBaseUrl && found.jiraBaseUrl) {
    cfg.jiraBaseUrl = found.jiraBaseUrl
    settingSources.set('jiraBaseUrl', source)
  }

  if (!configured.jiraProjects && found.jiraProjects && found.jiraProjects.length > 0) {
    cfg.jiraProjects = found.jiraProjects
    settingSources.set('jiraProjects', source)
  }

  if (!configured.teamcityUrl && found.teamcityUrl) {
    cfg.teamcityUrl = found.teamcityUrl
    settingSources.set('teamcityUrl', source)
  }

  if (!configured.incidentOrg && found.incidentOrg) {
    cfg.incidentOrg = found.incidentOrg
    settingSources.set('incidentOrg', source)
  }
}

/** An MCP tool's text reply, only when it's connected and the permission rules plainly allow it. */
async function allowedMcpText($: $, tool: string, args: Record<string, unknown>): Promise<string | null> {
  if (!(await $.tool.list()).some(one => one.name === tool)) {
    return null
  }

  if ((await $.tool.check({ input: args, tool })).decision !== 'allow') {
    return null
  }

  const [, server = '', name = ''] = /^mcp__(.+)__([^_].*)$/.exec(tool) ?? []
  const ran = await Promise.race([$.mcp.call(server, name, args), $.clock.sleep(MCP_TIMEOUT_MS).then(() => 'timeout' as const)])

  if (ran === 'timeout' || ran.isError) {
    return null
  }

  return ran.content.map(block => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('\n')
}

/**
 * Fills the settings left empty from what this machine already knows: the
 * jira CLI's config and project list (or the Atlassian connector), the
 * teamcity CLI's login, and an incident.io permalink. Each source is tried
 * only if it's installed or allowed; one that fails leaves its setting empty
 * (that integration stays off). Remembered for the next load.
 */
async function detectSettings($: $, cfg: TrailConfig, configured: Configured): Promise<void> {
  const found: Detected = {}
  const home = await homeDir($).catch(() => '')
  const env = await $.process.run(['printenv', 'JIRA_CONFIG_FILE'], { timeoutMs: 5000 }).catch(() => null)
  const jiraConfig = env?.exitCode === 0 && env.stdout.trim() !== '' ? env.stdout.trim() : `${home}/.config/.jira/.config.yml`

  if (!configured.jiraBaseUrl) {
    const yaml = await $.fs.read(jiraConfig).catch(() => '')

    found.jiraBaseUrl = parseJiraCliServer(yaml) ?? undefined

    if (found.jiraBaseUrl === undefined) {
      const text = await allowedMcpText($, mcpToolName(cfg.atlassianServer, 'getAccessibleAtlassianResources'), {}).catch(() => null)

      found.jiraBaseUrl = (text && atlassianSiteFromText(text)) ?? undefined
    }
  }

  applyDetected(cfg, configured, found, 'detected')

  if (!configured.jiraProjects && cfg.jiraBaseUrl !== '') {
    const ran = await $.process.run(['jira', 'project', 'list'], { timeoutMs: 20000 }).catch(() => null)
    let projects = ran?.exitCode === 0 ? parseJiraProjectList(ran.stdout) : []

    if (projects.length === 0) {
      // The projects of recently updated issues: the same read-only search titles use.
      const text = await allowedMcpText($, mcpToolName(cfg.atlassianServer, 'searchJiraIssuesUsingJql'), {
        cloudId: jiraHost(cfg),
        fields: ['summary'],
        jql: 'updated >= -180d ORDER BY updated DESC',
        maxResults: 100,
      }).catch(() => null)

      projects = text ? projectsFromIssueKeys(text) : []
    }

    found.jiraProjects = projects
  }

  if (!configured.teamcityUrl) {
    const ran = await $.process.run(['teamcity', 'auth', 'status', '--json'], { timeoutMs: 10000 }).catch(() => null)

    found.teamcityUrl = (ran && parseTeamcityServer(ran.stdout)) ?? undefined
  }

  if (!configured.incidentOrg) {
    const tool = (await $.tool.list()).map(one => one.name).find(name => /^mcp__[\w-]*incident[\w-]*__incident_list$/i.test(name))
    const text = tool ? await allowedMcpText($, tool, { page_size: 1 }).catch(() => null) : null

    found.incidentOrg = (text && incidentOrgFromText(text)) ?? undefined
  }

  applyDetected(cfg, configured, found, 'detected')

  const kept = ((await $.store.get('detected')) as Detected | undefined) ?? {}

  await $.store.set('detected', { ...kept, ...Object.fromEntries(Object.entries(found).filter(([, value]) => value !== undefined)) })
}

function jiraHost(cfg: TrailConfig): string {
  try {
    return new URL(cfg.jiraBaseUrl).host
  } catch {
    return cfg.jiraBaseUrl
  }
}

/** `claude.ai Atlassian` → `mcp__claude_ai_Atlassian__<tool>`, the name permission rules use. */
function mcpToolName(server: string, tool: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__${tool}`
}

async function jiraViaMcp($: $, server: string, cfg: TrailConfig, keys: readonly string[]): Promise<Map<string, string>> {
  const args = {
    cloudId: jiraHost(cfg),
    fields: ['summary'],
    jql: `key in (${keys.join(', ')})`,
    maxResults: 100,
  }
  const tool = mcpToolName(server, 'searchJiraIssuesUsingJql')

  if (!(await $.tool.list()).some(one => one.name === tool)) {
    mcpBlockedTool = undefined
    mcpVerdict = undefined
    throw new Error(`${server} is not connected (no ${tool})`)
  }

  // A plugin's MCP call still meets the permission mode (auto mode's classifier
  // can deny it, with a notice). Ask the rules first and only call on a plain
  // allow, so a background lookup never prompts, classifies or warns. An
  // explicit deny is the person's choice; only "ask" is offered the allow rule.
  const verdict = await $.tool.check({ input: args, tool })

  mcpBlockedTool = verdict.decision === 'allow' ? undefined : tool
  mcpVerdict = verdict.decision === 'allow' ? undefined : verdict.decision

  if (verdict.decision !== 'allow') {
    throw new Error(`not allowed by permissions (${verdict.decision}); add "${tool}" to permissions.allow to use MCP`)
  }

  // A half-connected connector must not stall every later lookup round.
  // The timer resolves to a marker rather than rejecting, so the race's loser never rejects unhandled.
  const ran = await Promise.race([
    $.mcp.call(server, 'searchJiraIssuesUsingJql', args),
    $.clock.sleep(MCP_TIMEOUT_MS).then(() => 'timeout' as const),
  ])

  if (ran === 'timeout') {
    throw new Error(`no answer from ${server} within ${MCP_TIMEOUT_MS / 1000} s`)
  }

  if (ran.isError) {
    throw new Error('search failed')
  }

  const text = ran.content.map(block => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('\n')

  return parseJiraTitles(text)
}

async function jiraViaCli($: $, keys: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const byProject = new Map<string, string[]>()

  for (const key of keys) {
    const project = key.split('-')[0] ?? ''

    byProject.set(project, [...(byProject.get(project) ?? []), key])
  }

  for (const [project, list] of byProject) {
    const ran = await $.process.run(
      ['jira', 'issue', 'list', '-p', project, '-q', `key in (${list.join(', ')})`, '--plain', '--columns', 'key,summary', '--no-headers'],
      { timeoutMs: 20000 },
    )

    if (ran.exitCode !== 0) {
      throw new Error('jira cli failed')
    }

    for (const [key, title] of parseJiraCli(ran.stdout)) {
      out.set(key, title)
    }
  }

  return out
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Summaries for `keys`, or `undefined` when no source answered (no verdict:
 * the keys are asked again next round). Probes MCP, then the CLI, on each
 * round until a source settles (see `jiraSource`).
 */
async function jiraTitles($: $, cfg: TrailConfig, keys: readonly string[], gen: number): Promise<Map<string, string> | undefined> {
  const server = cfg.atlassianServer

  if (jiraSource?.kind === 'mcp') {
    return jiraViaMcp($, server, cfg, keys)
  }

  const isCurrent = () => gen === generation

  if (isCurrent()) {
    probes += 1
  }

  // MCP whenever the rules allow it, even after settling on the CLI, so an allow
  // rule added mid-session takes effect. A disallowed check costs no call.
  try {
    const found = await jiraViaMcp($, server, cfg, keys)

    if (isCurrent()) {
      jiraSource = { kind: 'mcp', server }
      isJiraGivenUp = false
      jiraError = undefined
      mcpSkipReason = undefined
      lastJiraAnswer = 'mcp'
    }

    return found
  } catch (err) {
    if (isCurrent()) {
      mcpSkipReason = errorText(err)
    }
  }

  if (jiraSource?.kind === 'cli') {
    const found = await jiraViaCli($, keys)

    if (isCurrent()) {
      lastJiraAnswer = 'cli'
    }

    return found
  }

  // MCP gets until SETTLE_MS after startup to show up before the CLI, or nothing, is settled on.
  const canSettle = (await $.clock.now()) - startedAt >= SETTLE_MS

  try {
    const found = await jiraViaCli($, keys)

    if (isCurrent()) {
      jiraError = undefined
      lastJiraAnswer = 'cli'

      if (canSettle) {
        jiraSource = { kind: 'cli' }
        isJiraGivenUp = false
      }
    }

    return found
  } catch (err) {
    if (isCurrent()) {
      lastJiraAnswer = undefined
      jiraError = `jira cli: ${errorText(err)}`
      isJiraGivenUp = isJiraGivenUp || canSettle
    }

    return undefined
  }
}

/** A PR's title or an Actions run's workflow and title, from gh. */
async function githubTitle($: $, ref: TrailRef): Promise<Resolved | undefined> {
  const pr = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(ref.href)
  const run = /github\.com\/([\w.-]+\/([\w.-]+))\/actions\/runs\/(\d+)/.exec(ref.href)
  const argv = pr
    ? ['gh', 'pr', 'view', pr[2] ?? '', '--repo', pr[1] ?? '', '--json', 'title', '-q', '.title']
    : run
      ? ['gh', 'run', 'view', run[3] ?? '', '--repo', run[1] ?? '', '--json', 'number,workflowName,displayTitle,status,conclusion']
      : null

  if (argv === null) {
    return undefined
  }

  const ran = await $.process.run(argv, { timeoutMs: 15000 })

  if (ran.exitCode !== 0) {
    throw new Error((ran.stderr.trim().split('\n')[0] ?? '') || `gh exited ${ran.exitCode}`)
  }

  if (pr) {
    const title = ran.stdout.trim()

    return title !== '' ? { title } : undefined
  }

  // Runs go by their run number and workflow, like the Actions UI, not the long run id.
  const info = JSON.parse(ran.stdout) as { number?: number; workflowName?: string; displayTitle?: string; status?: string; conclusion?: string }
  const isFinal = info.status === 'completed'
  const mark = !isFinal ? '⏳' : info.conclusion === 'success' ? '✓' : info.conclusion === 'skipped' || info.conclusion === 'neutral' ? '–' : '✗'
  const repoName = ref.label.replace(/ run .*$/, '') || (run?.[2] ?? '')

  return {
    isFinal,
    label: info.number !== undefined ? `${repoName} run #${info.number}` : undefined,
    title: `${mark} ${[info.workflowName, info.displayTitle].filter(Boolean).join(': ')}`,
  }
}

/**
 * The incident.io connector's `incident_show` tool when it's connected and the
 * permission rules plainly allow it (checked first, so a background lookup
 * never prompts or meets auto mode's classifier); otherwise why not.
 */
async function incidentTool($: $): Promise<{ server: string } | { skip: string }> {
  const tool = (await $.tool.list()).map(one => one.name).find(name => /^mcp__[\w-]*incident[\w-]*__incident_show$/i.test(name))

  if (tool === undefined) {
    return { skip: 'no incident.io connector' }
  }

  const verdict = await $.tool.check({ input: { id: 'INC-1' }, tool })

  if (verdict.decision !== 'allow') {
    return { skip: `not allowed by permissions (${verdict.decision}); add "${tool}" to permissions.allow` }
  }

  return { server: tool.slice('mcp__'.length, -'__incident_show'.length) }
}

/** A failed incident lookup: `isAnswer` when it says the incident doesn't exist (settle it), else retry. */
class IncidentLookupError extends Error {
  constructor(
    message: string,
    readonly isAnswer: boolean,
  ) {
    super(message)
  }
}

/** An incident's name and status from incident.io, e.g. "checkout-api 5xx spike · Closed". */
async function incidentTitle($: $, server: string, reference: string): Promise<string> {
  // Checked again with the real argument, so a rule written for specific incidents is honoured.
  if ((await $.tool.check({ input: { id: reference }, tool: `mcp__${server}__incident_show` })).decision !== 'allow') {
    throw new IncidentLookupError(`not allowed by permissions for ${reference}`, false)
  }

  const ran = await Promise.race([
    $.mcp.call(server, 'incident_show', { id: reference }),
    $.clock.sleep(MCP_TIMEOUT_MS).then(() => 'timeout' as const),
  ])

  if (ran === 'timeout') {
    throw new Error(`no answer from ${server} within ${MCP_TIMEOUT_MS / 1000} s`)
  }

  const text = ran.content.map(block => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('\n')

  if (ran.isError) {
    // Only "not found" is an answer about this incident; anything else is the connector's problem.
    throw new IncidentLookupError(text.split('\n')[0] || 'incident lookup failed', /not found|no incident|does not exist|404/i.test(text))
  }

  let incident: { name?: string; status?: { name?: string } }

  try {
    incident = JSON.parse(text) as typeof incident
  } catch {
    throw new IncidentLookupError(`unexpected reply from ${server}: ${text.slice(0, 80)}`, false)
  }

  if (!incident.name) {
    throw new IncidentLookupError(`not found: ${reference}`, true)
  }

  return [incident.name, incident.status?.name].filter(Boolean).join(' · ')
}

/**
 * `/trail demo <file>`: a scripted sidebar for screencasts. The fixture's
 * links, status row and timed pop-ups go through the same atoms, toasts and
 * chimes as real ones; collecting, lookups and the session's own pop-ups
 * pause until `/trail demo off`. Unlisted in `/help`.
 */
let isDemo = false
/** Bumped by each demo start and stop, so an earlier demo's pending steps fire nothing. */
let demoRun = 0
/** The `toastSeconds` setting, put back when a demo with its own ends. */
let toastMsBeforeDemo: number | undefined

type DemoRef = Pick<TrailRef, 'kind' | 'label' | 'href'> & Partial<Pick<TrailRef, 'role' | 'title' | 'isStarred'>> & {
  /** Minutes before the demo starts that it was last seen (smaller sorts higher). */
  ago?: number
}

type DemoStep = {
  /** Seconds after the demo starts. */
  at: number
  /** Added, or updated by kind and label (a new title marks it changed). */
  ref?: DemoRef
  toast?: string
  /** Where the status row's latest-event link goes. */
  href?: string
  sound?: 'created' | 'merged' | 'failed'
  /**
   * A sidebar action played as if clicked, so a recording needs no hands:
   * `star`/`unstar` an item (`target`: its label), `collapse`/`expand` a section
   * or show `more`/`less` of it (`target`: jira, pr, inc, build, run or doc),
   * `type` `text` into the filter a key at a time, `clear` it, `hide`/`show` the sidebar,
   * or press the footer's `copyResume`/`copyLinks` (it really copies, with its pop-up).
   */
  do?: 'star' | 'unstar' | 'collapse' | 'expand' | 'more' | 'less' | 'type' | 'clear' | 'hide' | 'show' | 'copyResume' | 'copyLinks'
  target?: string
  text?: string
}

type DemoFile = {
  /** How long the demo's pop-ups stay, so a tight script's don't stack up; the setting returns after. */
  toastSeconds?: number
  status?: Partial<TrailStatus> & { ageMinutes?: number; fiveHourResetsInMinutes?: number }
  refs: DemoRef[]
  script?: DemoStep[]
}

function demoRef(one: DemoRef, now: number, was?: TrailRef): TrailRef {
  const at = now - (one.ago ?? 0) * 60_000
  const role = one.role ?? was?.role ?? 'mentioned'
  const isChanged = was !== undefined && (was.title !== one.title || was.role !== role)

  return {
    changedAt: isChanged ? now : was?.changedAt,
    firstSeen: was?.firstSeen ?? at,
    hits: (was?.hits ?? 0) + 1,
    href: one.href,
    id: `demo:${one.kind}:${one.label}`,
    isDismissed: was?.isDismissed ?? false,
    isStarred: was?.isStarred ?? one.isStarred === true,
    isTitleTried: true,
    kind: one.kind,
    label: one.label,
    lastSeen: at,
    role,
    title: one.title ?? was?.title,
  }
}

async function homeDir($: $): Promise<string> {
  const ran = await $.process.run(['printenv', 'HOME'], { timeoutMs: 5000 })

  return ran.stdout.trim()
}

/**
 * The samples the plugin ships, by name: `sample` (also nothing, `1`) plays about
 * two minutes, `short` about 30 seconds for a GIF. Anything else is a path.
 */
function sampleDemo(path: string): string | undefined {
  const name = path.trim().toLowerCase()

  return ['', '1', 'sample', 'true'].includes(name) ? 'sample' : name === 'short' ? 'short' : undefined
}

async function startDemo($: $, request: string, style: StatusStyle): Promise<string> {
  // `… manual` plays the data and pop-ups but leaves the clicking to you (for a recorder's zooms).
  const isManual = /(^|\s)(--)?manual$/i.test(request.trim())
  const path = request.trim().replace(/(^|\s)(--)?manual$/i, '').trim()
  const sample = sampleDemo(path)
  const full = sample !== undefined ? `${$.plugin.root}/demo/${sample}.json` : path.startsWith('~/') ? `${await homeDir($)}${path.slice(1)}` : path
  const file = JSON.parse(await $.fs.read(full)) as DemoFile

  if (!Array.isArray(file.refs)) {
    throw new Error('no "refs" list')
  }

  const run = ++demoRun
  const now = await $.clock.now()
  const { ageMinutes, fiveHourResetsInMinutes, ...given } = file.status ?? {}
  const real = await read($, statusAtom)

  isDemo = true
  pending = []
  toastMsBeforeDemo ??= toastMs

  if (typeof file.toastSeconds === 'number' && file.toastSeconds > 0) {
    toastMs = Math.min(60, Math.max(2, file.toastSeconds)) * 1000
  }
  await update($, statusAtom, () => ({
    contextPercent: null,
    contextWindow: null,
    dir: '',
    fiveHourPercent: null,
    git: null,
    model: '',
    repo: null,
    ...real,
    sessionId: real?.sessionId ?? '',
    ...given,
    fiveHourResetsAt: fiveHourResetsInMinutes !== undefined ? new Date(now + fiveHourResetsInMinutes * 60_000).toISOString() : (given.fiveHourResetsAt ?? real?.fiveHourResetsAt ?? null),
    startedAt: ageMinutes !== undefined ? now - ageMinutes * 60_000 : (given.startedAt ?? real?.startedAt ?? null),
  }))
  await update($, refsAtom, () => file.refs.map(one => demoRef(one, now)))
  // Only what the script adds or changes gets a dot.
  await update($, freshSinceAtom, () => now + 1)
  await update($, latestAtom, () => null)
  await update($, filterAtom, () => '')
  // Every take starts from the same sidebar: all sections open, none expanded.
  await update($, collapsedAtom, () => [])
  await update($, expandedAtom, () => [])
  await update($, jiraHelpAtom, () => '')
  await update($, loadingAtom, () => false)
  await openPane($, style)

  const steps = (file.script ?? []).filter(step => !(isManual && step.do !== undefined))

  for (const step of steps) {
    $.clock.after(Math.max(0, step.at) * 1000, () => {
      if (run === demoRun) {
        void playDemoStep($, step, style, run).catch(() => undefined)
      }
    })
  }

  const last = Math.max(0, ...steps.map(step => step.at))

  return `Trail demo${isManual ? ' (manual)' : ''}: ${file.refs.length} items${steps.length > 0 ? `, ${steps.length} steps over ${last}s` : ''}. \`/trail demo off\` returns to this session's own links.`
}

/**
 * `TRAIL_DEMO=<fixture.json> claude` starts the demo at load, so a recording
 * shows no `/trail demo` line in the transcript.
 */
async function demoFromEnv($: $, style: StatusStyle): Promise<boolean> {
  const ran = await $.process.run(['printenv', 'TRAIL_DEMO'], { timeoutMs: 5000 }).catch(() => null)
  const path = ran?.exitCode === 0 ? ran.stdout.trim() : ''

  if (path === '') {
    return false
  }

  try {
    await startDemo($, path, style)

    return true
  } catch (err) {
    $.ui.toast(`Trail demo: couldn't load ${path}: ${errorText(err)}`, { timeoutMs: toastMs })

    return false
  }
}

/** A scripted sidebar action; nothing it changes is saved (stars, collapsed sections). */
async function playDemoAction($: $, step: DemoStep, style: StatusStyle, run: number): Promise<void> {
  const target = step.target ?? ''
  const toggle = (list: readonly string[], isOn: boolean) => (isOn ? [...list.filter(one => one !== target), target] : list.filter(one => one !== target))

  switch (step.do) {
    case 'star':
    case 'unstar':
      await update($, refsAtom, list => list.map(one => (one.label === target ? { ...one, isStarred: step.do === 'star' } : one)))
      break
    case 'collapse':
    case 'expand':
      await update($, collapsedAtom, list => toggle(list, step.do === 'collapse'))
      break
    case 'more':
    case 'less':
      await update($, expandedAtom, list => toggle(list, step.do === 'more'))
      break
    case 'type': {
      const text = step.text ?? ''

      for (let i = 1; i <= text.length; i++) {
        $.clock.after(i * 160, () => {
          if (run === demoRun) {
            void update($, filterAtom, () => text.slice(0, i)).catch(() => undefined)
          }
        })
      }

      break
    }
    case 'clear':
      await update($, filterAtom, () => '')
      break
    // Straight to the pane, not hidePane/openPane: those remember the choice for later sessions.
    case 'hide':
      await $.ui.close({ id: PANE })
      await paintStatus($, style)
      break
    case 'show':
      await $.ui.open({ columns: PANE_COLUMNS, id: PANE, title: TITLE })
      await paintStatus($, style)
      break
    case 'copyResume':
      await copyResume($)
      break
    case 'copyLinks':
      await copyMarkdown($)
      break
    default:
      break
  }
}

async function playDemoStep($: $, step: DemoStep, style: StatusStyle, run: number): Promise<void> {
  const { ref } = step

  if (step.do !== undefined) {
    await playDemoAction($, step, style, run)
  }

  if (ref !== undefined) {
    const now = await $.clock.now()
    const id = `demo:${ref.kind}:${ref.label}`

    await update($, refsAtom, list => {
      const was = list.find(one => one.id === id)

      return was === undefined ? [...list, demoRef(ref, now)] : list.map(one => (one.id === id ? demoRef(ref, now, was) : one))
    })
  }

  if (step.toast !== undefined) {
    notify($, step.toast, step.href)
  }

  if (step.sound !== undefined) {
    chime($, step.sound)
  }

  await paintStatus($, style)
}

/** Ids the last `/trail clean` hid, for `/trail clean undo` (this run of the session only). */
let lastCleaned: string[] = []

const CLEAN_USAGE = 'Usage: /trail clean <age> [--yes] hides items with no activity in that long (30m, 4h, 2d, 1w, 1d12h); /trail clean all [--yes] hides everything but starred; /trail clean undo brings the last cleanup back.'

/** `/trail clean <age>` (or `all`, every unstarred item): a preview, or with --yes the same as pressing × on each stale item. */
async function clean($: $, words: readonly string[], style: StatusStyle): Promise<string> {
  if (words[0]?.toLowerCase() === 'undo') {
    if (lastCleaned.length === 0) {
      return 'Trail clean: nothing to undo.'
    }

    const ids = new Set(lastCleaned)

    lastCleaned = []
    await update($, refsAtom, list => list.map(one => (ids.has(one.id) ? { ...one, isDismissed: false } : one)))
    await saveMarks($, await read($, refsAtom))
    await paintStatus($, style)

    return `Trail clean undone: ${ids.size} items back.`
  }

  const age = words.find(word => !word.startsWith('-')) ?? ''
  const isAll = age.toLowerCase() === 'all'
  const ms = isAll ? Infinity : parseDuration(age)

  if (ms === null) {
    return CLEAN_USAGE
  }

  const isYes = words.some(word => /^(--yes|-y)$/i.test(word))
  const shown = (await shownRefs($)).filter(one => !one.isDismissed)
  const stale = staleRefs(shown, isAll ? Infinity : (await $.clock.now()) - ms)
  const kept = shown.length - stale.length
  const which = isAll ? 'unstarred items' : `items not active in the last ${age}`

  if (stale.length === 0) {
    return isAll ? 'Trail clean: every shown item is starred; nothing to hide.' : `Trail clean: every shown item was active in the last ${age} (or is starred); nothing to hide.`
  }

  if (!isYes) {
    const lines = [
      `Would hide ${stale.length} of ${shown.length} ${which}, leaving ${kept}. Starred items are kept.`,
      '',
      ...groupRefs(stale).map(([kind, refs]) => `- ${KIND_TITLE[kind]} ${refs.length}: ${refs.slice(0, 4).map(one => one.label).join(', ')}${refs.length > 4 ? ', …' : ''}`),
      '',
      `\`/trail clean ${isAll ? 'all' : age} --yes\` hides them; \`/trail clean undo\` brings them back.`,
    ]

    // Ages rebuilt from the live message list (the transcript couldn't be read) are all about load time.
    if (!isAll && backfillSource === 'messages') {
      lines.push('Note: this session was rebuilt without its transcript, so older items count from when it loaded.')
    }

    return lines.join('\n')
  }

  const ids = new Set(stale.map(one => one.id))

  lastCleaned = [...ids]
  await update($, refsAtom, list => list.map(one => (ids.has(one.id) ? { ...one, isDismissed: true } : one)))
  await saveMarks($, await read($, refsAtom))
  await paintStatus($, style)

  return `Hid ${ids.size} ${which}: ${shown.length} → ${kept} shown. \`/trail clean undo\` brings them back.`
}

/** What a pop-up calls an item, so "… created" says what was created: `PR acme-api #12`, `Jira PROJ-4`. */
function popupName(one: Pick<TrailRef, 'kind' | 'label'>): string {
  switch (one.kind) {
    case 'pr':
      return `PR ${one.label}`
    case 'jira':
      return `Jira ${one.label}`
    case 'inc':
      return `Incident ${one.label}`
    case 'build':
    case 'run':
      return `${buildNoun(one.kind)} ${one.label}`
    default:
      // Artifacts are labelled "Artifact …" already; Confluence pages by their title.
      return one.label.startsWith('Artifact ') ? one.label : `Confluence page ${one.label}`
  }
}

/** What a pop-up calls a build or run, so "✓ … succeeded" says what succeeded. */
function buildNoun(kind: TrailRef['kind']): string {
  return kind === 'run' ? 'GitHub Actions' : 'TeamCity build'
}

/** Pop-ups for builds and Actions runs that started or finished since the last lookup of them. */
function announceBuilds($: $, prior: ReadonlyMap<string, TrailRef>, found: ReadonlyMap<string, Resolved>): void {
  let sound: 'merged' | 'failed' | undefined

  for (const [id, got] of found) {
    const was = prior.get(id)

    if (was === undefined || (was.kind !== 'build' && was.kind !== 'run') || was.isDismissed || got.title === undefined) {
      continue
    }

    const label = `${buildNoun(was.kind)} ${got.label ?? was.label}`
    const wasRunning = was.title?.startsWith('⏳') === true
    const isRunning = got.title.startsWith('⏳')

    const isFinishedNow = !isRunning && (wasRunning || (was.title === undefined && was.role === 'created'))

    if (isRunning && was.title === undefined) {
      // Claude started it: "starting" already went up when the command ran.
      if (!announced.has(`start:${id}`)) {
        announced.add(`start:${id}`)
        notify($, `🔨 ${label} started`, got.href ?? was.href)
      }
    } else if (isFinishedNow && !announced.has(`finish:${id}`)) {
      // Finished since the last look, or a build Claude started that finished before the first one.
      announced.add(`finish:${id}`)
      const isGood = got.title.startsWith('✓')

      notify($, `${isGood ? '✓' : got.title.startsWith('–') ? '–' : '✗'} ${label} ${isGood ? 'succeeded' : got.title.startsWith('–') ? 'finished' : 'failed'}`, got.href ?? was.href)
      sound = isGood || sound === 'merged' ? 'merged' : (sound ?? 'failed')
    }
  }

  if (sound !== undefined) {
    chime($, sound)
  }
}

/** Refs still waiting on a lookup round (untitled, or a build not yet finished). */
async function waitingCount($: $): Promise<number> {
  return (await read($, refsAtom)).filter(one => !one.isDismissed && !one.isTitleTried && one.kind !== 'doc').length
}

/**
 * Runs lookup rounds back to back until nothing is left waiting, a round makes
 * no progress (offline, a source not settled yet, builds still running), or
 * `maxRounds` is reached: on load this drains a resumed session's backlog in
 * seconds instead of one batch per turn.
 */
async function drainTitles($: $, cfg: TrailConfig, gen: number, maxRounds: number): Promise<void> {
  for (let round = 0; round < maxRounds && gen === generation; round++) {
    const before = await waitingCount($)

    if (before === 0) {
      return
    }

    await resolveTitles($, cfg, gen)

    if ((await waitingCount($)) >= before) {
      return
    }
  }
}

/** Looks up missing titles (tickets, PRs, runs, incidents) and build statuses in the background, a batch at a time. */
async function resolveTitles($: $, cfg: TrailConfig, gen = generation, onlyKinds?: readonly TrailRef['kind'][]): Promise<void> {
  // `gen` is the session the caller scheduled this for, not whichever is current by now.
  if (isResolving || gen !== generation || isDemo) {
    return
  }

  isResolving = true

  try {
    // Builds are asked again until they finish, so a running one picks up its final status.
    const wanted = sortRefs(
      (await read($, refsAtom)).filter(
        one =>
          !one.isDismissed &&
          !one.isTitleTried &&
          (one.title === undefined || one.kind === 'build' || one.kind === 'run') &&
          (onlyKinds === undefined || onlyKinds.includes(one.kind)),
      ),
    )
    const keys = wanted.filter(one => one.kind === 'jira' && one.title === undefined).slice(0, 50)
    // Separate batches, so a backlog of untitled PRs can't starve Actions runs.
    const prs = [
      ...wanted.filter(one => one.kind === 'pr' && one.title === undefined).slice(0, 8),
      // Runs are asked again until they complete, as builds are, so ⏳ turns into ✓ or ✗.
      ...wanted.filter(one => one.kind === 'run').slice(0, 8),
    ]
    const builds = wanted.filter(one => one.id.startsWith('build:tc/')).slice(0, 8)
    const incidents = wanted.filter(one => one.kind === 'inc' && one.title === undefined).slice(0, 5)
    const incidentSource = incidents.length > 0 ? await incidentTool($).catch(err => ({ skip: errorText(err) })) : undefined

    if (incidentSource !== undefined && gen === generation) {
      incidentSkipReason = 'skip' in incidentSource ? incidentSource.skip : undefined
    }
    const found = new Map<string, Resolved>()
    const settled = new Set<string>()
    let ghSuccesses = 0
    let ghTransient: string | undefined
    let isJiraAnswered = false

    if (keys.length > 0) {
      const byKey = await jiraTitles($, cfg, keys.map(one => one.label), gen).catch(err => {
        if (gen === generation) {
          jiraError = errorText(err)
          lastJiraAnswer = undefined
        }

        return undefined
      })

      isJiraAnswered = byKey !== undefined

      if (isJiraAnswered && gen === generation && jiraSource !== undefined) {
        jiraError = undefined
      }

      for (const one of keys) {
        const title = byKey?.get(one.label)

        if (title !== undefined) {
          found.set(one.id, { title })
        }

        if (isJiraAnswered) {
          settled.add(one.id)
        }
      }
    }

    await Promise.all([
      ...prs.map(async one => {
        try {
          const info = await githubTitle($, one)

          ghSuccesses += 1
          isGhMissing = false

          if (info?.isFinal !== false) {
            settled.add(one.id)
          }

          if (info !== undefined) {
            found.set(one.id, info)
          }
        } catch (err) {
          const message = errorText(err)

          if (isMissingTool(message) && gen === generation) {
            isGhMissing = true
          }

          // Offline or signed out says nothing about this PR: ask again later.
          // Anything else (a deleted PR, a private repo, a typo) is its answer.
          if (isTransientError(message)) {
            ghTransient = ghTransient ?? message
          } else {
            settled.add(one.id)
          }
        }
      }),
      ...(incidentSource !== undefined && 'server' in incidentSource ? incidents : []).map(async one => {
        try {
          found.set(one.id, { title: await incidentTitle($, (incidentSource as { server: string }).server, one.label) })
          settled.add(one.id)

          if (gen === generation) {
            incidentError = undefined
          }
        } catch (err) {
          // Only an answer that the incident doesn't exist settles it (hidden); a dropped
          // connector, an auth error or an odd reply is retried and reported, never "not found".
          if (err instanceof IncidentLookupError && err.isAnswer) {
            settled.add(one.id)
          } else if (gen === generation) {
            incidentError = errorText(err)
          }
        }
      }),
      ...builds.map(async one => {
        try {
          const info = await teamcityBuild($, one.id.slice('build:tc/'.length))

          found.set(one.id, info)

          if (info.isFinal) {
            settled.add(one.id)
          }

          if (gen === generation) {
            tcError = undefined
            isTeamcityMissing = false
          }
        } catch (err) {
          const message = errorText(err)

          if (isMissingTool(message) && gen === generation) {
            isTeamcityMissing = true
          }

          if (!isTransientError(message)) {
            settled.add(one.id)
          } else if (gen === generation) {
            tcError = message
          }
        }
      }),
    ])

    // A session ended while this ran: its results belong to no one now.
    if (gen !== generation) {
      return
    }

    // gh is reported failing only while lookups fail for reasons that aren't the PR's own.
    ghError = ghSuccesses > 0 ? undefined : (ghTransient ?? (prs.length > 0 ? undefined : ghError))

    if (settled.size > 0 || found.size > 0) {
      const now = await $.clock.now()
      const prior = new Map((await read($, refsAtom)).map(one => [one.id, one]))

      await update($, refsAtom, list =>
        list.map(one => {
          const got = found.get(one.id)

          if (!settled.has(one.id) && got === undefined) {
            return one
          }

          const label = got?.label ?? one.label
          const title = got?.title ?? one.title
          const isChanged = (one.title !== undefined && title !== one.title) || label !== one.label

          return {
            ...one,
            changedAt: isChanged ? now : one.changedAt,
            href: got?.href ?? one.href,
            isTitleTried: settled.has(one.id),
            label,
            title,
          }
        }),
      )

      if (isLive) {
        announceBuilds($, prior, found)
      }
    }
  } finally {
    if (gen === generation) {
      isResolving = false
    }
  }

  if (gen === generation) {
    await updateJiraHelp($, cfg).catch(() => undefined)
  }
}

type Resolved = { title?: string; label?: string; href?: string; isFinal?: boolean }

/** A TeamCity build's job, number, status and branch from `teamcity run view --json`; final once it has finished. */
async function teamcityBuild($: $, id: string): Promise<Resolved> {
  const ran = await $.process.run(['teamcity', 'run', 'view', id, '--json'], { timeoutMs: 15000 })

  if (ran.exitCode !== 0) {
    // With --json the CLI reports failures on stdout: { error: { code, message } }.
    let reported: string | undefined

    try {
      const body = JSON.parse(ran.stdout) as { error?: { code?: string; message?: string } }

      reported = body.error ? `${body.error.code === 'not_found' ? 'not found: ' : ''}${body.error.message ?? body.error.code ?? ''}` : undefined
    } catch {
      reported = undefined
    }

    throw new Error(reported || (ran.stderr.trim().split('\n')[0] ?? '') || `teamcity exited ${ran.exitCode}`)
  }

  const build = JSON.parse(ran.stdout) as {
    webUrl?: string
    number?: string
    status?: string
    state?: string
    statusText?: string
    branchName?: string
    buildType?: { name?: string }
  }
  const isFinal = build.state === 'finished'
  const mark = !isFinal ? '⏳' : build.status === 'SUCCESS' ? '✓' : '✗'
  // `statusText` can be a job's whole parameter list; the plain status reads better.
  const status = !isFinal ? (build.state ?? 'running') : build.status === 'SUCCESS' ? 'Success' : build.status === 'FAILURE' ? 'Failed' : (build.status ?? '')
  const title = [`${mark} ${status}`.trim(), build.branchName].filter(Boolean).join(' · ')

  return {
    href: build.webUrl,
    isFinal,
    label: build.buildType?.name ? `${build.buildType.name} #${build.number ?? id}` : undefined,
    title,
  }
}

/**
 * What the Jira section should say about lookups, recomputed every round (a
 * rules lookup, no call), so it appears and clears with the situation:
 * `blocked`/`denied`/`unavailable` when titles can't be had at all, and
 * `fallback` when the Atlassian MCP is connected but its search isn't allowed
 * while the jira CLI covers (hideable; the choice is remembered).
 */
async function updateJiraHelp($: $, cfg: TrailConfig): Promise<void> {
  const tool = mcpToolName(cfg.atlassianServer, 'searchJiraIssuesUsingJql')
  let verdict: string | undefined

  if (jiraSource?.kind !== 'mcp' && (await $.tool.list()).some(one => one.name === tool)) {
    verdict = (await $.tool.check({ input: {}, tool })).decision
  }

  mcpBlockedTool = verdict === 'ask' || verdict === 'deny' ? tool : undefined
  mcpVerdict = verdict === 'ask' || verdict === 'deny' ? verdict : undefined

  // Keys Jira already answered as nonexistent aren't waiting for anything.
  const isWaiting = (await read($, refsAtom)).some(one => one.kind === 'jira' && !one.isDismissed && one.title === undefined && !one.isTitleTried)
  // Stuck: nothing will title the waiting keys (gave up, or a settled CLI that has stopped answering).
  const isStuck = isWaiting && (isJiraGivenUp || (jiraSource?.kind === 'cli' && lastJiraAnswer !== 'cli'))
  const isNoteHidden = (await $.store.get('mcpNoteHidden')) === true
  const help =
    jiraSource?.kind === 'mcp'
      ? ''
      : verdict === 'ask'
        ? isStuck
          ? 'blocked'
          : lastJiraAnswer === 'cli' && !isNoteHidden
            ? 'fallback'
            : ''
        : verdict === 'deny'
          ? isStuck
            ? 'denied'
            : ''
          : isStuck
            ? 'unavailable'
            : ''

  await update($, jiraHelpAtom, was => (was === help ? was : help))
}

export const register: Register = (on, options) => {
  const accent = ACCENTS[String(options.accent ?? 'blue')] ?? '#5fafd7'
  const style = (['bottom', 'band', 'off'].includes(String(options.statusStyle)) ? String(options.statusStyle) : 'band') as StatusStyle
  const limits = parseLimits(String(options.sectionLimits ?? ''))

  isSoundOn = options.sounds !== false
  toastMs = Math.min(60, Math.max(2, Number(options.toastSeconds ?? 8) || 8)) * 1000
  // Empty settings are detected at load (see detectSettings); set ones always win.
  const cfg: TrailConfig = {
    atlassianServer: String(options.atlassianServer ?? '') || 'claude.ai Atlassian',
    githubOrg: String(options.githubOrg ?? '').trim(),
    incidentOrg: String(options.incidentOrg ?? '').trim(),
    jiraBaseUrl: String(options.jiraBaseUrl ?? '').trim(),
    jiraProjects: parseProjects(String(options.jiraProjects ?? '')),
    teamcityUrl: String(options.teamcityUrl ?? '').trim(),
  }
  const configured: Configured = {
    githubOrg: cfg.githubOrg !== '',
    incidentOrg: cfg.incidentOrg !== '',
    jiraBaseUrl: cfg.jiraBaseUrl !== '',
    jiraProjects: cfg.jiraProjects.length > 0,
    teamcityUrl: cfg.teamcityUrl !== '',
  }

  for (const [key, isSet] of Object.entries(configured)) {
    if (isSet) {
      settingSources.set(key, 'setting')
    }
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await $.command.register({
      argumentHint: '[md | resume | restore | status | clean <age>|all | demo [short|file|off] [manual]]',
      description: 'Show or hide the Trail sidebar; `md` prints it as markdown, `resume` copies the resume command, `restore` un-hides dismissed items, `status` shows lookup state, `clean 2d` hides items idle that long (`clean all`: all but starred), `demo` plays sample data',
      name: 'trail',
    })

    startedAt = await $.clock.now()

    const collapsedKinds = ((await $.store.get('collapsedKinds')) as string[] | undefined) ?? []

    await update($, collapsedAtom, () => collapsedKinds)
    repo = await repoHint($).catch(() => null)

    // PRs in the session repo's org show as `repo #N`.
    if (!configured.githubOrg && repo !== null) {
      cfg.githubOrg = repo.split('/')[0] ?? ''
      settingSources.set('githubOrg', "the session's repo")
    }

    // Last load's findings first, so history is read with them; detection refreshes them.
    const cached = ((await $.store.get('detected')) as Detected | undefined) ?? {}
    const hasCache = Object.keys(cached).length > 0

    applyDetected(cfg, configured, cached, 'detected (remembered)')
    await refreshStatus($, style).catch(() => undefined)
    // A long session's transcript is tens of MB: read it off the startup path, then fetch titles.
    const gen = generation

    $.clock.after(0, () => {
      // With nothing remembered, detect before reading history; otherwise refresh alongside.
      const detecting = detectSettings($, cfg, configured).catch(() => undefined)

      void (hasCache ? Promise.resolve() : detecting)
        .then(() => demoFromEnv($, style))
        .then(isDemoing => (isDemoing ? undefined : backfill($, cfg, style, gen)))
        .catch(() => undefined)
        .then(() => drainTitles($, cfg, gen, 10))
        // What a session already had isn't news: nothing is marked until the first turn's update.
        .then(async () => {
          const loadedAt = await $.clock.now()

          isLive = true

          // Already created before this load: a later republish (an artifact update) isn't news.
          for (const one of await read($, refsAtom)) {
            if (one.role === 'created') {
              announced.add(one.id)
            }
          }

          // A message sent during a slow load has already set the window; keep its marks.
          if (!hasPrompted) {
            await update($, freshSinceAtom, () => loadedAt)
          }
        })
        .catch(() => undefined)
    })
    // The rest happens at turn end; this only keeps the rate-limit countdown honest while idle.
    // While a build or run is still going, check just those every minute so its finish is
    // announced promptly even between turns; with nothing running this does nothing.
    $.clock.every(60_000, () => {
      // A long turn's mentions shouldn't wait for it to end: catch up once a minute when anything is queued.
      if (pending.length > 0) {
        void flush($, cfg, style).catch(() => undefined)
      }

      void read($, refsAtom)
        .then(list => {
          const isAnythingRunning = list.some(
            one => (one.kind === 'build' || one.kind === 'run') && !one.isDismissed && !one.isTitleTried && one.title?.startsWith('⏳') === true,
          )

          // Builds and runs only: the other lookups keep to load and turn end.
          return isAnythingRunning ? resolveTitles($, cfg, generation, ['build', 'run']) : undefined
        })
        .catch(() => undefined)
    })
    $.clock.every(5 * 60_000, () => {
      void refreshStatus($, style).catch(() => undefined)
      void resolveTitles($, cfg).catch(() => undefined)
    })

    if (e.isInteractive && (await $.store.get('autoOpen')) !== false) {
      void $.ui.open({ columns: PANE_COLUMNS, id: PANE, title: TITLE })
    }

    return started
  })

  on('command.run', { command: 'trail' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)

    if (verb.toLowerCase() === 'clean') {
      return { text: await clean($, rest, style) }
    }

    if (verb.toLowerCase() === 'demo') {
      const target = rest.join(' ')

      if (target.toLowerCase() === 'off') {
        if (!isDemo) {
          return { text: 'Trail demo: not running.' }
        }

        isDemo = false
        demoRun += 1
        toastMs = toastMsBeforeDemo ?? toastMs
        toastMsBeforeDemo = undefined
        await update($, refsAtom, () => [])
        await update($, builtAtom, () => 0)
        await update($, latestAtom, () => null)
        await update($, freshSinceAtom, () => Number.MAX_SAFE_INTEGER)
        await update($, filterAtom, () => '')
        await update($, expandedAtom, () => [])
        const collapsedKinds = ((await $.store.get('collapsedKinds')) as string[] | undefined) ?? []

        await update($, collapsedAtom, () => collapsedKinds)
        await refreshStatus($, style).catch(() => undefined)

        const gen = generation

        $.clock.after(0, () => {
          void backfill($, cfg, style, gen)
            .catch(() => undefined)
            .then(() => drainTitles($, cfg, gen, 10))
            .catch(() => undefined)
        })

        return { text: "Trail demo off: reloading this session's links." }
      }

      try {
        return { text: await startDemo($, target, style) }
      } catch (err) {
        return { text: `Trail demo: couldn't load ${target || 'the sample'}: ${errorText(err)}` }
      }
    }

    if (arg === 'md' || arg === 'markdown') {
      return { text: toMarkdown(await shownRefs($)) }
    }

    if (arg === 'resume') {
      await copyResume($)

      return { text: `claude --resume ${(isDemo ? (await read($, statusAtom))?.sessionId : undefined) || (await $.session.id())}` }
    }

    if (arg === 'status') {
      const refs = await read($, refsAtom)
      const source =
        jiraSource?.kind === 'mcp'
          ? `mcp (${jiraSource.server})`
          : jiraSource?.kind === 'cli'
            ? 'jira cli'
            : isJiraGivenUp
              ? `none answered (keys show unconfirmed; still retrying, ${probes} probes)`
              : lastJiraAnswer === 'cli'
                ? 'jira cli (answering; MCP still preferred if it becomes allowed)'
                : `probing (${probes} so far)`
      const setting = (key: string, value: string) => `${value || 'off (not set, not detected)'}${value ? ` — ${settingSources.get(key) ?? 'detected'}` : ''}`
      const lines = [
        `github org: ${setting('githubOrg', cfg.githubOrg)}`,
        `jira site: ${setting('jiraBaseUrl', cfg.jiraBaseUrl)}`,
        `jira projects: ${setting('jiraProjects', cfg.jiraProjects.length > 12 ? `${cfg.jiraProjects.slice(0, 12).join(', ')} +${cfg.jiraProjects.length - 12}` : cfg.jiraProjects.join(', '))}`,
        `teamcity: ${setting('teamcityUrl', cfg.teamcityUrl)}`,
        `incident.io org: ${setting('incidentOrg', cfg.incidentOrg)}`,
        `items: ${refs.length} (${(await shownRefs($)).length} shown, ${refs.filter(one => one.isDismissed).length} dismissed)`,
        `jira titles: ${source}${jiraError ? ` — last error: ${jiraError}` : ''}`,
        `atlassian mcp: ${jiraSource?.kind === 'mcp' ? (jiraError ? `in use, last round failed — ${jiraError}` : 'in use') : (mcpSkipReason ?? 'not tried yet')}`,
        `gh titles: ${ghError ? `failing — ${ghError}` : 'ok'}`,
        `teamcity builds: ${tcError ? `failing — ${tcError}` : 'ok'}`,
        `incident titles: ${incidentSkipReason ?? (incidentError ? `incident.io, failing — ${incidentError}` : 'incident.io')}`,
        `waiting for a title: ${refs.filter(one => one.title === undefined && !one.isTitleTried && one.kind !== 'doc').length}`,
        `queued until turn end: ${pending.length}`,
        `backfill: ${
          backfillSource === 'transcript'
            ? 'from the transcript file'
            : backfillSource === 'messages'
              ? `from the message list (${backfillError ?? 'transcript unreadable'})`
              : backfillSource === 'skipped'
                ? 'not needed (trail already filled)'
                : 'not run yet'
        }`,
      ]

      return { text: lines.join('\n') }
    }

    if (arg === 'restore') {
      await restoreAll($, style)
      await openPane($, style)

      return { text: 'Trail: dismissed items restored.' }
    }

    // From the phone (Remote Control): the app docks no sidebar, so toggling would only
    // flip the terminal's pane out of sight. Answer with the links instead.
    if (e.origin.kind === 'bridge') {
      return { text: toMarkdown(await shownRefs($)) }
    }

    if (arg !== '') {
      return { text: `Unknown: /trail ${e.args.trim()}. Try /trail, md, resume, status, restore, clean <age>|all [--yes], clean undo, or demo [short|off].` }
    }

    return { text: (await togglePane($, style)) ? 'Trail shown.' : 'Trail hidden. /trail shows it again.' }
  })

  // A /clear or a new session in this process starts clean: nothing queued or probed carries over.
  on('session.end', async ($, e, next) => {
    generation += 1
    isDemo = false
    demoRun += 1
    lastCleaned = []
    toastMs = toastMsBeforeDemo ?? toastMs
    toastMsBeforeDemo = undefined
    // Until the next session.start, nothing may count as having waited long enough to settle.
    startedAt = await $.clock.now()
    pending = []
    announced = new Set()
    isLive = false
    buildNumbers = new Map()
    hasPrompted = false
    isFlushScheduled = false
    await update($, latestAtom, () => null)
    await update($, freshSinceAtom, () => Number.MAX_SAFE_INTEGER)
    jiraSource = undefined
    isJiraGivenUp = false
    jiraError = undefined
    probes = 0
    isResolving = false
    backfillError = undefined
    backfillSource = undefined
    mcpSkipReason = undefined
    tcError = undefined
    isGhMissing = false
    isTeamcityMissing = false
    incidentSkipReason = undefined
    incidentError = undefined
    mcpBlockedTool = undefined
    mcpVerdict = undefined
    lastJiraAnswer = undefined
    ghError = undefined

    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)

    if (e.origin.kind === 'person') {
      await $.store.set('autoOpen', false)
    }

    await paintStatus($, style)

    return closed
  })

  on('prompt.submit', ($, e, next) => {
    // Only what a person sent: a subagent's report, a peer's message or a task notification
    // quotes docs and examples (`INC-123`, `…/repo/pull/123`) that aren't this session's work.
    if (PERSON_ORIGINS.has(e.origin.kind)) {
      queue(findRefs(e.text, cfg))
    }

    // Sending a message means you've seen the marks: clear them now (scheduled, so the prompt
    // isn't held up). What this turn adds or changes is marked when it lands, until the next one.
    hasPrompted = true
    $.clock.after(0, () => {
      void $.clock
        .now()
        .then(async sentAt => {
          await update($, freshSinceAtom, () => sentAt)
          await update($, latestAtom, () => null)
        })
        .catch(() => undefined)
    })

    return next(e)
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)

    if (e.door === 'response' && e.agentId === undefined && Array.isArray(e.message.content)) {
      const text = e.message.content
        .map(block => (block.type === 'text' ? block.text : ''))
        .join('\n')

      queue([...findRefs(text, cfg), ...buildNumberRefs(text, buildNumbers, cfg)])
    }

    return stored
  })

  on('tool.call', async ($, e, next) => {
    // A demo plays its own pop-ups: Claude's real work announces nothing while it runs.
    if (isDemo) {
      return next(e)
    }

    // A build start is announced as Claude starts it: with --watch the command only returns
    // once the build has finished, so after the call would be too late.
    const startCommand = String(e.tool) === 'Bash' && e.agentId === undefined ? String((e as { command?: unknown }).command ?? '') : ''
    const startJob = /\bteamcity\b/.test(startCommand) ? teamcityStartJob(startCommand) : undefined

    if (startJob !== undefined) {
      notify($, `🔨 TeamCity build ${startJob} starting`, cfg.teamcityUrl ? `${cfg.teamcityUrl.replace(/\/+$/, '')}/buildConfiguration/${startJob}` : undefined)
    }

    const ran = await next(e)

    try {
      const { tool, tool_use_id: _id, agentId, ...input } = e as typeof e & { agentId?: string }
      const isError = ran.deny !== undefined || ran.isError === true
      let found = harvest(cfg, String(tool), input, ran.text ?? '', repo, isError)
      const command = String((input as { command?: unknown }).command ?? '')

      if (String(tool) === 'Bash' && !isError && /\bteamcity\b/.test(command)) {
        indexBuildNumbers(buildNumbers, teamcityBuildNumbers(ran.text ?? ''))
      }

      // Subagents read widely; keep only what they created or changed.
      if (agentId !== undefined) {
        found = found.filter(one => one.role !== 'mentioned')
      }

      queue(found)

      if (found.some(one => one.role !== 'mentioned')) {
        flushSoon($, cfg, style)
      }

      // Notifications are immediate (fire and forget); the sidebar still updates at turn end.
      // Builds and runs get started/finished pop-ups instead of "created".
      const fresh = found.filter(one => one.role === 'created' && one.kind !== 'build' && one.kind !== 'run' && !announced.has(one.id))

      for (const one of found.filter(f => f.kind === 'build' && f.role === 'created')) {
        announced.add(`start:${one.id}`)
      }

      // A run start (or watch) that reports its finish in its output is announced right away.
      if (String(tool) === 'Bash' && !isError && /\bteamcity\b/.test(String((input as { command?: unknown }).command ?? ''))) {
        let sound: 'merged' | 'failed' | undefined

        for (const done of teamcityFinishLines(ran.text ?? '')) {
          if (!announced.has(`finish:build:tc/${done.id}`)) {
            announced.add(`finish:build:tc/${done.id}`)
            notify($, `${done.isGood ? '✓' : '✗'} TeamCity build ${done.name} #${done.number} ${done.outcome}`, cfg.teamcityUrl ? `${cfg.teamcityUrl.replace(/\/+$/, '')}/viewLog.html?buildId=${done.id}` : undefined)
            sound = done.isGood || sound === 'merged' ? 'merged' : 'failed'
          }
        }

        if (sound !== undefined) {
          chime($, sound)
        }
      }

      for (const one of fresh) {
        announced.add(one.id)
        notify($, `🔗 ${popupName(one)} created`, one.href)
      }

      if (fresh.length > 0) {
        chime($, 'created')
      }

      if (String(tool) === 'Bash' && !isError && /\bgh\s+pr\s+merge\b/.test(String((input as { command?: unknown }).command ?? ''))) {
        const merged = found.filter(f => f.kind === 'pr' && f.role === 'updated')

        for (const one of merged) {
          notify($, `🚢 ${popupName(one)} merged`, one.href)
        }

        if (merged.length > 0) {
          chime($, 'merged')
        }
      }
    } catch {
      // The trail is a sidecar: never let it disturb the tool call.
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    // Right after the turn, not inside it: lookups take a second and the turn is not theirs to hold.
    if (e.agentId === undefined) {
      $.clock.after(0, () => {
        void flush($, cfg, style).catch(() => undefined)
      })
    }

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Markdown, Text } = elements
    // Mobile draws no text inputs; the filter is simply absent there.
    const Input = 'Input' in elements ? elements.Input : undefined
    const allRefs = await shownRefs($)
    const filterText = await read($, filterAtom)
    const needle = filterText.trim().toLowerCase()
    // The filter matches keys and titles; while it's on, limits and collapsed sections don't apply.
    const refs = needle === '' ? allRefs : allRefs.filter(one => `${one.label} ${one.title ?? ''}`.toLowerCase().includes(needle))
    const collapsed = needle === '' ? await read($, collapsedAtom) : []
    const status = await read($, statusAtom)
    // Starred refs sit in their own section on top, not again in their kind's.
    const groups = groupRefs(refs.map(one => (one.isStarred ? { ...one, isDismissed: true } : one)))
    const starred = sortRefs(refs.filter(one => one.isStarred && !one.isDismissed))
    const dismissed = allRefs.filter(one => one.isDismissed).length
    const liveCount = allRefs.filter(one => !one.isDismissed).length
    const expanded = await read($, expandedAtom)
    const freshSince = await read($, freshSinceAtom)
    const age = status?.startedAt ? durationLabel((await $.clock.now()) - status.startedAt) : null
    const isLoading = await read($, loadingAtom)
    const jiraHelp = await read($, jiraHelpAtom)

    const row = (one: TrailRef, index: number) => {
      const tag = ROLE_TAG[one.role]
      const isFresh = Math.max(one.firstSeen, one.changedAt ?? 0) >= freshSince

      return (
        <Box key={`row-${one.id}`} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
          <Box flexDirection="row" gap={1}>
            {isFresh && <Text color={accent}>●</Text>}
            <Button
              key={`star-${one.id}`}
              // ★/☆ draw two cells wide but count as one; the trailing space lets the hover cover both.
              label={one.isStarred ? '★ ' : '☆ '}
              plain
              dimColor={!one.isStarred}
              onPress={() => setMark($, one.id, r => ({ ...r, isStarred: !r.isStarred }), style)}
            />
            <Markdown text={`[${one.label.replace(/[[\]]/g, '')}](${one.href})`} />
            {tag !== '' && (
              <Text color={one.role === 'created' ? accent : undefined} dimColor={one.role !== 'created'}>
                {tag}
              </Text>
            )}
            <Box flexGrow={1} />
            <Button
              key={`dismiss-${one.id}`}
              label="×"
              plain
              dimColor
              onPress={() => setMark($, one.id, r => ({ ...r, isDismissed: true, isStarred: false }), style)}
            />
          </Box>
          {one.title !== undefined && (
            <Box paddingLeft={2}>
              <Text dimColor wrap="truncate-end">
                {one.title}
              </Text>
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingRight={1}>
        <Box flexDirection="row">
          <Text color={accent} bold>
            Trail
          </Text>
          <Text dimColor>
            {' '}
            · session {status?.sessionId.slice(0, 8) ?? '…'}
            {age ? ` · ${age}` : ''}
          </Text>
          <Box flexGrow={1} />
          <Button key="hide" label="hide ⇥" plain dimColor role="dismiss" onPress={() => hidePane($, style)} />
        </Box>
        {status?.repo && (
          <Box key="repo">
            <Markdown text={`[${status.repo} ↗](https://github.com/${status.repo})`} dimColor />
          </Box>
        )}
        {isLoading && (
          <Box key="loading" marginTop={1}>
            <Text dimColor wrap="wrap">
              ⏳ Reading this session's history… long sessions take a few seconds.
            </Text>
          </Box>
        )}
        {refs.length === 0 && !isLoading && (
          <Box key="empty" marginTop={1}>
            <Text dimColor wrap="wrap">
              Nothing yet. Tickets, PRs, incidents, builds and docs this session touches land here.
            </Text>
          </Box>
        )}
        {Input !== undefined && (liveCount > 12 || needle !== '') && (
          <Box key="filter-row" flexDirection="row" gap={1} marginTop={1}>
            <Input
              key="filter"
              label="⌕ "
              placeholder="filter links"
              submitLabel="filter"
              value={filterText}
              onInput={(value: string) => {
                void update($, filterAtom, () => value)
              }}
              onSubmit={(value: string) => {
                void update($, filterAtom, () => value)
              }}
            />
            {needle !== '' && (
              <Text dimColor>
                {refs.filter(one => !one.isDismissed).length} of {liveCount}
              </Text>
            )}
            {needle !== '' && (
              <Button key="filter-clear" label="clear" plain dimColor onPress={() => update($, filterAtom, () => '')} />
            )}
          </Box>
        )}
        {starred.length > 0 && (
          <Box key="starred" flexDirection="column" marginTop={1}>
            <Text bold>★ Starred</Text>
            {starred.map(row)}
          </Box>
        )}
        {groups.map(([kind, list]) => {
          const isCollapsed = collapsed.includes(kind)
          const isOpen = expanded.includes(kind) || needle !== ''
          const shown = isCollapsed ? [] : isOpen ? list : list.slice(0, limits[kind])
          const hidden = isCollapsed ? 0 : list.length - shown.length

          return (
            <Box key={`group-${kind}`} flexDirection="column" marginTop={1}>
              <Button
                key={`toggle-${kind}`}
                label={`${isCollapsed ? '▸' : '▾'} ${KIND_TITLE[kind]} ${list.length}`}
                plain
                onPress={() => toggleSection($, kind)}
              />
              {!isCollapsed && kind === 'jira' && (jiraHelp === 'blocked' || jiraHelp === 'fallback') && (
                <Box key="jira-help" flexDirection="column" marginBottom={1}>
                  <Text color={WARN} wrap="wrap">
                    {jiraHelp === 'blocked'
                      ? '⚠ No Jira titles: the Atlassian search needs a permission rule (/permissions → Allow)'
                      : '⚠ Atlassian MCP not allowed, using the jira CLI. To use MCP, allow its search in /permissions.'}
                  </Text>
                  <Box flexDirection="row" gap={1}>
                    <Button
                      key="copy-allow-rule"
                      label="copy allow rule"
                      onPress={pe => {
                        void copyAllowRule($, pe.surface)
                      }}
                    />
                    {jiraHelp === 'fallback' && (
                      <Button
                        key="hide-mcp-note"
                        label="hide"
                        plain
                        dimColor
                        onPress={async () => {
                          await $.store.set('mcpNoteHidden', true)
                          await update($, jiraHelpAtom, () => '')
                        }}
                      />
                    )}
                  </Box>
                </Box>
              )}
              {kind === 'jira' && (jiraHelp === 'denied' || jiraHelp === 'unavailable') && (
                <Box key="jira-help" marginBottom={1}>
                  <Text color={WARN} wrap="wrap">
                    {jiraHelp === 'denied'
                      ? '⚠ No Jira titles: a permission rule denies the Atlassian search (/trail status)'
                      : '⚠ No Jira titles: no Atlassian MCP or jira CLI (/trail status)'}
                  </Text>
                </Box>
              )}
              {kind === 'pr' && ghError !== undefined && list.some(one => one.title === undefined && !one.isTitleTried) && (
                <Box key="pr-help" marginBottom={1}>
                  <Text color={WARN} wrap="wrap">
                    ⚠ Some PR titles can't load: gh lookups failing (/trail status)
                  </Text>
                </Box>
              )}
              {shown.map(row)}
              {(hidden > 0 || (isOpen && list.length > limits[kind])) && (
                <Box marginTop={1} paddingLeft={2}>
                  <Button
                    key={`more-${kind}`}
                    label={hidden > 0 ? `+${hidden} more` : 'show less'}
                    plain
                    dimColor
                    onPress={() =>
                      update($, expandedAtom, was => (was.includes(kind) ? was.filter(k => k !== kind) : [...was, kind]))
                    }
                  />
                </Box>
              )}
            </Box>
          )
        })}
        <Box flexDirection="column" marginTop={1}>
          {/* Actions read as quiet controls, not links: links are the only blue text. */}
          <Box flexDirection="row" gap={2}>
            <Button
              key="copy-resume"
              label="⧉ resume cmd"
              plain
              dimColor
              onPress={pe => {
                void copyResume($, pe.surface)
              }}
            />
            <Button
              key="copy-md"
              label="⧉ links md"
              plain
              dimColor
              onPress={pe => {
                void copyMarkdown($, pe.surface)
              }}
            />
          </Box>
          {dismissed > 0 && (
            <Button key="restore" label={`show ${dismissed} dismissed`} plain dimColor onPress={() => restoreAll($, style)} />
          )}
          <Box marginTop={1}>
            <Text dimColor wrap="truncate-end">
              ☆ pins · ▾ collapses · /trail hides
            </Text>
          </Box>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const status = await read($, statusAtom)

    if (style !== 'band' || e.props.hasSurvey || status === null) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const refs = await shownRefs($)
    const latest = await read($, latestAtom)
    const live = refs.filter(one => !one.isDismissed).length
    const isNarrow = e.props.bodyColumns < 110
    const sep = <Text dimColor> │ </Text>
    const ctx = status.contextPercent
    const five = status.fiveHourPercent
    const until = untilLabel(status.fiveHourResetsAt, await $.clock.now())
    const window = windowLabel(status.contextWindow)

    return (
      <Box flexDirection="row" flexWrap="nowrap" marginTop={1}>
        <Text color={accent}>{status.model}</Text>
        {!isNarrow && sep}
        {!isNarrow && (
          <Button key="band-dir" label={`📁 ${status.dir}`} plain dimColor onPress={() => revealDir($)} />
        )}
        {status.git && sep}
        {status.git && (
          <Text dimColor wrap="truncate-end">
            🔀 {status.git.branch} {gitLabel(status.git)}
          </Text>
        )}
        {ctx !== null && sep}
        {ctx !== null && (
          <Text>
            {bar(ctx).map(c => (
              <Text color={c.isFilled ? levelColor(ctx, accent) : undefined} dimColor={!c.isFilled}>
                {c.cell}
              </Text>
            ))}
            <Text dimColor>
              {' '}
              {Math.round(ctx)}%{!isNarrow && window ? ` of ${window}` : ''}
            </Text>
          </Text>
        )}
        {five !== null && sep}
        {five !== null && (
          <Text dimColor={five < 75} color={five >= 75 ? levelColor(five, accent) : undefined}>
            5h {Math.round(five)}%{until ? ` ↻ ${until}` : ''}
          </Text>
        )}
        {sep}
        <Button
          key="band-resume"
          label={`⧉ ${status.sessionId.slice(0, 8)}`}
          plain
          onPress={pe => {
            void copyResume($, pe.surface)
          }}
        />
        {sep}
        <Button
          key="band-trail"
          label={`🔗 trail: ${live}`}
          plain
          onPress={() => togglePane($, style)}
        />
        {latest !== null && sep}
        {/* A button that opens the link itself: a plain Link can't take the row's focus, so a
            click would land the focus (and its highlight) on the row's first button instead. */}
        {latest !== null &&
          (latest.href ? (
            <Button
              key="band-latest"
              label={`${shorten(latest.text, isNarrow ? 28 : 56)} ↗`}
              plain
              onPress={() => openUrl($, latest.href ?? '')}
            />
          ) : (
            <Text>{shorten(latest.text, isNarrow ? 28 : 56)}</Text>
          ))}
      </Box>
    )
  })
}
