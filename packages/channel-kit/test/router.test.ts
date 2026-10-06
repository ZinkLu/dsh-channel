import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conventionResolver, focusResolver, resolveUpstream, route, type UpstreamResolver } from '../src/policy/router.ts'

const ctx = {
  channel: 'telegram',
  boundSessions: { chat1: 'sess-1' },
  liveSessionIds: ['sess-1'],
}

test('empty text is dropped', () => {
  assert.deepEqual(route({ chatKey: 'chat1', text: '   ', chatType: 'direct' }, ctx), { kind: 'drop', reason: 'empty' })
})

test('group chat is dropped in v1', () => {
  assert.deepEqual(route({ chatKey: 'chat1', text: 'hi', chatType: 'group', mentionsBot: true }, ctx), { kind: 'drop', reason: 'group-unsupported' })
})

test('/ commands are routed to local handling', () => {
  assert.deepEqual(route({ chatKey: 'chat1', text: '/new', chatType: 'direct' }, ctx), { kind: 'command', command: 'new', args: '' })
  assert.deepEqual(route({ chatKey: 'chat1', text: '/bind sess-2', chatType: 'direct' }, ctx), { kind: 'command', command: 'bind', args: 'sess-2' })
})

test('bound chat routes to existing session without create (provenance: focus)', () => {
  assert.deepEqual(route({ chatKey: 'chat1', text: 'hi', chatType: 'direct' }, ctx), { kind: 'route', sessionId: 'sess-1', create: false, provenance: 'focus' })
})

test('unbound chat uses convention session id and create (provenance: convention)', () => {
  assert.deepEqual(route({ chatKey: 'chat2', text: 'hi', chatType: 'direct' }, ctx), { kind: 'route', sessionId: 'channel:telegram:chat2', create: true, provenance: 'convention' })
})

test('non-default account adds an account segment to the session id', () => {
  const multi = { ...ctx, accountId: 'prod' }
  assert.deepEqual(route({ chatKey: 'chat2', text: 'hi', chatType: 'direct' }, multi), { kind: 'route', sessionId: 'channel:telegram:prod:chat2', create: true, provenance: 'convention' })
  // default account keeps the single-account session id byte-for-byte
  assert.deepEqual(route({ chatKey: 'chat2', text: 'hi', chatType: 'direct' }, { ...ctx, accountId: 'default' }), { kind: 'route', sessionId: 'channel:telegram:chat2', create: true, provenance: 'convention' })
})

test('approval reply predicate routes to approval-reply', () => {
  const decision = route({ chatKey: 'chat1', text: '1', chatType: 'direct' }, ctx, {
    isApprovalReply: (text) => text === '1',
  })
  assert.deepEqual(decision, { kind: 'approval-reply', raw: '1' })
})

test('a custom sessionIdPrefix keeps the convention resolver byte-compatible', () => {
  assert.deepEqual(route({ chatKey: 'chat2', text: 'hi', chatType: 'direct' }, ctx, { sessionIdPrefix: 'im' }), { kind: 'route', sessionId: 'im:telegram:chat2', create: true, provenance: 'convention' })
})

// ---- resolver chain tri-state (backlog §2.2) ----

test('null stops the chain as an explicit rejection and route() drops', () => {
  const rejecting: UpstreamResolver = () => null
  const never = () => {
    throw new Error('a rejection must stop the chain before later resolvers run')
  }
  assert.equal(resolveUpstream({ chatKey: 'c', text: 'x', chatType: 'direct' }, ctx, [rejecting, never]), null)
  assert.deepEqual(route({ chatKey: 'chat1', text: 'hi', chatType: 'direct' }, ctx, { resolvers: [rejecting] }), { kind: 'drop', reason: 'rejected' })
})

test('undefined is no opinion: the chain falls through to the convention tail', () => {
  const pass: UpstreamResolver = () => undefined
  const hit = resolveUpstream({ chatKey: 'chat9', text: 'x', chatType: 'direct' }, ctx, [pass, focusResolver, conventionResolver()])
  assert.deepEqual(hit, { sessionId: 'channel:telegram:chat9', create: true, provenance: 'convention' })
})

test('an exhausted chain rejects rather than inventing a target', () => {
  assert.equal(resolveUpstream({ chatKey: 'chat1', text: 'x', chatType: 'direct' }, ctx, [() => undefined]), null)
})

test('the first hit wins and carries its own provenance', () => {
  const custom: UpstreamResolver = (msg) => ({ sessionId: `pinned:${msg.chatKey}`, create: false, provenance: 'pinned' })
  const hit = resolveUpstream({ chatKey: 'chat1', text: 'x', chatType: 'direct' }, ctx, [() => undefined, custom, focusResolver])
  assert.deepEqual(hit, { sessionId: 'pinned:chat1', create: false, provenance: 'pinned' })
})
