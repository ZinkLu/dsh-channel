/**
 * Inbound media size guard (pure check, no IO).
 *
 * The provider owns the actual streaming read (it reads incrementally and calls
 * this guard on the running byte count, aborting *before* an oversized payload is
 * fully buffered); this module only holds the shared limit constant and the pure
 * assertion so the cap stays a single, testable fact across providers.
 */

/** Default inbound media cap (20 MiB, mirroring Telegram's own photo size cap). */
export const DEFAULT_MAX_INBOUND_MEDIA_BYTES = 20 * 1024 * 1024

/**
 * Throw when `bytes` exceeds `maxBytes`. Non-positive or non-finite `maxBytes`
 * means "no limit" (a defensive no-op: a typo'd `0` must not brick media).
 */
export function assertMediaWithinLimit(bytes: number, maxBytes: number, kind: string): void {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return
  if (bytes > maxBytes) {
    throw new Error(`inbound ${kind} exceeds the media size limit (${bytes} bytes > ${maxBytes} bytes)`)
  }
}
