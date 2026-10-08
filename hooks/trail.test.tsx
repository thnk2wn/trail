import { describe, expect, test } from 'claude-code/testing'

import { bashRefs, buildNumberRefs, teamcityFinishLines, teamcityStartJob, capRefs, findRefs, indexBuildNumbers, teamcityBuildNumbers, isMissingTool, isTransientError, parseLimits, sortRefs, mergeRefs, parseDuration, atlassianSiteFromText, incidentOrgFromText, parseJiraCliServer, parseJiraProjectList, parseTeamcityServer, projectsFromIssueKeys, parseProjects, staleRefs, toMarkdown, toolRefs, transcriptNeedles, transcriptRefs, visibleRefs } from './refs'
import type { TrailConfig } from './refs'
import { parseGitStatus, prettyModel, untilLabel } from './status'

const CFG: TrailConfig = {
  atlassianServer: 'claude.ai Atlassian',
  githubOrg: 'acme',
  incidentOrg: 'acme',
  jiraBaseUrl: 'https://acme.atlassian.net/',
  jiraProjects: parseProjects('PROJ, ops'),
  teamcityUrl: 'https://tc.example.com',
}

describe('findRefs', () => {
  test('links Jira keys of configured projects only', async () => {
    const found = findRefs('Fixes PROJ-958 and OPS-12; not UTF-8, SHA-256 or XPROJ-1', CFG)

    expect(found.map(f => f.label)).toEqual(['PROJ-958', 'OPS-12'])
    expect(found[0]?.href).toBe('https://acme.atlassian.net/browse/PROJ-958')
  })

  test('names org PRs by repo and others by owner/repo', async () => {
    const found = findRefs(
      'see https://github.com/acme/api/pull/708, and https://github.com/other/tool/pull/3.',
      CFG,
    )

    expect(found.map(f => f.label)).toEqual(['api #708', 'other/tool #3'])
  })

  test('incidents, TeamCity builds, Confluence pages, artifacts', async () => {
    const found = findRefs(
      'INC-42 https://teamcity.example.com/buildConfiguration/Build_Api/109528 ' +
        'https://acme.atlassian.net/wiki/spaces/DOCS/pages/12345/Example+Page ' +
        'https://claude.ai/code/artifact/00000000-0000-4000-8000-000000000001',
      CFG,
    )

    expect(found.map(f => `${f.kind}:${f.label}`)).toEqual([
      'inc:INC-42',
      'build:Build_Api #109528',
      'doc:Example Page',
      'doc:Artifact 00000000',
    ])
    expect(found[0]?.href).toBe('https://app.incident.io/acme/incidents/42')
  })
})

describe('bashRefs', () => {
  test('gh pr create reads the new PR from the output', async () => {
    const found = bashRefs(
      'gh pr create --base main --title "x" --assignee @me',
      'https://github.com/acme/.github/pull/43\n',
      CFG,
      'acme/.github',
    )

    expect(found.map(f => `${f.role}:${f.label}`)).toEqual(['created:.github #43'])
  })

  test('gh pr merge N resolves the repo from cd, --repo or the session repo', async () => {
    expect(bashRefs('cd /Users/x/dev/acme/api && gh pr merge 169 --squash', '', CFG, null)[0]?.label).toBe('api #169')
    expect(bashRefs('gh pr merge 5 -R acme/web', '', CFG, null)[0]?.label).toBe('web #5')
    expect(bashRefs('R=acme/schema; gh pr ready 426 -R $R', '', CFG, 'acme/search-indexer')[0]?.label).toBe('schema #426')
    expect(bashRefs('gh pr ready 426 -R "$(pick_repo)"', '', CFG, 'acme/search-indexer').filter(f => f.kind === 'pr')).toEqual([])
    expect(bashRefs('gh pr view 42 --json title', '', CFG, 'acme/.github')[0]).toEqual(
      expect.objectContaining({ label: '.github #42', role: 'mentioned' }),
    )
  })

  test('ignores tool output except for creates', async () => {
    expect(bashRefs('gh pr list', 'https://github.com/acme/api/pull/1 PROJ-1', CFG, null)).toEqual([])
  })

  test('stand-in numbers in a command are trial runs, not work', async () => {
    const found = bashRefs(
      'scripts/attach.sh --key INC-1 https://x; scripts/attach.sh INC-1673 https://github.com/acme/api/pull/999/files https://github.com/acme/api/pull/29',
      '',
      CFG,
      null,
    )

    expect(found.map(f => f.label)).toEqual(['api #29', 'INC-1673'])
    expect(bashRefs('gh pr view 123 --repo acme/api', '', CFG, null).map(f => f.label)).toEqual(['api #123'])
  })
})

