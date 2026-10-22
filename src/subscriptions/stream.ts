import { createFrameParser, StreamBody } from './frames'

/** What the client accepts for a subscription: SSE first, Apollo's multipart protocol second, JSON for an error response. */
export const SUBSCRIPTION_ACCEPT = 'text/event-stream, multipart/mixed;subscriptionSpec="1.0", application/json'

type Headers = { [key: string]: string }

export type SubscriptionResponse = {
  status: number
  headers: Headers
  contentType: string
  /** The response body, undefined when the environment's `fetch` does not expose it as a stream. */
  body: ReadableStream<Uint8Array> | null | undefined
  /** Reads the whole body as text, for a response that is not a stream. */
  text: () => Promise<string>
}

/** The `fetch` the subscription transport uses: the global one, resolved per call so a polyfill installed later counts. */
function resolveFetch(): typeof fetch {
  const candidate = (globalThis as { fetch?: typeof fetch }).fetch
  if (typeof candidate !== 'function') {
    throw new Error('GraphQL subscriptions need a global fetch with streaming responses, and this environment has none')
  }
  return candidate
}

/** Posts a subscription operation and resolves once the response headers arrive; the body is still streaming. */
export async function openSubscription(options: {
  url: string
  headers: Headers
  body: { query: string; variables: unknown; operationName: string }
  signal: AbortSignal
}): Promise<SubscriptionResponse> {
  const response = await resolveFetch()(options.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: SUBSCRIPTION_ACCEPT, ...options.headers },
    body: JSON.stringify(options.body),
    signal: options.signal,
  })

  const headers: Headers = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })

  return {
    status: response.status,
    headers,
    contentType: response.headers.get('content-type') ?? '',
    body: response.body,
    text: () => response.text(),
  }
}

export type FrameSink = {
  /** The response is a stream this client reads, and reading has begun. */
  open(): void
  next(body: StreamBody): void
  error(error: unknown): void
  complete(): void
}

/**
 * Reads a streamed subscription response to its end, handing every GraphQL result to `sink`. Resolves when the
 * stream completes or the sink has been told of an error; a read that fails because `signal` was aborted is a
 * completion, since the client asked for it.
 */
export async function readSubscription(response: SubscriptionResponse, signal: AbortSignal, sink: FrameSink): Promise<void> {
  const parser = createFrameParser(response.contentType)
  if (!parser) {
    sink.error(new Error(`Expected a subscription stream, but the server answered with "${response.contentType}"`))
    return
  }
  if (!response.body) {
    sink.error(new Error('The subscription response has no readable body in this environment'))
    return
  }

  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let finished = false
  sink.open()

  const deliver = (frames: ReturnType<typeof parser.push>): boolean => {
    for (const frame of frames) {
      if (frame.kind === 'next') sink.next(frame.body)
      else if (frame.kind === 'complete') {
        sink.complete()
        return true
      } else {
        sink.error(new Error(frame.message))
        return true
      }
    }
    return false
  }

  try {
    while (!finished) {
      const { value, done } = await reader.read()
      if (done) {
        finished = deliver(parser.end())
        if (!finished) sink.complete()
        return
      }
      finished = deliver(parser.push(decoder.decode(value, { stream: true })))
    }
    reader.cancel().catch(() => undefined)
  } catch (error) {
    if (signal.aborted) sink.complete()
    else sink.error(error)
  }
}
