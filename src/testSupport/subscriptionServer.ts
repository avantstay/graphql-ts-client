import http from 'http'
import { AddressInfo } from 'net'

export type ReceivedRequest = { body: any; headers: http.IncomingHttpHeaders }

/** What one scripted response writes: the status, headers and the chunks to stream, with an optional hang before closing. */
export type ScriptedResponse = {
  status?: number
  headers?: Record<string, string>
  chunks: string[]
  /** Keep the response open after the last chunk until the client goes away or the server stops. */
  hang?: boolean
  /** Sever the socket after the last chunk instead of ending the response cleanly. */
  destroy?: boolean
}

/** Server-Sent Events frames exactly as the support endpoint writes them. */
export const sse = {
  next: (body: unknown) => `event: next\ndata: ${JSON.stringify(body)}\n\n`,
  heartbeat: ':\n\n',
  complete: 'event: complete\ndata:\n\n',
  contentType: 'text/event-stream',
}

/** Apollo multipart frames exactly as the support endpoint writes them, with its fixed `graphql` boundary. */
export const multipart = {
  next: (body: unknown) => `\r\n--graphql\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({ payload: body })}`,
  heartbeat: '\r\n--graphql\r\ncontent-type: application/json\r\n\r\n{}',
  complete: '\r\n--graphql--\r\n',
  contentType: 'multipart/mixed; boundary="graphql"; subscriptionSpec="1.0"',
}

const tick = () => new Promise(resolve => setImmediate(resolve))

/**
 * A GraphQL server for subscription tests: every POST is recorded and answered by the current script. Chunks are
 * written one per tick, so the client sees them as separate reads.
 */
export async function startSubscriptionServer() {
  const requests: ReceivedRequest[] = []
  const open = new Set<http.ServerResponse>()
  let script: (request: ReceivedRequest) => ScriptedResponse = () => ({ chunks: [] })

  const server = http.createServer((request, response) => {
    let raw = ''
    request.on('data', chunk => (raw += chunk))
    request.on('end', async () => {
      const received = { body: raw ? JSON.parse(raw) : undefined, headers: request.headers }
      requests.push(received)
      const scripted = script(received)
      response.writeHead(scripted.status ?? 200, scripted.headers ?? { 'content-type': 'application/json' })
      open.add(response)
      response.on('close', () => open.delete(response))
      for (const chunk of scripted.chunks) {
        if (response.destroyed) return
        response.write(chunk)
        await tick()
      }
      if (scripted.destroy) response.destroy()
      else if (!scripted.hang) response.end()
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}/graphql`,
    requests,
    respondWith(next: (request: ReceivedRequest) => ScriptedResponse) {
      script = next
    },
    /** Resolves once the client has dropped every open response, or fails after a second. */
    async waitForClientClose() {
      const deadline = Date.now() + 1000
      while (open.size > 0) {
        if (Date.now() > deadline) throw new Error(`${open.size} response(s) still open`)
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    },
    async stop() {
      open.forEach(response => response.destroy())
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
