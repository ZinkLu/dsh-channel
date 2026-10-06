import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseManagerCommand,
  pathLabel,
  relativeTimeLabel,
  renderForeignConfirm,
  renderSessionList,
  renderSessionStatus,
  renderWorkspaceList,
  resolveSessionTarget,
  type SessionListRow,
} from '../src/policy/manager-commands.ts'

// ---- parsing ----

test('parseManagerCommand covers the §6.2 table', () => {
  assert.deepEqual(parseManagerCommand('/ls'), { kind: 'list-sessions' })
  assert.deepEqual(parseManagerCommand('/ls blog'), { kind: 'list-sessions', workspace: 'blog' })
  assert.deepEqual(parseManagerCommand('/ws'), { kind: 'list-workspaces' })
  assert.deepEqual(parseManagerCommand('/use 3'), { kind: 'use', target: '3', take: false })
  assert.deepEqual(parseManagerCommand('/use 3 --take'), { kind: 'use', target: '3', take: true })
  assert.deepEqual(parseManagerCommand('/use sess:x --take'), { kind: 'use', target: 'sess:x', take: true })
  assert.deepEqual(parseManagerCommand('/new'), { kind: 'new' })
  assert.deepEqual(parseManagerCommand('/new blog'), { kind: 'new', target: 'blog' })
  assert.deepEqual(parseManagerCommand('/new /tmp/p fix the bug'), { kind: 'new', target: '/tmp/p', text: 'fix the bug' })
  assert.deepEqual(parseManagerCommand('/to 2 run the tests'), { kind: 'to', target: '2', text: 'run the tests', take: false })
  assert.deepEqual(parseManagerCommand('/to 2 --take run the tests'), { kind: 'to', target: '2', text: 'run the tests', take: true })
  assert.deepEqual(parseManagerCommand('/status'), { kind: 'status' })
  assert.deepEqual(parseManagerCommand('/status 2'), { kind: 'status', target: '2' })
  assert.deepEqual(parseManagerCommand('/tail'), { kind: 'tail' })
  assert.deepEqual(parseManagerCommand('/stop 1'), { kind: 'stop', target: '1' })
  assert.deepEqual(parseManagerCommand('/watch 2'), { kind: 'watch', target: '2' })
  assert.deepEqual(parseManagerCommand('/unwatch'), { kind: 'unwatch' })
  assert.deepEqual(parseManagerCommand('/bind sess:1 --take'), { kind: 'bind', sessionId: 'sess:1', take: true })
  assert.deepEqual(parseManagerCommand('/help'), { kind: 'help' })
  assert.deepEqual(parseManagerCommand('/start'), { kind: 'help' })
  assert.deepEqual(parseManagerCommand('/frobnicate'), { kind: 'unknown', command: 'frobnicate' })
  // Missing mandatory arguments degrade to unknown (the bridge renders its historical reply).
  assert.deepEqual(parseManagerCommand('/use'), { kind: 'unknown', command: 'use' })
  assert.deepEqual(parseManagerCommand('/to 2'), { kind: 'unknown', command: 'to' })
  assert.deepEqual(parseManagerCommand('/bind'), { kind: 'unknown', command: 'bind' })
})

test('resolveSessionTarget maps numbers through the stable per-chat numbering', () => {
  const numbers = { 'sess:a': 1, 'sess:b': 2 }
  assert.deepEqual(resolveSessionTarget('2', numbers), { kind: 'numbered', sessionId: 'sess:b' })
  assert.deepEqual(resolveSessionTarget('sess:c', numbers), { kind: 'session-id', sessionId: 'sess:c' })
  assert.deepEqual(resolveSessionTarget('9', numbers), { kind: 'unknown-number', ref: '9' })
})

// ---- session list rendering ----

function row(overrides: Partial<SessionListRow> & { sessionId: string }): SessionListRow {
  return {
    running: false,
    blank: false,
    managed: true,
    foreign: false,
    watchers: 0,
    updatedAt: 1_000,
    ...overrides,
  }
}

const NOW = 1_700_000_000_000

test('renderSessionList groups by workspace, numbers 1..n, and glyphs the state', () => {
  const render = renderSessionList(
    [
      row({ sessionId: 'a', title: 'fix merge window', workspaceId: 'ws1', running: true, updatedAt: NOW - 2 * 60_000, pendingInteraction: 'approval' }),
      row({ sessionId: 'b', title: 'docs sync', workspaceId: 'ws1', lastReason: 'completed', updatedAt: NOW - 60 * 60_000 }),
      row({ sessionId: 'c', title: 'big refactor', workspaceId: 'ws1', activeTaskState: 'crashed' }),
      row({ sessionId: 'd', cwd: '/tmp/blog', blank: true }),
    ],
    { now: NOW, workspaceTitles: { ws1: 'dsh-channel' } },
  )

  assert.deepEqual(render.numbers, { a: 1, b: 2, c: 3, d: 4 })
  const lines = render.text.split('\n')
  assert.equal(lines[0], 'dsh-channel')
  assert.equal(lines[1], '▶ 1 · "fix merge window" · running 2m · ⏳approval')
  assert.equal(lines[2], '✓ 2 · "docs sync" · done 1h')
  assert.equal(lines[3], '✗ 3 · "big refactor" · crashed')
  // The ungrouped session falls under its cwd label, after the named workspace.
  assert.equal(lines[4], 'blog')
  assert.equal(lines[5], '· 4 · blog · (blank)')
  assert.match(lines[7]!, /\/use <n> focus/)
})

