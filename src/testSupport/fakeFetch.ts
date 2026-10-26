/** One request the fake `fetch` received, with the controls to stream its response body. */
export type FakeConnection = {
  headers: Record<string, string>
  body: any
  signal: AbortSignal
  /** Streams `text` as the next chunk of the response body. */
  push(text: string): void
  /** Ends the response body cleanly. */
  end(): void
  /** Fails the response body mid-stream, as a dropped connection does. */
  fail(error?: unknown): void
}

/** How the fake server answers one request: response headers now, or a network failure. */
export type FakeAnswer = { status?: number; contentType?: string; text?: string } | { reject: unknown }

/**
 * Replaces the global `fetch` with one whose responses are `ReadableStream`s the test drives, and which honours the
 * request's `AbortSignal` the way a browser does. Returns the connections it opened, in order, and a restore function.
 */
export function installFakeFetch(answer: (connection: FakeConnection, index: number) => FakeAnswer = () => ({})) {
  const original = globalThis.fetch
  const connections: FakeConnection[] = []
  const encoder = new TextEncoder()

  globalThis.fetch = ((_url: string, init: RequestInit) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let closed = false
    const stream = new ReadableStream<Uint8Array>({
      start: streamController => {
        controller = streamController
      },
    })
    const signal = init.signal as AbortSignal
    const connection: FakeConnection = {
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
      signal,
      push: text => {
        if (!closed) controller.enqueue(encoder.encode(text))
      },
      end: () => {
        if (closed) return
        closed = true
        controller.close()
      },
      fail: (error = new TypeError('network error')) => {
        if (closed) return
        closed = true
        controller.error(error)
      },
    }
    connections.push(connection)

    const abortError = () => new DOMException('This operation was aborted', 'AbortError')
    if (signal.aborted) return Promise.reject(abortError())
    signal.addEventListener('abort', () => connection.fail(abortError()))

    const answered = answer(connection, connections.length - 1)
    if ('reject' in answered) return Promise.reject(answered.reject)
    const { status = 200, contentType = 'text/event-stream', text } = answered
    if (text !== undefined) {
      connection.push(text)
      connection.end()
    }
    return Promise.resolve(new Response(stream, { status, headers: { 'content-type': contentType } }))
  }) as typeof fetch

  return {
    connections,
    restore: () => {
      globalThis.fetch = original
    },
  }
}
