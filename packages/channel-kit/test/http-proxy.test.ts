import assert from 'node:assert/strict'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect as netConnect } from 'node:net'
import { test } from 'node:test'
import { proxiedFetch } from '../src/http-proxy.ts'

// Self-signed cert for localhost (long-lived; generated for the proxy test only).
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC/B0taJ2fxVy7J
uVFH53s8AYy1vWqhg/M0GlALKFpx+Q6Rg6/vT6VGpt80bTby+RSvcq2wIpKvfeVO
996br1iROW0wk2ORT6KPjItBzs6gqaYMEuDSL/305IiWGyR3obqrS5IAXHIjzAGW
kJruuKZSsS5byKrgsqicrWxmRahKXtl9GAuxzTkXcINqQDZ7S30ToKCvlGT29iIg
8connLOqaUIs0rYMowa1S5U9FweP1utdLRXxv2pxChH2LgovcHA9KEk5oTO1/Bfz
DRo94WZhd3vCy6NnjOHtAOkoSyE7axEw99BPDMC9N2Ft60rvVkHpNVpTLc5hAUYV
bh04F6RNAgMBAAECggEAAJX8JC2kwve6fAHmfur11MxIazJGhnJKJ6nA/xfDlz/l
TIrz2i8LWbkfTCDdn0cmShd28uhYPNONBX37H80c320mqZR6JLLy06/hqXUB6zo5
+SWBrQNaqwqcZKF2ris/0FCuBPRDoVp50sVkxECquewzMTLfW0sQ+1II2BN0na3F
b5TPAc/PqYK+QCQS3RBHifSW6qGMMsdFccVOev7tLVWA4AQ2ldoFykCiHSyY9ZEc
tT6QODR39QwrSfTJoAcIDG/JFpZsvP3sdlySgLs1eYv1aoDdGvgKhDnBfnaePYfF
mcgGekDElZKtPlUa3y/WGHRw4q2eYYycZfqGzST8fQKBgQDjuzVFrUWaGaEVEeb8
BdZ7A/VS4zg5aNBY7ydpJGt8u15gPswKsQ6qYbLLIIeR5DKGYVGLaan/Qqzgtxmu
MBSM/w3IqgsCnEdKO123y0nolvHaQ5tAjkW/zquuMFwjFJBZYwv8cAV7ylCHzESe
RooJe49Dl+o+6R4y5zsFgYfGMwKBgQDWvcDo46WVqoILJkOSKiF0Y5C4gJ/j0Q1N
mUWZ8NfXFGJ/MrCRzW6bqGQamHhdQx0KGhRDgNbN3fbfkwq0HRcDwsXGIqyzwPuM
ZiDpEOOllcBD7umPo5lNFRIVwQZLp3nBSfCXp/MZNhJjLAh748Gr9T59vnFV8ORq
T2jdi4drfwKBgHdo5loOrPxMjAY8SN3FQd1nCe/YbNbNetHnNMcQ7buNk8LrqpnA
lWwJpnKUMAHzofqMdPGhCh5qm7OIztJjK6Ny6YtafkN0Jn1p+44v7iUjYNWNtY54
C2Kzv5mqieVrFvWH1fUb2AQ85VUParuDSUYHn+tVcOJj4g3W6T/N15+5AoGAOowJ
qHVIlAGk6v1HtvYdoOn0bxlCfo5knh+HxmzPrCg2oo9jbJ0h5vaGNGoVhvfhVvu9
QppB9mbqBBLG/ExiFfhoi5iwlWGsM580odak+mRVwy/EJhFonod8Iso5uS60F2rd
WbvEn78KTFeZCI4UI5n9q7Lcm53N6N41rRF5nmkCgYEAtkbbgUANnwBgCos/8c5d
fEbdiJ4oPKO2E4tejodp4Fwsz7NcwY4Dly1/owW9MIIFOjzeJPd/MMTRwOs9ggOw
+rs9ha9GgI3HzfCL+XzcAcbuYE7odoXLvRbSs8axkgyPxgi2vY7p29urWNJRMXYo
Rgmq5nvL2KArV7dJkcFclNY=
-----END PRIVATE KEY-----`

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUJMf4EhTvS3CjjxZxaHr+/NQ0dGAwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDgxNjA3MjA0OVoXDTM2MDgx
MzA3MjA0OVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAvwdLWidn8VcuyblRR+d7PAGMtb1qoYPzNBpQCyhacfkO
kYOv70+lRqbfNG028vkUr3KtsCKSr33lTvfem69YkTltMJNjkU+ij4yLQc7OoKmm
DBLg0i/99OSIlhskd6G6q0uSAFxyI8wBlpCa7rimUrEuW8iq4LKonK1sZkWoSl7Z
fRgLsc05F3CDakA2e0t9E6Cgr5Rk9vYiIPHKJ5yzqmlCLNK2DKMGtUuVPRcHj9br
XS0V8b9qcQoR9i4KL3BwPShJOaEztfwX8w0aPeFmYXd7wsujZ4zh7QDpKEshO2sR
MPfQTwzAvTdhbetK71ZB6TVaUy3OYQFGFW4dOBekTQIDAQABo1MwUTAdBgNVHQ4E
FgQUD8pmj66IqnPaN8aKnP57u2QDDs0wHwYDVR0jBBgwFoAUD8pmj66IqnPaN8aK
nP57u2QDDs0wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAIG2m
QtyGQsEz/03QB/F9OzvTOFBWPK7gLcSQtiNYtE7bb3s5KOkEYOOjZY2n0aU4mGHq
00IlG45IyqnSBIdpY+kr8tS9ArXhxI7jxohDSGuFHL+V4/Cu+ctCL9rMfAqwFmek
bKhmrY9KG/6KND8Zl9erUQT+rbGWU2spKjg3pHzgh+NKGXDrwefVCaFBKdfWAJ3n
ZcQhm/YWvR+vg9PdnnDNWZEPGQeWP6jOnxuEItbabV/Yi6yCxn/F5kpz6dOgaCev
oTYHqRueQJQXXiMIY4Pbh65nhBRGOAXN+rBkGT+nypOY2xJkLXAHSfRyNuB/ex4x
wdRPRG65bwj9jY3V0Q==
-----END CERTIFICATE-----`

