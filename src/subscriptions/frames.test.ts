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
})