describe('teamcityRefs', () => {
  test('builds from the teamcity CLI, REST paths and shell loops; run list ignored', async () => {
    const labels = (cmd: string) => bashRefs(cmd, '', CFG, null).filter(f => f.kind === 'build').map(f => `${f.role}:${f.id}`)

    expect(labels('teamcity run view 107554')).toEqual(['mentioned:build:tc/107554'])
    expect(labels('teamcity run cancel 107551')).toEqual(['updated:build:tc/107551'])
    expect(labels('for r in 107551 107554; do teamcity run view $r 2>&1 | head; done')).toEqual(['mentioned:build:tc/107551', 'mentioned:build:tc/107554'])
    expect(labels('teamcity api "/app/rest/builds/id:107551?fields=number"')).toEqual(['mentioned:build:tc/107551'])
    expect(labels('teamcity run list --branch main --limit 5')).toEqual([])
    expect(labels('teamcity run log 107554 --tail 500')).toEqual(['mentioned:build:tc/107554'])
    expect(labels('teamcity run watch --timeout 600 107554')).toEqual(['mentioned:build:tc/107554'])
    expect(labels('teamcity run comment 107554 "fixed by 712 and 713"')).toEqual(['mentioned:build:tc/107554'])
    expect(bashRefs('teamcity run view 107554', '', CFG, null)[0]?.href).toBe('https://tc.example.com/viewLog.html?buildId=107554')
  })

  test('a URL and a CLI id for the same build are one ref', async () => {
    const list = mergeRefs(
      [],
      [...findRefs('https://tc.example.com/buildConfiguration/Build_Api/107554', CFG), ...bashRefs('teamcity run log 107554', '', CFG, null)],
      1,
    )

    expect(list.map(r => r.id)).toEqual(['build:tc/107554'])
  })

  test('transient errors are retried, others are answers', async () => {
    expect(isTransientError('error connecting to api.github.com')).toBe(true)
    expect(isTransientError('To get started with GitHub CLI, please run:  gh auth login')).toBe(true)
    expect(isTransientError('GraphQL: Could not resolve to a PullRequest with the number of 99999.')).toBe(false)
    expect(isTransientError('GraphQL: Could not resolve to a PullRequest with the number of 4012.')).toBe(false)
    expect(isTransientError("Could not resolve to a Repository with the name 'acme/network-tools'.")).toBe(false)
    expect(isTransientError('build 104012 not found')).toBe(false)
    expect(isTransientError('HTTP 401: Bad credentials')).toBe(true)
  })
})

describe('builds by number', () => {
  test('a build a teamcity query printed is found when a reply names it by number', async () => {
    const index = new Map<string, string>()

    indexBuildNumbers(index, teamcityBuildNumbers('builds: 110322 #1.0.366 running main | 109178 #1.0.365 finished/SUCCESS'))
    indexBuildNumbers(index, teamcityBuildNumbers('{"build":[{"id":110324,"number":"1.0.122","state":"finished"}]}'))

    const ids = (text: string) => buildNumberRefs(text, index, CFG).map(f => f.id)

    expect(ids('The main build (#1.0.366) is running')).toEqual(['build:tc/110322'])
    expect(ids('prod deploy #1.0.122 shipped build 1.0.366')).toEqual(['build:tc/110324', 'build:tc/110322'])
    expect(ids('1.0.366 is live')).toEqual(['build:tc/110322'])
    expect(ids('no build numbers here, just 366 apples and #42')).toEqual([])

    indexBuildNumbers(index, teamcityBuildNumbers('108412 #412 finished/SUCCESS main'))
    expect(ids('Merged PR #412 and closed issue #412')).toEqual([])
    expect(ids('build 412 passed; deploy #412 next')).toEqual(['build:tc/108412'])
  })
})