test('renderSessionList marks the focused row and keeps numbering input-independent', () => {
  const render = renderSessionList([row({ sessionId: 'a', focused: true }), row({ sessionId: 'b', running: true })], { now: NOW })
  const focusedLine = render.text.split('\n').find((line) => line.includes('1'))!
  assert.ok(focusedLine.endsWith('◀'))
  assert.deepEqual(render.numbers, { a: 1, b: 2 })
})

test('renderSessionList emits focus callbacks only within the callback_data budget', () => {
  const within = renderSessionList([row({ sessionId: 'short-id' })], { now: NOW, supportsChoices: true, maxValueBytes: 64 })
  assert.deepEqual(within.choices, [{ id: 'focus:short-id', label: '#1 short-id' }])

  const long = `channel:telegram:${'x'.repeat(60)}`
  const over = renderSessionList([row({ sessionId: long })], { now: NOW, supportsChoices: true, maxValueBytes: 64 })
  assert.deepEqual(over.choices, [])

  const noChoices = renderSessionList([row({ sessionId: 'short-id' })], { now: NOW })
  assert.deepEqual(noChoices.choices, [])
})

test('renderSessionList answers an empty registry with the onboarding line', () => {
  const render = renderSessionList([], { now: NOW })
  assert.match(render.text, /No sessions yet/)
  assert.deepEqual(render.numbers, {})
})

test('renderWorkspaceList numbers rows for /new resolution', () => {
  const render = renderWorkspaceList([
    { id: 'ws1', title: 'dsh-channel', path: '/tmp/dsh-channel', sessionCount: 2 },
    { id: 'ws2', title: 'blog', path: '/tmp/blog', sessionCount: 1 },
  ])
  assert.deepEqual(render.numbers, { ws1: 1, ws2: 2 })
  assert.equal(render.text.split('\n')[0], '1 dsh-channel · /tmp/dsh-channel · 2 sessions')
  assert.equal(render.text.split('\n')[1], '2 blog · /tmp/blog · 1 session')
})

// ---- status rendering ----

test('renderSessionStatus shows state, tool, interaction, todos, and the last text', () => {
  const text = renderSessionStatus({
    sessionId: 'sess:a',
    number: 2,
    title: 'fix merge window',
    cwd: '/tmp/dsh-channel',
    running: true,
    blank: false,
    currentTool: 'Bash',
    queued: 1,
    watchers: 2,
    pendingInteraction: 'approval',
    todos: [
      { content: 'read the design', status: 'completed' },
      { content: 'patch the reducer', status: 'in_progress' },
      { content: 'ship docs', status: 'pending' },
    ],
    lastAssistantText: 'looking into the merge window now',
    updatedAt: NOW - 5 * 60_000,
    now: NOW,
  })
  const lines = text.split('\n')
  assert.equal(lines[0], '#2 "fix merge window" (dsh-channel)')
  assert.match(lines[1]!, /^▶ running · tool: Bash · queued 1 · watched by 2 · 5m$/)
  assert.equal(lines[2], '⏳ waiting for an approval reply')
  assert.equal(lines[3], 'todos 1/3')
  assert.equal(lines[4], '  ✓ read the design')
  assert.equal(lines[5], '  ▶ patch the reducer')
  assert.equal(lines[6], '  · ship docs')
  assert.equal(lines[7], 'last: looking into the merge window now')
})

test('renderSessionStatus degrades for an idle unnamed session', () => {
  const text = renderSessionStatus({
    sessionId: 'channel:telegram:42',
    running: false,
    blank: false,
    watchers: 0,
    lastReason: 'completed',
    updatedAt: NOW,
    now: NOW,
  })
  const lines = text.split('\n')
  assert.match(lines[0]!, /channel…|42/)
  assert.match(lines[1]!, /^✓ idle · now$/)
})

// ---- misc renderers ----

test('renderForeignConfirm names the --take escape hatch', () => {
  assert.equal(
    renderForeignConfirm('3'),
    '⚠️ this session was not started by this host; resuming it here while another process has it open would corrupt its log — reply `/use 3 --take` to adopt',
  )
})

test('relativeTimeLabel buckets minutes, hours, and days', () => {
  assert.equal(relativeTimeLabel(NOW, NOW), 'now')
  assert.equal(relativeTimeLabel(NOW - 30_000, NOW), 'now')
  assert.equal(relativeTimeLabel(NOW - 2 * 60_000, NOW), '2m')
  assert.equal(relativeTimeLabel(NOW - 3 * 60 * 60_000, NOW), '3h')
  assert.equal(relativeTimeLabel(NOW - 2 * 24 * 60 * 60_000, NOW), '2d')
  // Future timestamps clamp instead of going negative.
  assert.equal(relativeTimeLabel(NOW + 60_000, NOW), 'now')
})

test('pathLabel takes the last segment of posix and windows paths', () => {
  assert.equal(pathLabel('/tmp/dsh-channel'), 'dsh-channel')
  assert.equal(pathLabel('/tmp/dsh-channel/'), 'dsh-channel')
  assert.equal(pathLabel('C:\\work\\blog'), 'blog')
})
