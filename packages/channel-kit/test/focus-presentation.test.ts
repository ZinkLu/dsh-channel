import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveFocusPresentation, sessionBadge, shortenSessionId } from '../src/policy/focus-presentation.ts'

test('the focus session streams exactly like the single-session past', () => {
  assert.equal(resolveFocusPresentation({ isFocused: true, kind: 'stream' }), 'stream')
})

test('a watched non-focus session never streams', () => {
  assert.equal(resolveFocusPresentation({ isFocused: false, kind: 'stream' }), 'silent')
})

test('turn-end summaries go to watchers only — the focus chat already lives the turn', () => {
  assert.equal(resolveFocusPresentation({ isFocused: true, kind: 'turn-end' }), 'silent')
  assert.equal(resolveFocusPresentation({ isFocused: false, kind: 'turn-end' }), 'deliver-badged')
})

test('explicit notify_user text and errors reach the focus chat unbadged, watchers badged', () => {
  assert.equal(resolveFocusPresentation({ isFocused: true, kind: 'notify' }), 'deliver')
  assert.equal(resolveFocusPresentation({ isFocused: false, kind: 'notify' }), 'deliver-badged')
  assert.equal(resolveFocusPresentation({ isFocused: true, kind: 'error' }), 'deliver')
  assert.equal(resolveFocusPresentation({ isFocused: false, kind: 'error' }), 'deliver-badged')
})

test('approvals and questions are broker traffic, never outbox traffic', () => {
  assert.equal(resolveFocusPresentation({ isFocused: true, kind: 'approval' }), 'silent')
  assert.equal(resolveFocusPresentation({ isFocused: false, kind: 'approval' }), 'silent')
  assert.equal(resolveFocusPresentation({ isFocused: true, kind: 'question' }), 'silent')
  assert.equal(resolveFocusPresentation({ isFocused: false, kind: 'question' }), 'silent')
})

test('the badge carries the per-chat number and the session title', () => {
  assert.equal(sessionBadge({ number: 2, title: 'docs sync', sessionId: 'sess:x' }), '[#2 docs sync]')
  // No number (never listed) → title only; no title → the shortened id tail.
  assert.equal(sessionBadge({ title: 'docs sync', sessionId: 'sess:x' }), '[docs sync]')
  assert.equal(sessionBadge({ number: 4, sessionId: 'channel:telegram:42' }), '[#4 42]')
  assert.equal(sessionBadge({ sessionId: 'b4d2c8f1-7dcb-4a17-9ba7-2f4b6c1d0e33' }), '[b4d2c8f1…]')
})

test('shortenSessionId keeps conventional chat keys whole and trims uuids', () => {
  assert.equal(shortenSessionId('channel:telegram:5002186681'), '5002186681')
  assert.equal(shortenSessionId('no-colons'), 'no-colons')
  assert.equal(shortenSessionId('x:b4d2c8f1-7dcb-4a17'), 'b4d2c8f1…')
})