async function listen(server: import('node:http').Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as import('node:net').AddressInfo).port
}

function shutdown(server: import('node:http').Server): void {
  server.closeAllConnections?.()
  server.close()
}

/** An HTTP proxy that supports CONNECT tunnelling (and passes absolute-form through as plain requests). */
function startProxy(): Promise<{ port: number; close: () => void }> {
  const sockets = new Set<import('node:net').Socket>()
  const proxy = createHttpServer()
  proxy.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  proxy.on('connect', (req, clientSocket, head) => {
    const [host, port] = String(req.url).split(':')
    const upstream = netConnect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    sockets.add(upstream)
    upstream.on('close', () => sockets.delete(upstream))
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  // Absolute-form http requests land here via the proxy's own request handler.
  proxy.on('request', (req, res) => {
    const target = new URL(String(req.url))
    const upstream = httpRequest(
      { host: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers: req.headers },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 200, upRes.headers)
        upRes.pipe(res)
      },
    )
    upstream.on('error', () => res.destroy())
    req.pipe(upstream)
  })
  return listen(proxy).then((port) => ({
    port,
    close: () => {
      for (const socket of sockets) socket.destroy()
      proxy.close()
    },
  }))
}

test('proxiedFetch tunnels HTTPS POST through a CONNECT proxy', async () => {
  const target = createHttpsServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, method: req.method, body: JSON.parse(body) }))
    })
  })
  const targetPort = await listen(target)
  const proxy = await startProxy()

  const fetch = proxiedFetch(`http://127.0.0.1:${proxy.port}`, { rejectUnauthorized: false })
  const res = await fetch(`https://localhost:${targetPort}/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  })
  const json = (await res.json()) as { ok: boolean; method: string; body: { hello: string } }
  assert.equal(res.status, 200)
  assert.deepEqual(json, { ok: true, method: 'POST', body: { hello: 'world' } })

  shutdown(target)
  shutdown(proxy)
})

test('proxiedFetch routes HTTP targets through the proxy with absolute-form', async () => {
  const target = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ path: req.url }))
  })
  const targetPort = await listen(target)
  const proxy = await startProxy()

  const fetch = proxiedFetch(`http://127.0.0.1:${proxy.port}`)
  const res = await fetch(`http://127.0.0.1:${targetPort}/hello?q=1`)
  const json = (await res.json()) as { path: string }
  assert.equal(res.status, 200)
  assert.equal(json.path, '/hello?q=1')

  shutdown(target)
  shutdown(proxy)
})

test('proxiedFetch serializes multipart FormData through the CONNECT tunnel', async () => {
  const target = createHttpsServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }))
    })
  })
  const targetPort = await listen(target)
  const proxy = await startProxy()

  const fetch = proxiedFetch(`http://127.0.0.1:${proxy.port}`, { rejectUnauthorized: false })
  const form = new FormData()
  form.set('chat_id', '42')
  form.set('document', new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' }), 'file.bin')
  const res = await fetch(`https://localhost:${targetPort}/upload`, { method: 'POST', body: form })
  const json = (await res.json()) as { type: string; body: string }
  assert.equal(res.status, 200)
  assert.match(json.type, /^multipart\/form-data; boundary=/)
  assert.ok(json.body.includes('name="chat_id"'))
  assert.ok(json.body.includes('name="document"; filename="file.bin"'))

  shutdown(target)
  shutdown(proxy)
})
