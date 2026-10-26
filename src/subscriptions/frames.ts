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
    // A trailing CR may be the first half of a CRLF split across chunks: keep it raw until the next chunk decides.
    const heldBack = !final && buffered.endsWith('\r') ? '\r' : ''
    const text = heldBack ? buffered.slice(0, -1) : buffered
    const events = text.replace(/\r\n?/g, '\n').split('\n\n')
    buffered = final ? '' : (events.pop() ?? '') + heldBack
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
 *
 * Servers frame parts two ways: Apollo Router and the support endpoint write `CRLF--boundary` before each part, so a
 * part's end is only marked by the next delimiter; Hive Router writes `--boundary` before the part and `CRLF` after
 * it. Either way a part is emitted as soon as its JSON body is complete, without waiting for the next delimiter
 * (which may be a heartbeat seconds away). A JSON object has no proper prefix that is itself valid JSON, so a body
 * that parses is whole.
 */
function multipartParser(boundary: string): FrameParser {
  const delimiter = `--${boundary}`
  // Inside a part only a line that starts with the delimiter ends it; JSON cannot contain a raw newline in a string.
  const delimiterLine = `\n${delimiter}`
  let buffered = ''
  let state: 'between' | 'headers' | 'body' = 'between'
  let completed = false

  const parsePart = (body: string): StreamFrame | undefined => {
    if (!body) return undefined
    const frame = parseJsonFrame(body)
    if (!frame || frame.kind !== 'next') return frame
    const envelope = frame.body as { payload?: StreamBody | null; errors?: any[] }
    if (envelope.payload) return { kind: 'next', body: envelope.payload }
    if (envelope.errors) return { kind: 'next', body: { errors: envelope.errors } }
    return undefined
  }

  /** Moves past a delimiter at the start of `buffered`; false when more input is needed to tell what it is. */
  const readDelimiter = (frames: StreamFrame[]): boolean => {
    const start = buffered.indexOf(delimiter)
    if (start === -1) {
      // Keep only what could be the start of a delimiter split across chunks.
      buffered = buffered.slice(-delimiter.length)
      return false
    }
    const afterDelimiter = start + delimiter.length
    if (buffered.length < afterDelimiter + 2) return false
    if (buffered.startsWith('--', afterDelimiter)) {
      completed = true
      buffered = ''
      frames.push({ kind: 'complete' })
      return false
    }
    const lineEnd = buffered.indexOf('\n', afterDelimiter)
    if (lineEnd === -1) return false
    buffered = buffered.slice(lineEnd + 1)
    state = 'headers'
    return true
  }

  /** Moves past the part's headers and the blank line after them; false when they have not all arrived. */
  const readHeaders = (): boolean => {
    let bodyStart: number
    if (buffered.startsWith('\r\n')) bodyStart = 2
    else if (buffered.startsWith('\n')) bodyStart = 1
    else if (buffered.startsWith('{')) bodyStart = 0
    else {
      const crlf = buffered.indexOf('\r\n\r\n')
      const lf = buffered.indexOf('\n\n')
      if (crlf === -1 && lf === -1) return false
      bodyStart = crlf !== -1 && (lf === -1 || crlf < lf) ? crlf + 4 : lf + 2
    }
    buffered = buffered.slice(bodyStart)
    state = 'body'
    return true
  }

  /** Emits the part once its body is complete, or once the next delimiter ends it; false when it is still arriving. */
  const readBody = (frames: StreamFrame[]): boolean => {
    const next = buffered.indexOf(delimiterLine)
    if (next !== -1) {
      const frame = parsePart(buffered.slice(0, next).trim())
      if (frame) frames.push(frame)
      buffered = buffered.slice(next + 1)
      state = 'between'
      return true
    }
    const body = buffered.trim()
    if (!body.endsWith('}') || !isCompleteJson(body)) return false
    const frame = parsePart(body)
    if (frame) frames.push(frame)
    buffered = buffered.slice(buffered.lastIndexOf('}') + 1)
    state = 'between'
    return true
  }

  const drain = (): StreamFrame[] => {
    const frames: StreamFrame[] = []
    let progressed = true
    while (progressed && !completed) {
      if (state === 'between') progressed = readDelimiter(frames)
      else if (state === 'headers') progressed = readHeaders()
      else progressed = readBody(frames)
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
      // A server that closed right after a part, without a delimiter: the body is all there will be.
      if (state === 'body' && buffered.trim()) {
        const frame = parsePart(buffered.trim())
        if (frame) frames.push(frame)
      }
      buffered = ''
      return frames
    },
  }
}

function isCompleteJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}
