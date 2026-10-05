export type TrailKind = 'jira' | 'pr' | 'inc' | 'build' | 'run' | 'doc'

/** How the session touched a ref, strongest first. */
export type TrailRole = 'created' | 'updated' | 'mentioned'

export type TrailRef = {
  /** Stable identity, e.g. `jira:PROJ-42`, `pr:acme/api#708`. */
  id: string
  kind: TrailKind
  label: string
  href: string
  role: TrailRole
  /** The ticket's summary or the PR's title, once known. */
  title?: string
  /** A background title lookup already ran for it (found or not). */
  isTitleTried?: boolean
  /** When a lookup last changed its title or label (a build finishing, say). */
  changedAt?: number
  /** Times seen this session. */
  hits: number
  firstSeen: number
  lastSeen: number
  isStarred: boolean
  isDismissed: boolean
}

export type TrailGit = {
  branch: string
  changed: number
  ahead: number
  behind: number
  hasUpstream: boolean
}

export type TrailStatus = {
  model: string
  dir: string
  git: TrailGit | null
  contextPercent: number | null
  contextWindow: number | null
  fiveHourPercent: number | null
  fiveHourResetsAt: string | null
  sessionId: string
  /** When the session began (a resumed one: its first launch), in clock milliseconds. */
  startedAt: number | null
  /** The session's GitHub repo as owner/name, when it has one. */
  repo: string | null
}

declare module 'claude-code' {
  interface PluginState {
    trail: {
      refs: TrailRef[]
      status: TrailStatus | null
      /** Which extraction rules built `refs`; a newer build rebuilds it. */
      built: number
      /** Sections showing everything rather than their first few. */
      expanded: string[]
      /** True while the backfill reads the session's history. */
      isLoading: boolean
      /** Items added or changed after this time are marked with a dot until the next turn's update. */
      freshSince: number
      /** Sections the person collapsed (kept across sessions in the store). */
      collapsed: string[]
      /** The sidebar's filter text; empty shows everything. */
      filter: string
      /** The latest notification, shown as a link in the status row until the next message. */
      latest: { text: string; href: string | null } | null
      /**
       * Why Jira titles can't be looked up, once the probe has given up:
       * `blocked` (the Atlassian MCP is connected but permission rules don't
       * allow its search, so the sidebar offers to copy the rule),
       * `unavailable` (no source at all), `denied` (an explicit deny rule),
       * `fallback` (MCP connected but not allowed while the jira CLI covers),
       * or empty when nothing needs saying.
       */
      jiraHelp: string
    }
  }
}
