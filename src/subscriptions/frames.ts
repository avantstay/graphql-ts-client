/** The GraphQL envelope one subscription result carries; a transport error part carries `errors` and no `data`. */
export type StreamBody = { data?: any; errors?: any[]; warnings?: any; extensions?: { warnings?: any } }

/** One unit of a subscription stream after the transport framing is removed; heartbeats produce no frame. */
export type StreamFrame = { kind: 'next'; body: StreamBody } | { kind: 'complete' } | { kind: 'error'; message: string }

/** Turns the text of a streamed response into frames, however the text happens to be chunked. */
export type FrameParser = {
  /** Frames completed by this chunk, in order. */
  push(chunk: string): StreamFrame[]
  /** Frames completed by the end of the response. */
  end(): StreamFrame[]
}

/** The parser for a subscription response's `Content-Type`, or undefined when it is not a stream this client reads. */
export function createFrameParser(contentType: string): FrameParser | undefined {
  const mediaType = contentType.split(';')[0].trim().toLowerCase()
  if (mediaType === 'text/event-stream') return serverSentEventsParser()
  if (mediaType === 'multipart/mixed') {
    const boundary = readBoundary(contentType)
    return boundary ? multipartParser(boundary) : undefined
  }
  return undefined
}

/** The `boundary` parameter of a multipart content type, quoted or not. */
function readBoundary(contentType: string): string | undefined {
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  return match ? match[1] ?? match[2] : undefined
}

function parseJsonFrame(text: string): StreamFrame | undefined {
  try {
    return { kind: 'next', body: JSON.parse(text) }
  } catch (error) {
    return { kind: 'error', message: `Could not parse a subscription event as JSON: ${text}` }
  }
}

/**
 * GraphQL over Server-Sent Events, distinct connections mode: each `next` event's data is one GraphQL response, a
 * `complete` event ends the stream, and a comment line (`:`) is a heartbeat.
 */
function serverSentEventsParser(): FrameParser {
  let buffered = ''

  const parseEvent = (eventText: string): StreamFrame | undefined => {
    let eventName = 'message'
    const dataLines: string[] = []
    for (const line of eventText.split('\n')) {
      if (line.startsWith(':')) continue
      const separator = line.indexOf(':')
      const field = separator === -1 ? line : line.slice(0, separator)
      let value = separator === -1 ? '' : line.slice(separator + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') eventName = value
      else if (field === 'data') dataLines.push(value)
    }
    if (eventName === 'complete') return { kind: 'complete' }
    if (eventName === 'next') return parseJsonFrame(dataLines.join('\n'))
    return undefined
  }

  const drain = (final: boolean): StreamFrame[] => {
    const frames: StreamFrame[] = []
    const events = buffered.replace(/\r\n?/g, '\n').split('\n\n')
    buffered = final ? '' : events.pop() ?? ''
    for (const eventText of events) {
      const frame = eventText.trim() ? parseEvent(eventText) : undefined
      if (frame) frames.push(frame)
    }
    return frames
  }

  return {
    push(chunk) {
      buffered += chunk
      return drain(false)
    },
    end() {
      return drain(true)
    },
  }
}

/**
 * Apollo's multipart subscription protocol: every part is a JSON object; `payload` carries one GraphQL response, an
 * empty object is a heartbeat, and `payload: null` with `errors` is a fatal transport error. The closing boundary
 * ends the stream.
 */
function multipartParser(boundary: string): FrameParser {
  const delimiter = `--${boundary}`
  const closingDelimiter = `--${boundary}--`
  let buffered = ''
  let completed = false

  const parsePart = (part: string): StreamFrame | undefined => {
    const bodyStart = part.indexOf('\r\n\r\n')
    const body = (bodyStart === -1 ? part : part.slice(bodyStart + 4)).trim()
    if (!body) return undefined
    const frame = parseJsonFrame(body)
    if (!frame || frame.kind !== 'next') return frame
    const envelope = frame.body as { payload?: StreamBody | null; errors?: any[] }
    if (envelope.payload) return { kind: 'next', body: envelope.payload }
    if (envelope.errors) return { kind: 'next', body: { errors: envelope.errors } }
    return undefined
  }

  const drain = (): StreamFrame[] => {
    const frames: StreamFrame[] = []
    while (!completed) {
      const start = buffered.indexOf(delimiter)
      if (start === -1) break
      const afterDelimiter = start + delimiter.length
      if (buffered.startsWith('--', afterDelimiter)) {
        completed = true
        buffered = ''
        frames.push({ kind: 'complete' })
        break
      }
      const next = buffered.indexOf(delimiter, afterDelimiter)
      if (next === -1) break
      const frame = parsePart(buffered.slice(afterDelimiter, next))
      if (frame) frames.push(frame)
      buffered = buffered.slice(next)
    }
    return frames
  }

  return {
    push(chunk) {
      if (completed) return []
      buffered += chunk
      return drain()
    },
    end() {
      if (completed) return []
      const frames = drain()
      if (buffered.includes(closingDelimiter)) frames.push({ kind: 'complete' })
      return frames
    },
  }
}
