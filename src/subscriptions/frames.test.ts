import { createFrameParser } from './frames'

/** Pushes `text` through a fresh parser one byte at a time, so a frame split anywhere is still parsed whole. */
function parseByteByByte(contentType: string, text: string) {
  const parser = createFrameParser(contentType)!
  const frames = text.split('').flatMap(char => parser.push(char))
  return [...frames, ...parser.end()]
}

describe('createFrameParser', () => {
  it('returns no parser for a content type that is not a stream', () => {
    expect(createFrameParser('application/json')).toBeUndefined()
    expect(createFrameParser('')).toBeUndefined()
  })

  describe('text/event-stream', () => {
    const body =
      'event: next\ndata: {"data":{"countdown":2}}\n\n' +
      ':\n\n' +
      'event: next\ndata: {"data":{"countdown":1}}\n\n' +
      'event: complete\ndata:\n\n'

    it('yields one next frame per event, skips heartbeats and ends on complete', () => {
      const parser = createFrameParser('text/event-stream')!
      expect(parser.push(body)).toEqual([
        { kind: 'next', body: { data: { countdown: 2 } } },
        { kind: 'next', body: { data: { countdown: 1 } } },
        { kind: 'complete' },
      ])
    })

    it('parses the same frames when the bytes arrive one at a time', () => {
      expect(parseByteByByte('text/event-stream', body)).toEqual([
        { kind: 'next', body: { data: { countdown: 2 } } },
        { kind: 'next', body: { data: { countdown: 1 } } },
        { kind: 'complete' },
      ])
    })

    it('accepts CRLF line endings and joins multi-line data', () => {
      const parser = createFrameParser('text/event-stream; charset=utf-8')!
      expect(parser.push('event: next\r\ndata: {"data":\r\ndata: {"a":1}}\r\n\r\n')).toEqual([
        { kind: 'next', body: { data: { a: 1 } } },
      ])
    })

    it('reads a CRLF split across chunks as one line end', () => {
      const parser = createFrameParser('text/event-stream')!
      const frames = [...parser.push('event: next\r'), ...parser.push('\ndata: {"data":1}\r'), ...parser.push('\n\r\n')]
      expect(frames).toEqual([{ kind: 'next', body: { data: 1 } }])
    })

    it('reports an event whose data is not JSON as a frame error', () => {
      const parser = createFrameParser('text/event-stream')!
      expect(parser.push('event: next\ndata: not json\n\n')).toEqual([
        { kind: 'error', message: expect.stringContaining('not json') },
      ])
    })
  })

  describe('multipart/mixed', () => {
    const contentType = 'multipart/mixed; boundary="graphql"; subscriptionSpec="1.0"'
    const body =
      '\r\n--graphql\r\ncontent-type: application/json\r\n\r\n{"payload":{"data":{"countdown":2}}}' +
      '\r\n--graphql\r\ncontent-type: application/json\r\n\r\n{}' +
      '\r\n--graphql\r\ncontent-type: application/json\r\n\r\n{"payload":{"data":{"countdown":1}}}' +
      '\r\n--graphql--\r\n'

    it('yields one next frame per payload part, skips heartbeats and ends at the closing boundary', () => {
      const parser = createFrameParser(contentType)!
      expect(parser.push(body)).toEqual([
        { kind: 'next', body: { data: { countdown: 2 } } },
        { kind: 'next', body: { data: { countdown: 1 } } },
        { kind: 'complete' },
      ])
    })

    it('parses the same frames when the bytes arrive one at a time', () => {
      expect(parseByteByByte(contentType, body)).toEqual([
        { kind: 'next', body: { data: { countdown: 2 } } },
        { kind: 'next', body: { data: { countdown: 1 } } },
        { kind: 'complete' },
      ])
    })

    it('reads an unquoted boundary', () => {
      const parser = createFrameParser('multipart/mixed;boundary=abc')!
      expect(parser.push('\r\n--abc\r\ncontent-type: application/json\r\n\r\n{"payload":{"data":1}}\r\n--abc--\r\n')).toEqual([
        { kind: 'next', body: { data: 1 } },
        { kind: 'complete' },
      ])
    })

    it('turns a transport error part (payload null with errors) into an erroring frame, then completes', () => {
      const parser = createFrameParser(contentType)!
      expect(
        parser.push(
          '\r\n--graphql\r\ncontent-type: application/json\r\n\r\n{"payload":null,"errors":[{"message":"subgraph gone"}]}\r\n--graphql--\r\n'
        )
      ).toEqual([{ kind: 'next', body: { errors: [{ message: 'subgraph gone' }] } }, { kind: 'complete' }])
    })

    it('returns no parser when the boundary is missing', () => {
      expect(createFrameParser('multipart/mixed')).toBeUndefined()
    })
  })

  describe('multipart/mixed, delivered without waiting for the next delimiter', () => {
    const event = (n: number) => JSON.stringify({ payload: { data: { n } } })
    const expected = [
      { kind: 'next', body: { data: { n: 1 } } },
      { kind: 'next', body: { data: { n: 2 } } },
      { kind: 'complete' },
    ]

    /** Each server's framing of: event 1, a heartbeat, event 2, the end. */
    const framings = {
      // Hive Router: delimiter before the part, CRLF after it.
      'delimiter before, CRLF after (Hive Router)': {
        contentType: 'multipart/mixed;boundary="graphql";subscriptionSpec=1.0',
        parts: [
          `--graphql\r\nContent-Type: application/json\r\n\r\n${event(1)}\r\n`,
          '--graphql\r\nContent-Type: application/json\r\n\r\n{}\r\n',
          `--graphql\r\nContent-Type: application/json\r\n\r\n${event(2)}\r\n`,
          '--graphql--\r\n',
        ],
      },
      // The support endpoint: CRLF and delimiter before the part, nothing after it.
      'delimiter before, nothing after (support endpoint)': {
        contentType: 'multipart/mixed; boundary="graphql"; subscriptionSpec="1.0"',
        parts: [
          `\r\n--graphql\r\ncontent-type: application/json\r\n\r\n${event(1)}`,
          '\r\n--graphql\r\ncontent-type: application/json\r\n\r\n{}',
          `\r\n--graphql\r\ncontent-type: application/json\r\n\r\n${event(2)}`,
          '\r\n--graphql--\r\n',
        ],
      },
      // Apollo Router: each part followed right away by the next delimiter.
      'delimiter after each part (Apollo Router)': {
        contentType: 'multipart/mixed;boundary="graphql";subscriptionSpec="1.0"',
        parts: [
          `\r\n--graphql\r\ncontent-type: application/json\r\n\r\n${event(1)}\r\n--graphql`,
          '\r\ncontent-type: application/json\r\n\r\n{}\r\n--graphql',
          `\r\ncontent-type: application/json\r\n\r\n${event(2)}\r\n--graphql`,
          '--\r\n',
        ],
      },
    }

    describe.each(Object.entries(framings))('%s', (_name, { contentType, parts }) => {
      const text = parts.join('')

      it('emits each event as soon as its JSON body is complete', () => {
        const parser = createFrameParser(contentType)!
        expect(parser.push(parts[0])).toEqual([expected[0]])
        expect(parser.push(parts[1])).toEqual([])
        expect(parser.push(parts[2])).toEqual([expected[1]])
        expect(parser.push(parts[3])).toEqual([expected[2]])
      })

      it('emits an event on the byte that closes its body, when bytes arrive one at a time', () => {
        const parser = createFrameParser(contentType)!
        const emittedAt: number[] = []
        text.split('').forEach((char, index) => {
          if (parser.push(char).some(frame => frame.kind === 'next')) emittedAt.push(index)
        })
        const closingBrace = (n: number) => text.indexOf(event(n)) + event(n).length - 1
        expect(emittedAt).toEqual([closingBrace(1), closingBrace(2)])
      })

      it('parses the same frames whichever byte the stream is split at', () => {
        for (let split = 1; split < text.length; split++) {
          const parser = createFrameParser(contentType)!
          const frames = [...parser.push(text.slice(0, split)), ...parser.push(text.slice(split)), ...parser.end()]
          expect({ split, frames }).toEqual({ split, frames: expected })
        }
      })
    })

    it('waits for a pretty-printed body to close, whatever braces come before', () => {
      const parser = createFrameParser('multipart/mixed; boundary=graphql')!
      const body = '{\r\n  "payload": {\r\n    "data": { "a": { "b": 1 } }\r\n  }\r\n}'
      const head = '--graphql\r\ncontent-type: application/json\r\n\r\n'
      const lastBrace = body.lastIndexOf('}')
      expect(parser.push(head + body.slice(0, lastBrace))).toEqual([])
      expect(parser.push(body.slice(lastBrace))).toEqual([{ kind: 'next', body: { data: { a: { b: 1 } } } }])
    })

    it('does not split a part on the boundary text inside a JSON string', () => {
      const parser = createFrameParser('multipart/mixed; boundary=graphql')!
      const body = JSON.stringify({ payload: { data: { note: 'see --graphql-- and --graphql' } } })
      expect(parser.push(`--graphql\r\ncontent-type: application/json\r\n\r\n${body}\r\n`)).toEqual([
        { kind: 'next', body: { data: { note: 'see --graphql-- and --graphql' } } },
      ])
    })

    it('reads LF-only framing', () => {
      const parser = createFrameParser('multipart/mixed; boundary=graphql')!
      expect(parser.push('--graphql\ncontent-type: application/json\n\n{"payload":{"data":1}}\n--graphql--\n')).toEqual([
        { kind: 'next', body: { data: 1 } },
        { kind: 'complete' },
      ])
    })

    it('emits a part the server closed the response after, without a delimiter', () => {
      const parser = createFrameParser('multipart/mixed; boundary=graphql')!
      parser.push('--graphql\r\ncontent-type: application/json\r\n\r\n{"payload":{"data"')
      expect(parser.push(':1}}')).toEqual([{ kind: 'next', body: { data: 1 } }])
      expect(parser.end()).toEqual([])
    })
  })
})
