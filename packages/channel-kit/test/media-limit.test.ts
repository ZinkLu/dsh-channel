import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertMediaWithinLimit, DEFAULT_MAX_INBOUND_MEDIA_BYTES } from '../src/media-limit.ts'

test('DEFAULT_MAX_INBOUND_MEDIA_BYTES is 20 MiB', () => {
  assert.equal(DEFAULT_MAX_INBOUND_MEDIA_BYTES, 20 * 1024 * 1024)
})

test('assertMediaWithinLimit throws when bytes exceed the cap', () => {
  assert.throws(
    () => assertMediaWithinLimit(21 * 1024 * 1024, 20 * 1024 * 1024, 'image'),
    /exceeds the media size limit/,
  )
})

test('assertMediaWithinLimit passes when bytes are within the cap', () => {
  assert.doesNotThrow(() => assertMediaWithinLimit(20 * 1024 * 1024, 20 * 1024 * 1024, 'image'))
  assert.doesNotThrow(() => assertMediaWithinLimit(0, 20 * 1024 * 1024, 'image'))
})

test('assertMediaWithinLimit treats non-positive or non-finite cap as no limit', () => {
  assert.doesNotThrow(() => assertMediaWithinLimit(Number.MAX_SAFE_INTEGER, 0, 'image'))
  assert.doesNotThrow(() => assertMediaWithinLimit(Number.MAX_SAFE_INTEGER, -1, 'image'))
  assert.doesNotThrow(() => assertMediaWithinLimit(Number.MAX_SAFE_INTEGER, Number.NaN, 'image'))
})
