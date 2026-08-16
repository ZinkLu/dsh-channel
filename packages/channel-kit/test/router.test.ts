import assert from 'node:assert/strict'
import { test } from 'node:test'
import { route } from '../src/policy/router.ts'

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

test('bound chat routes to existing session without create', () => {
  assert.deepEqual(route({ chatKey: 'chat1', text: 'hi', chatType: 'direct' }, ctx), { kind: 'route', sessionId: 'sess-1', create: false })
})

test('unbound chat uses convention session id and create', () => {
  assert.deepEqual(route({ chatKey: 'chat2', text: 'hi', chatType: 'direct' }, ctx), { kind: 'route', sessionId: 'channel:telegram:chat2', create: true })
})

test('non-default account adds an account segment to the session id', () => {
  const multi = { ...ctx, accountId: 'prod' }
  assert.deepEqual(route({ chatKey: 'chat2', text: 'hi', chatType: 'direct' }, multi), { kind: 'route', sessionId: 'channel:telegram:prod:chat2', create: true })
  // default account keeps the single-account session id byte-for-byte
  assert.deepEqual(route({ chatKey: 'chat2', text: 'hi', chatType: 'direct' }, { ...ctx, accountId: 'default' }), { kind: 'route', sessionId: 'channel:telegram:chat2', create: true })
})

test('approval reply predicate routes to approval-reply', () => {
  const decision = route({ chatKey: 'chat1', text: '1', chatType: 'direct' }, ctx, {
    isApprovalReply: (text) => text === '1',
  })
  assert.deepEqual(decision, { kind: 'approval-reply', raw: '1' })
})
