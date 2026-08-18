/**
 * Protobuf envelope encode/decode for Feishu long-connection (WebSocket) frames.
 *
 * Feishu long-connection mode sends and receives binary frames over `wss://…`; the frame
 * format is a minimal protobuf:
 *
 *   message Frame {
 *     uint64 seq_id  = 1;   // varint
 *     uint64 log_id  = 2;   // varint
 *     int32  service = 3;   // varint
 *     int32  method  = 4;   // varint
 *     repeated Header headers = 5;   // Header { 1:string key; 2:string value }
 *     bytes  payload = 8;   // event JSON / ack JSON / pong config JSON
 *   }
 *
 * Only the two wire types this envelope needs — varint and length-delimited — are implemented,
 * without pulling in a third-party protobuf library (keeping the provider dependency-free at
 * runtime, consistent with the Telegram/WeChat fetch seam).
 */

export interface FeishuWsFrame {
  seqId: number
  logId: number
  service: number
  method: number
  /** Header key-value pairs (`type`: `event` | `pong` | `ping`, etc.). */
  headers: Record<string, string>
  /** JSON payload (bytes) of the event/ack/pong. */
  payload: Uint8Array | null
}

const WIRE_VARINT = 0
const WIRE_BYTES = 2

export function encodeFrame(frame: Omit<FeishuWsFrame, 'headers'> & { headers?: Record<string, string> }): Uint8Array {
  const parts: number[] = []
  writeVarintField(parts, 1, frame.seqId)
  writeVarintField(parts, 2, frame.logId)
  writeVarintField(parts, 3, frame.service)
  writeVarintField(parts, 4, frame.method)

  for (const [key, value] of Object.entries(frame.headers ?? {})) {
    const header: number[] = []
    writeBytesField(header, 1, encoder.encode(key))
    writeBytesField(header, 2, encoder.encode(value))
    writeBytesField(parts, 5, header)
  }

  if (frame.payload !== null && frame.payload !== undefined && frame.payload.length > 0) {
    writeBytesField(parts, 8, Array.from(frame.payload))
  }

  return Uint8Array.from(parts)
}

export function decodeFrame(buf: Uint8Array): FeishuWsFrame {
  const frame: FeishuWsFrame = { seqId: 0, logId: 0, service: 0, method: 0, headers: {}, payload: null }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let pos = 0

  while (pos < buf.length) {
    const tag = readVarint(view, pos)
    pos = tag.pos
    const field = Math.floor(tag.value / 8)
    const wireType = tag.value % 8

    if (wireType === WIRE_VARINT) {
      const v = readVarint(view, pos)
      pos = v.pos
      if (field === 1) frame.seqId = v.value
      else if (field === 2) frame.logId = v.value
      else if (field === 3) frame.service = v.value
      else if (field === 4) frame.method = v.value
    } else if (wireType === WIRE_BYTES) {
      const len = readVarint(view, pos)
      pos = len.pos
      const start = pos
      pos += len.value
      const bytes = buf.subarray(start, pos)
      if (field === 5) {
        const header = decodeHeader(bytes)
        if (header !== null) frame.headers[header.key] = header.value
      } else if (field === 8) {
        frame.payload = bytes
      }
    } else {
      // Skip unknown wire types (0=varint, 1=64bit, 2=bytes, 5=32bit).
      if (wireType === 0) {
        pos = readVarint(view, pos).pos
      } else if (wireType === 1) {
        pos += 8
      } else if (wireType === 2) {
        const len = readVarint(view, pos)
        pos = len.pos + len.value
      } else if (wireType === 5) {
        pos += 4
      } else {
        throw new Error(`feishu ws frame: unsupported wire type ${wireType}`)
      }
    }
  }

  return frame
}

function decodeHeader(buf: Uint8Array): { key: string; value: string } | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let pos = 0
  let key = ''
  let value = ''

  while (pos < buf.length) {
    const tag = readVarint(view, pos)
    pos = tag.pos
    const field = Math.floor(tag.value / 8)
    const wireType = tag.value % 8
    if (wireType !== WIRE_BYTES) {
      // Skip unknown wire types.
      if (wireType === 0) pos = readVarint(view, pos).pos
      else if (wireType === 1) pos += 8
      else if (wireType === 5) pos += 4
      else throw new Error(`feishu ws header: unsupported wire type ${wireType}`)
      continue
    }
    const len = readVarint(view, pos)
    pos = len.pos
    const start = pos
    pos += len.value
    const text = decoder.decode(buf.subarray(start, pos))
    if (field === 1) key = text
    else if (field === 2) value = text
  }

  if (key === '' && value === '') return null
  return { key, value }
}

function writeVarintField(out: number[], field: number, value: number): void {
  writeVarint(out, (field << 3) | WIRE_VARINT)
  writeVarint(out, value)
}

function writeBytesField(out: number[], field: number, bytes: Uint8Array | number[]): void {
  writeVarint(out, (field << 3) | WIRE_BYTES)
  writeVarint(out, bytes.length)
  for (const byte of bytes) out.push(byte)
}

function writeVarint(out: number[], value: number): void {
  let v = value >>> 0
  // Support varints up to 2^53 (JS safe-integer range).
  if (value > 0xffffffff || value < 0) {
    // Large numbers take the slow bigint path; a frame's service/method/seq are all small integers.
    let big = BigInt(value)
    while (big > 0x7fn) {
      out.push(Number((big & 0x7fn) | 0x80n))
      big >>= 7n
    }
    out.push(Number(big))
    return
  }
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
}

function readVarint(view: DataView, start: number): { value: number; pos: number } {
  let value = 0
  let shift = 0
  let pos = start
  while (pos < view.byteLength) {
    const byte = view.getUint8(pos)
    pos++
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  return { value, pos }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
