import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeFrame, encodeFrame } from '../src/proto.ts'

test('encodeFrame/decodeFrame round-trips fields', () => {
  const payload = new TextEncoder().encode('{"event_type":"im.message.receive_v1"}')
  const encoded = encodeFrame({
    seqId: 7,
    logId: 42,
    service: 3,
    method: 2,
    headers: { type: 'event' },
    payload,
  })
  const decoded = decodeFrame(encoded)

  assert.equal(decoded.seqId, 7)
  assert.equal(decoded.logId, 42)
  assert.equal(decoded.service, 3)
  assert.equal(decoded.method, 2)
  assert.equal(decoded.headers['type'], 'event')
  assert.equal(decoded.payload !== null, true)
  assert.equal(new TextDecoder().decode(decoded.payload!), '{"event_type":"im.message.receive_v1"}')
})

test('decodeFrame parses a ping control frame', () => {
  const encoded = encodeFrame({ seqId: 0, logId: 0, service: 9, method: 0, headers: { type: 'ping' }, payload: null })
  const decoded = decodeFrame(encoded)
  assert.equal(decoded.method, 0)
  assert.equal(decoded.headers['type'], 'ping')
  assert.equal(decoded.payload, null)
})

test('encodeFrame with no payload omits field 8', () => {
  const encoded = encodeFrame({ seqId: 1, logId: 0, service: 0, method: 0, headers: {}, payload: null })
  const decoded = decodeFrame(encoded)
  assert.equal(decoded.seqId, 1)
  assert.equal(decoded.payload, null)
})

test('decodeFrame handles multi-byte varint values', () => {
  // 300 = 0xAC 0x02 in varint (field 1 seq_id, wire type 0 → tag 0x08).
  const buf = Uint8Array.from([0x08, 0xac, 0x02])
  const decoded = decodeFrame(buf)
  assert.equal(decoded.seqId, 300)
})
