/**
 * Minimal HTTP(S) proxy transport for provider clients.
 *
 * The three provider clients already accept an injectable `fetch`; when the
 * deployment configures `proxyUrl` (the kit's shared `ChannelBehaviorConfig` fragment),
 * the client wraps its fetch with `proxiedFetch(proxyUrl)` so every API call —
 * JSON RPC and media downloads/uploads — routes through the proxy.
 *
 * Implemented on Node builtins (`net`/`tls`/`http`/`https`) instead of `undici`'s
 * `ProxyAgent` so the kit stays dependency-free: HTTPS targets tunnel via
 * `CONNECT`, HTTP targets use the absolute-form request URI, and both share one
 * body-serialization + response-mapping path. This mirrors the design doc's
 * "via `undici`'s `ProxyAgent` or equivalent" without pulling in a dependency.
 */

import { randomBytes } from 'node:crypto'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect, type Socket } from 'node:net'
import { Readable } from 'node:stream'

export interface ProxiedFetchOptions {
  /** Allow self-signed target certificates (tests / private CAs). Default false (verify). */
  rejectUnauthorized?: boolean
}

interface NormalizedRequest {
  method: string
  headers: HeadersInit | undefined
  body: BodyInit | null | undefined
}

/**
 * Wrap `fetch` to route every request through an HTTP proxy.
 * `proxyUrl` is an `http://[user:pass@]host:port` URL (HTTPS proxies are accepted
 * but TLS-to-proxy is rare; the target protocol decides CONNECT vs absolute-form).
 */
export function proxiedFetch(proxyUrl: string, opts: ProxiedFetchOptions = {}): typeof fetch {
  const proxy = new URL(proxyUrl)
  const rejectUnauthorized = opts.rejectUnauthorized ?? true
  const proxyAuth = proxy.username
    ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`
    : undefined

  return async (input, init): Promise<Response> => {
    const normalized = normalizeInput(input, init)
    const target = new URL(normalized.url)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error(`proxiedFetch: unsupported target protocol "${target.protocol}"`)
    }
    if (target.protocol === 'https:') {
      return requestViaConnectTunnel(proxy, target, normalized, proxyAuth, rejectUnauthorized)
    }
    return requestViaAbsoluteForm(proxy, target, normalized, proxyAuth)
  }
}

function normalizeInput(input: RequestInfo | URL, init?: RequestInit): NormalizedRequest & { url: string } {
  if (typeof input === 'string' || input instanceof URL) {
    return { url: String(input), method: init?.method ?? 'GET', headers: init?.headers, body: init?.body }
  }
  const request = input as Request
  return {
    url: request.url,
    method: init?.method ?? request.method,
    headers: init?.headers ?? request.headers,
    body: init?.body ?? request.body,
  }
}

async function requestViaConnectTunnel(
  proxy: URL,
  target: URL,
  req: NormalizedRequest,
  proxyAuth: string | undefined,
  rejectUnauthorized: boolean,
): Promise<Response> {
  const { buffer, contentType } = await serializeBody(req.body)
  const headers = toHeaderRecord(req.headers, contentType, buffer)

  // CONNECT through the proxy, then let https.request do the TLS handshake over
  // the returned raw socket (its rejectUnauthorized/servername options drive validation).
  const rawSocket = await openTunnel(proxy, target.hostname, targetPort(target), proxyAuth)

  return new Promise<Response>((resolve, reject) => {
    const out = httpsRequest({
      host: target.hostname,
      port: targetPort(target),
      path: target.pathname + target.search,
      method: req.method,
      headers,
      agent: false,
      rejectUnauthorized,
      servername: target.hostname,
      createConnection: () => rawSocket,
    })
    out.on('response', (res) => resolve(toResponse(res)))
    out.on('error', reject)
    if (buffer) out.write(buffer)
    out.end()
  })
}

function requestViaAbsoluteForm(
  proxy: URL,
  target: URL,
  req: NormalizedRequest,
  proxyAuth: string | undefined,
): Promise<Response> {
  return new Promise<Response>(async (resolve, reject) => {
    const { buffer, contentType } = await serializeBody(req.body)
    const headers = toHeaderRecord(req.headers, contentType, buffer)
    if (proxyAuth) headers['proxy-authorization'] = proxyAuth

    const out = httpRequest({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      path: target.href,
      method: req.method,
      headers,
      agent: false,
    })
    out.on('response', (res) => resolve(toResponse(res)))
    out.on('error', reject)
    if (buffer) out.write(buffer)
    out.end()
  })
}

/** Establish a CONNECT tunnel to `targetHost:targetPort` through the proxy and return the raw (pre-TLS) socket. */
function openTunnel(
  proxy: URL,
  targetHost: string,
  targetPort: number,
  proxyAuth: string | undefined,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host: proxy.hostname, port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)) })
    sock.once('connect', () => {
      let buf = ''
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString('latin1')
        const headerEnd = buf.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        sock.removeListener('data', onData)
        const statusLine = buf.slice(0, headerEnd).split('\r\n')[0] ?? ''
        if (!statusLine.includes(' 200')) {
          sock.destroy()
          reject(new Error(`proxy CONNECT failed: ${statusLine.trim()}`))
          return
        }
        // Any bytes after the response head belong to the (already-negotiating) TLS tunnel; push them back for the TLS handshake.
        const remainder = buf.slice(headerEnd + 4)
        if (remainder.length > 0) sock.unshift(Buffer.from(remainder, 'latin1'))
        resolve(sock)
      }
      sock.on('data', onData)
      sock.once('error', reject)
      const authLine = proxyAuth ? `Proxy-Authorization: ${proxyAuth}\r\n` : ''
      sock.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${targetHost}:${targetPort}\r\n` +
          authLine +
          '\r\n',
      )
    })
    sock.once('error', reject)
  })
}

