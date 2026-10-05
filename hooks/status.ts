import type { TrailGit } from '../types'

/** The context-bar.sh accent themes (xterm-256 colors as hex). */
export const ACCENTS: Record<string, string> = {
  blue: '#5fafd7',
  cyan: '#00afaf',
  gold: '#af8700',
  gray: '#8a8a8a',
  green: '#5faf5f',
  lavender: '#af87af',
  orange: '#d7875f',
  rose: '#af5f87',
  slate: '#5f5f87',
  teal: '#5f8787',
}

export const WARN = '#ffaf00'
export const DANGER = '#ff5f5f'

/** `git status --porcelain=v2 --branch` → branch, changed files, ahead/behind. */
export function parseGitStatus(out: string): TrailGit | null {
  let branch = ''
  let changed = 0
  let ahead = 0
  let behind = 0
  let hasUpstream = false

  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim()
    } else if (line.startsWith('# branch.upstream ')) {
      hasUpstream = true
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)

      if (m) {
        ahead = Number(m[1])
        behind = Number(m[2])
      }
    } else if (line !== '' && !line.startsWith('#')) {
      changed += 1
    }
  }

  if (branch === '') {
    return null
  }

  return { ahead, behind, branch: branch === '(detached)' ? 'detached' : branch, changed, hasUpstream }
}

/** `claude-opus-5-5[1m]` → `Opus 5.5 1M`; anything else passes through. */
export function prettyModel(id: string): string {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?/i.exec(id)

  if (!m) {
    return id
  }

  const word = m[1] ?? ''
  const name = word.charAt(0).toUpperCase() + word.slice(1)
  const version = m[3] ? `${m[2]}.${m[3]}` : m[2]

  return `${name} ${version}${m[4] ? ' 1M' : ''}`
}

/** Ten cells, like context-bar.sh: █ full, ▄ partly, ░ empty. */
export function bar(percent: number, width = 10): Array<{ cell: string; isFilled: boolean }> {
  const cells: Array<{ cell: string; isFilled: boolean }> = []
  const step = 100 / width

  for (let i = 0; i < width; i++) {
    const progress = percent - i * step

    if (progress >= step * 0.8) {
      cells.push({ cell: '█', isFilled: true })
    } else if (progress >= step * 0.3) {
      cells.push({ cell: '▄', isFilled: true })
    } else {
      cells.push({ cell: '░', isFilled: false })
    }
  }

  return cells
}

/** `in 2h10m`, `in 7m`, `now`: relative so it never depends on the runtime's time zone. */
export function untilLabel(iso: string | null, now: number): string | null {
  if (iso === null) {
    return null
  }

  const at = Date.parse(iso)

  if (Number.isNaN(at)) {
    return null
  }

  const mins = Math.max(0, Math.round((at - now) / 60000))

  if (mins === 0) {
    return 'now'
  }

  if (mins < 60) {
    return `in ${mins}m`
  }

  const h = Math.floor(mins / 60)
  const m = mins % 60

  return m === 0 ? `in ${h}h` : `in ${h}h${m}m`
}

export function levelColor(percent: number, normal: string): string {
  if (percent >= 90) {
    return DANGER
  }

  if (percent >= 75) {
    return WARN
  }

  return normal
}

export function gitLabel(git: TrailGit): string {
  const parts: string[] = []

  if (git.changed > 0) {
    parts.push(`±${git.changed}`)
  }

  if (git.ahead > 0) {
    parts.push(`↑${git.ahead}`)
  }

  if (git.behind > 0) {
    parts.push(`↓${git.behind}`)
  }

  if (!git.hasUpstream) {
    parts.push('no upstream')
  }

  return parts.length === 0 ? '✓' : parts.join(' ')
}