describe('teamcity run start', () => {
  test('job, finish lines and the short build URL', async () => {
    expect(teamcityStartJob('teamcity run start Deploy_Schema -b main --revision abc -P mode=preview')).toBe('Deploy_Schema')
    expect(teamcityStartJob('teamcity run start --watch Build_Api')).toBe('Build_Api')
    expect(teamcityStartJob('teamcity run list --limit 3')).toBeUndefined()
    expect(teamcityFinishLines('2026-10-02 21:36:06|1830 | ✓ schema 110434  #295 succeeded |  | View details: https://tc.example.com/x')).toEqual([
      { id: '110434', isGood: true, name: 'schema', number: '295', outcome: 'succeeded' },
    ])
    expect(teamcityFinishLines('✗ api 110500 #1.0.900 failed')[0]?.isGood).toBe(false)
    expect(findRefs('✓ Queued run 110433 | URL: https://tc.example.com/build/110433 |', CFG).map(f => f.id)).toEqual(['build:tc/110433'])
  })
})

describe('Actions runs', () => {
  test('gh run commands and REST paths become runs in their own section; gh run list ignored', async () => {
    const runs = (cmd: string, hint: string | null = 'acme/search-indexer') =>
      bashRefs(cmd, '', CFG, hint).filter(f => f.kind === 'run').map(f => `${f.role}:${f.label}`)

    expect(runs('gh run view 12345678901 --json status,conclusion')).toEqual(['mentioned:search-indexer run 12345678901'])
    expect(runs('gh run rerun 12345678901 -R acme/api --failed')).toEqual(['updated:api run 12345678901'])
    expect(runs('gh api repos/acme/web/actions/runs/123456789/jobs')).toEqual(['mentioned:web run 123456789'])
    expect(runs('gh run list -R acme/api --limit 3')).toEqual([])
    expect(runs('cd ~/src/web && for id in 37678512886 37678513022; do gh run watch $id --exit-status >/dev/null 2>&1; echo "$id done"; done')).toEqual([
      'mentioned:web run 37678512886',
      'mentioned:web run 37678513022',
    ])
    expect(runs('gh api -X POST repos/acme/api/actions/runs/123456789/rerun')).toEqual(['updated:api run 123456789'])
    expect(findRefs('https://github.com/acme/api/actions/runs/123456', CFG)[0]?.kind).toBe('run')
  })
})

describe('toolRefs', () => {
  test('createJiraIssue is a create, transitions are updates', async () => {
    const created = toolRefs('mcp__claude_ai_Atlassian__createJiraIssue', { summary: 'see PROJ-1' }, '{"key":"PROJ-999"}', CFG)

    expect(created.map(f => `${f.role}:${f.label}`)).toEqual(['created:PROJ-999', 'mentioned:PROJ-1'])

    const moved = toolRefs('mcp__claude_ai_Atlassian__transitionJiraIssue', { issueIdOrKey: 'PROJ-5' }, '', CFG)

    expect(moved[0]?.role).toBe('updated')

    const comment = toolRefs('mcp__claude_ai_Atlassian__addCommentToJiraIssue', { commentBody: 'see PROJ-7', issueIdOrKey: 'PROJ-6' }, '', CFG)

    expect(comment.map(f => `${f.role}:${f.label}`)).toEqual(['updated:PROJ-6', 'mentioned:PROJ-7', 'mentioned:PROJ-6'])
  })
})