function toHeaderRecord(headers: HeadersInit | undefined, contentType: string | undefined, buffer: Buffer | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (headers !== undefined) {
    new Headers(headers).forEach((value, key) => {
      out[key.toLowerCase()] = value
    })
  }
  if (contentType && out['content-type'] === undefined) out['content-type'] = contentType
  if (buffer) out['content-length'] = String(buffer.length)
  return out
}

function toResponse(res: IncomingMessage): Response {
  const headers = new Headers()
  for (const [key, value] of Object.entries(res.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    } else {
      headers.append(key, String(value))
    }
  }
  const status = res.statusCode ?? 200
  const body = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>
  return new Response(body, { status, headers })
}

async function serializeBody(body: BodyInit | null | undefined): Promise<{ buffer: Buffer | null; contentType?: string }> {
  if (body === undefined || body === null) return { buffer: null }
  if (typeof body === 'string') return { buffer: Buffer.from(body, 'utf8'), contentType: 'text/plain;charset=UTF-8' }
  if (body instanceof URLSearchParams) return { buffer: Buffer.from(body.toString(), 'utf8'), contentType: 'application/x-www-form-urlencoded;charset=UTF-8' }
  if (body instanceof FormData) return serializeFormData(body)
  if (body instanceof ArrayBuffer) return { buffer: Buffer.from(new Uint8Array(body)), contentType: 'application/octet-stream' }
  if (ArrayBuffer.isView(body)) return { buffer: Buffer.from(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength), contentType: 'application/octet-stream' }
  if (body instanceof Blob) return { buffer: Buffer.from(await body.arrayBuffer()), contentType: body.type || 'application/octet-stream' }
  if (body instanceof ReadableStream) {
    const reader = body.getReader()
    const chunks: Buffer[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(Buffer.from(value))
    }
    return { buffer: Buffer.concat(chunks), contentType: 'application/octet-stream' }
  }
  throw new Error('proxiedFetch: unsupported body type')
}

async function serializeFormData(form: FormData): Promise<{ buffer: Buffer; contentType: string }> {
  const boundary = `----dsh-proxy-${randomBytes(12).toString('hex')}`
  const parts: Buffer[] = []
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${escapeHeaderValue(name)}"\r\n\r\n${value}\r\n`))
    } else {
      const bytes = Buffer.from(await value.arrayBuffer())
      const filename = value instanceof File && value.name !== '' ? value.name : 'blob'
      const type = value.type || 'application/octet-stream'
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${escapeHeaderValue(name)}"; filename="${escapeHeaderValue(filename)}"\r\nContent-Type: ${type}\r\n\r\n`,
        ),
      )
      parts.push(bytes)
      parts.push(Buffer.from('\r\n'))
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { buffer: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

function escapeHeaderValue(value: string): string {
  return value.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

function targetPort(target: URL): number {
  if (target.port) return Number(target.port)
  return target.protocol === 'https:' ? 443 : 80
}