describe('mergeRefs', () => {
  test('stronger roles win and dismissals stick', async () => {
    let list = mergeRefs([], findRefs('PROJ-1', CFG), 1)

    list = list.map(r => ({ ...r, isDismissed: true }))
    list = mergeRefs(list, findRefs('PROJ-1', CFG, 'updated'), 2)

    expect(list[0]).toEqual(expect.objectContaining({ hits: 2, isDismissed: true, lastSeen: 2, role: 'updated' }))
    list = mergeRefs(list, findRefs('PROJ-1', CFG), 3)
    expect(list[0]?.role).toBe('updated')
  })

  test('Jira keys show only once Jira confirmed them', async () => {
    const list = mergeRefs([], findRefs('PROJ-829 PROJ-999 https://github.com/acme/a/pull/1', CFG), 1).map(r =>
      r.label === 'PROJ-829' ? { ...r, isTitleTried: true, title: 'Restore O365' } : r.label === 'PROJ-999' ? { ...r, isTitleTried: true } : r,
    )

    expect(visibleRefs(list, true).map(r => r.label)).toEqual(['a #1', 'PROJ-829'])
    expect(visibleRefs(list, false).map(r => r.label)).toEqual(['a #1', 'PROJ-829', 'PROJ-999'])
  })

  test('PRs show until gh says they do not exist', async () => {
    const list = mergeRefs([], findRefs('https://github.com/acme/a/pull/7 https://github.com/acme/a/pull/8 https://github.com/acme/a/pull/9', CFG), 1).map(r =>
      r.label === 'a #8' ? { ...r, isTitleTried: true, title: 'Real' } : r.label === 'a #9' ? { ...r, isTitleTried: true } : r,
    )

    expect(visibleRefs(list, true).map(r => r.label)).toEqual(['a #7', 'a #8'])
    expect(visibleRefs(list, true, { gh: false, incident: true, teamcity: true }).map(r => r.label)).toEqual(['a #7', 'a #8', 'a #9'])
  })

  test('a Confluence link ending a sentence drops the full stop', async () => {
    const [one] = findRefs('See https://acme.atlassian.net/wiki/spaces/EN/pages/457637890/Incident.io+Response.', CFG)

    expect(one?.label).toBe('Incident.io Response')
    expect(one?.href).toBe('https://acme.atlassian.net/wiki/spaces/EN/pages/457637890/Incident.io+Response')
  })

  test('builds show only once a lookup confirmed them, unless their CLI is missing', async () => {
    const list = mergeRefs(
      [],
      bashRefs('for r in 107551 107554 107999; do teamcity run view $r; done', '', CFG, null),
      1,
    ).map(r => (r.id === 'build:tc/107554' ? { ...r, isTitleTried: true, title: '✓ Success' } : r.id === 'build:tc/107999' ? { ...r, isTitleTried: true } : r))

    expect(visibleRefs(list, true).map(r => r.id)).toEqual(['build:tc/107554'])
    expect(visibleRefs(list, true, { gh: true, incident: true, teamcity: false }).map(r => r.id).sort()).toEqual(['build:tc/107551', 'build:tc/107554', 'build:tc/107999'])
    expect(isMissingTool('spawn teamcity ENOENT')).toBe(true)
    expect(isMissingTool('Cannot find build by id 107999')).toBe(false)
  })

  test('the cap drops mention-only refs first, never starred or created ones', async () => {
    const base = mergeRefs([], findRefs('PROJ-1 PROJ-2 PROJ-3 PROJ-4', CFG), 1)
    const list = base.map((r, i) => ({
      ...r,
      isStarred: r.label === 'PROJ-1',
      lastSeen: i,
      role: r.label === 'PROJ-2' ? ('created' as const) : r.role,
    }))

    expect(capRefs(list, 3).map(r => r.label)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-4'])
  })

  test('section limits parse with defaults', async () => {
    expect(parseLimits('build=1, pr = 20, bogus=4, doc=x')).toEqual({ build: 1, doc: 5, inc: 5, jira: 5, pr: 20, run: 3 })
  })

  test('markdown escapes brackets and carries titles', async () => {
    const list = mergeRefs([], findRefs('PROJ-2', CFG), 1).map(r => ({ ...r, title: 'Fix [thing]' }))

    expect(toMarkdown(list)).toBe('**Jira**\n- [PROJ-2](https://acme.atlassian.net/browse/PROJ-2) Fix \\[thing\\]')
  })

  test('markdown groups by kind', async () => {
    const list = mergeRefs([], findRefs('PROJ-2 https://github.com/acme/api/pull/9', CFG), 1)

    expect(toMarkdown(list)).toBe(
      '**Jira**\n- [PROJ-2](https://acme.atlassian.net/browse/PROJ-2)\n\n**Pull requests**\n- [api #9](https://github.com/acme/api/pull/9)',
    )
  })
})

describe('transcriptRefs', () => {
  test('pairs creates with their results and skips subagent rows', async () => {
    const rows = [
      { message: { content: 'work PROJ-10' }, timestamp: '2026-10-02T10:00:00Z', type: 'user' },
      { message: { content: [{ id: 't1', input: { command: 'gh pr create -t x' }, name: 'Bash', type: 'tool_use' }] }, type: 'assistant' },
      { message: { content: [{ content: 'https://github.com/acme/api/pull/9', tool_use_id: 't1', type: 'tool_result' }] }, type: 'user' },
      { isSidechain: true, message: { content: 'PROJ-99' }, type: 'user' },
    ]
    const list = transcriptRefs(rows.map(r => JSON.stringify(r)).join('\n'), CFG, null)

    expect(list.map(r => `${r.role}:${r.label}`)).toEqual(['mentioned:PROJ-10', 'created:api #9'])
  })
})

describe('ordering', () => {
  test('starred first, then most recent activity, whatever the role', async () => {
    const list = mergeRefs([], findRefs('PROJ-1 PROJ-2 PROJ-3', CFG), 1).map(r =>
      r.label === 'PROJ-1'
        ? { ...r, lastSeen: 1, role: 'created' as const }
        : r.label === 'PROJ-2'
          ? { ...r, lastSeen: 3 }
          : { ...r, isStarred: true, lastSeen: 0 },
    )

    expect(sortRefs(list).map(r => r.label)).toEqual(['PROJ-3', 'PROJ-2', 'PROJ-1'])
  })
})

describe('transcript grep filter', () => {
  test('keeping only needle lines gives the same refs as the full transcript', async () => {
    const rows = [
      { message: { content: [{ id: 'e1', input: { issueIdOrKey: 'PROJ-5' }, name: 'mcp__claude_ai_Atlassian__editJiraIssue', type: 'tool_use' }] }, type: 'assistant' },
      { message: { content: [{ content: 'updated', tool_use_id: 'e1', type: 'tool_result' }] }, type: 'user' },
      { message: { content: [{ id: 'g1', input: { command: 'gh pr create -t x' }, name: 'Bash', type: 'tool_use' }] }, type: 'assistant' },
      { message: { content: [{ content: 'https://github.com/acme/api/pull/9', tool_use_id: 'g1', type: 'tool_result' }] }, type: 'user' },
      { message: { content: 'nothing to see' }, type: 'user' },
    ]
    const lines = rows.map(r => JSON.stringify(r))
    const needles = transcriptNeedles(CFG)
    const kept = lines.filter(line => needles.some(n => line.includes(n)))
    const roles = (list: { label: string; role: string }[]) => list.map(r => `${r.role}:${r.label}`).sort()

    expect(kept.length < lines.length).toBe(true)
    expect(roles(transcriptRefs(kept.join('\n'), CFG, null))).toEqual(roles(transcriptRefs(lines.join('\n'), CFG, null)))
    expect(roles(transcriptRefs(kept.join('\n'), CFG, null))).toEqual(['created:api #9', 'updated:PROJ-5'])
  })
})

describe('clean', () => {
  test('durations parse; anything else is refused', async () => {
    expect(parseDuration('30m')).toBe(30 * 60_000)
    expect(parseDuration('2d')).toBe(2 * 86_400_000)
    expect(parseDuration('1d12h')).toBe(36 * 3_600_000)
    expect(parseDuration(' 1W ')).toBe(7 * 86_400_000)
    expect([parseDuration('2'), parseDuration('2 days'), parseDuration('0h'), parseDuration('-1d')]).toEqual([null, null, null, null])
  })

  test('stale means no activity since the cutoff; starred and dismissed are left alone', async () => {
    const at = (lastSeen: number, extra: object = {}) => ({ firstSeen: 0, hits: 1, href: '', id: `x${lastSeen}`, isDismissed: false, isStarred: false, kind: 'pr' as const, label: `x${lastSeen}`, lastSeen, role: 'created' as const, ...extra })
    const list = [at(10), at(50), at(5, { id: 's', isStarred: true }), at(6, { id: 'd', isDismissed: true })]

    expect(staleRefs(list, 20).map(one => one.id)).toEqual(['x10'])
    expect(staleRefs(list, Infinity).map(one => one.id)).toEqual(['x10', 'x50'])
  })
})

describe('settings detection', () => {
  test('reads the jira CLI config, its project list and search replies', async () => {
    expect(parseJiraCliServer('installation: Cloud\nserver: https://acme.atlassian.net/\nlogin: me@example.com\n')).toBe('https://acme.atlassian.net')
    expect(parseJiraCliServer('login: me\n')).toBe(null)
    expect(parseJiraProjectList('KEY\tNAME\tTYPE\nPROJ\tProject\tclassic\nOPS\tOperations\tnext-gen\n')).toEqual(['PROJ', 'OPS'])
    expect(projectsFromIssueKeys('{"issues":[{"key":"PROJ-12"},{"key":"OPS-3"},{"key":"PROJ-9"}]}')).toEqual(['OPS', 'PROJ'])
    expect(atlassianSiteFromText('[{"id":"x","url":"https://acme.atlassian.net","name":"acme"}]')).toBe('https://acme.atlassian.net')
  })

  test('reads the teamcity login and an incident.io permalink', async () => {
    expect(parseTeamcityServer('[{"server":"https://tc.example.com/","status":"authenticated"}]')).toBe('https://tc.example.com')
    expect(parseTeamcityServer('[{"server":"https://tc.example.com","status":"expired"}]')).toBe(null)
    expect(parseTeamcityServer('not json')).toBe(null)
    expect(incidentOrgFromText('"permalink":"https://app.incident.io/acme/incidents/42"')).toBe('acme')
  })

  test('no Jira keys without a site to link them to', async () => {
    expect(findRefs('see PROJ-7', { ...CFG, jiraBaseUrl: '' })).toEqual([])
  })
})

describe('status helpers', () => {
  test('git porcelain v2', async () => {
    const git = parseGitStatus('# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n1 .M N... a\n? b\n')

    expect(git).toEqual({ ahead: 2, behind: 1, branch: 'main', changed: 2, hasUpstream: true })
  })

  test('model names and reset labels', async () => {
    expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(prettyModel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5 1M')
    expect(untilLabel('2026-10-02T15:30:00Z', Date.parse('2026-10-02T13:20:00Z'))).toBe('in 2h10m')
  })
})

describe('pane', () => {
  test('a gh pr create shows up as a link and can be dismissed', async ($, on) => {
    on('tool.call', { tool: 'Bash' }, () => ({
      result: { interrupted: false, stderr: '', stdout: 'https://github.com/acme/api/pull/708\n' },
      text: 'https://github.com/acme/api/pull/708\n',
    }))

    await $.tool.call({ command: 'gh pr create --title t', description: 'open PR', tool: 'Bash' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        component: 'Pane',
        plugin: 'trail',
        props: {
          bodyColumns: 40,
          isFocused: false,
          placement: 'dock',
          scroll: { bodyRows: 30, offset: 0 },
          title: 'Trail',
          view: {},
        },
        requestId: 'trail',
        surface,
      })
      const link = await ui.find({ type: 'Link' })

      expect(link?.props.href).toBe('https://github.com/acme/api/pull/708')
      expect(link?.props.label).toBe('api #708')
      await ui.unmount()
    }

    const ui = await $.ui.mount({
      component: 'Pane',
      plugin: 'trail',
      props: {
        bodyColumns: 40,
        isFocused: false,
        placement: 'dock',
        scroll: { bodyRows: 30, offset: 0 },
        title: 'Trail',
        view: {},
      },
      requestId: 'trail',
      surface: 'terminal',
    })

    await ui.press({ key: 'dismiss-pr:acme/api#708' })
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    expect(await ui.find({ key: 'restore' })).toBeDefined()
    await ui.unmount()
  })
})
