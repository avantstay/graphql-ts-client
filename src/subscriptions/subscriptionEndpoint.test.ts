import { createTestEndpointCreator } from '../testSupport/endpointFixture'
import { multipart, sse, startSubscriptionServer } from '../testSupport/subscriptionServer'
import { SettledResponse } from '../settle/types'
import { GraphQLClientError, IRequestListener, IResponseListener } from '../types'

type Server = Awaited<ReturnType<typeof startSubscriptionServer>>

let server: Server

beforeAll(async () => {
  server = await startSubscriptionServer()
})

afterAll(() => server.stop())

beforeEach(() => {
  server.requests.length = 0
})

const typesTree = {
  Subscription: { noteAdded: { __args: { bookingId: 'ID!' } } },
}

function createEndpoint(overrides: Partial<Parameters<typeof createTestEndpointCreator>[0]> = {}) {
  return createTestEndpointCreator({
    getClient: () => ({ url: server.url, headers: { 'X-Client': 'test' }, retryConfig: { max: 0, before: () => undefined } }),
    typesTree,
    ...overrides,
  })('subscription', 'noteAdded')
}

async function collect<Value>(iterable: AsyncIterable<Value>): Promise<Value[]> {
  const values: Value[] = []
  for await (const value of iterable) values.push(value)
  return values
}

const note = (id: string) => ({ data: { noteAdded: { id, body: `note ${id}` } } })
const aliased = (id: string) => ({ data: { live: { id, body: `note ${id}` } } })

describe('a subscription endpoint', () => {
  it('sends a subscription operation that accepts both stream transports', async () => {
    server.respondWith(() => ({ headers: { 'content-type': sse.contentType }, chunks: [sse.complete] }))

    await collect(createEndpoint()({ __args: { bookingId: 'b1' }, id: true }))

    const [request] = server.requests
    expect(request.body).toEqual({
      query: 'subscription noteAdded($bookingId: ID!) { noteAdded(bookingId:$bookingId) { id } }',
      variables: { bookingId: 'b1' },
      operationName: 'noteAdded',
    })
    expect(request.headers.accept).toBe('text/event-stream, multipart/mixed;subscriptionSpec="1.0", application/json')
    expect(request.headers['content-type']).toBe('application/json')
    expect(request.headers['x-client']).toBe('test')
  })

  it('yields each event projected to the root field, over Server-Sent Events', async () => {
    server.respondWith(() => ({
      headers: { 'content-type': sse.contentType },
      chunks: [sse.next(note('1')), sse.heartbeat, sse.next(note('2')), sse.complete],
    }))

    const notes = await collect(createEndpoint()({ __args: { bookingId: 'b1' }, id: true, body: true }))

    expect(notes).toEqual([
      { id: '1', body: 'note 1' },
      { id: '2', body: 'note 2' },
    ])
  })

  it('yields the same events over the multipart protocol', async () => {
    server.respondWith(() => ({
      headers: { 'content-type': multipart.contentType },
      chunks: [multipart.next(note('1')), multipart.heartbeat, multipart.next(note('2')), multipart.complete],
    }))

    const notes = await collect(createEndpoint()({ __args: { bookingId: 'b1' }, id: true, body: true }))

    expect(notes).toEqual([
      { id: '1', body: 'note 1' },
      { id: '2', body: 'note 2' },
    ])
  })

  it('unwraps the root field by its alias', async () => {
    server.respondWith(() => ({ headers: { 'content-type': sse.contentType }, chunks: [sse.next(aliased('1')), sse.complete] }))

    const notes = await collect(createEndpoint()({ __alias: 'live', __args: { bookingId: 'b1' }, id: true }))

    expect(notes).toEqual([{ id: '1', body: 'note 1' }])
    expect(server.requests[0].body.query).toBe(
      'subscription live($bookingId: ID!) { live:noteAdded(bookingId:$bookingId) { id } }'
    )
  })

  it('ends when the server ends the response without a complete frame', async () => {
    server.respondWith(() => ({ headers: { 'content-type': sse.contentType }, chunks: [sse.next(note('1'))] }))

    const notes = await collect(createEndpoint()({ __args: { bookingId: 'b1' }, id: true }))

    expect(notes).toEqual([{ id: '1', body: 'note 1' }])
  })

  describe('a direct call', () => {
    it('throws GraphQLClientError on an event that carries errors, and closes the subscription', async () => {
      server.respondWith(() => ({
        headers: { 'content-type': sse.contentType },
        chunks: [sse.next(note('1')), sse.next({ data: { noteAdded: null }, errors: [{ message: 'gone' }] })],
        hang: true,
      }))

      const seen: unknown[] = []
      const failure = await (async () => {
        try {
          for await (const value of createEndpoint()({ __args: { bookingId: 'b1' }, id: true })) seen.push(value)
        } catch (error) {
          return error
        }
      })()

      expect(seen).toEqual([{ id: '1', body: 'note 1' }])
      expect(failure).toBeInstanceOf(GraphQLClientError)
      expect((failure as GraphQLClientError).message).toBe('gone')
      await server.waitForClientClose()
    })

    it('throws GraphQLClientError when the server refuses the subscription with a JSON error response', async () => {
      server.respondWith(() => ({
        status: 422,
        chunks: [JSON.stringify({ errors: [{ message: 'Unknown field missing' }] })],
      }))

      await expect(collect(createEndpoint()({ __args: { bookingId: 'b1' }, id: true }))).rejects.toMatchObject({
        message: 'Unknown field missing',
        response: { status: 422 },
      })
    })

    it('throws when the server answers with a body that is not a stream', async () => {
      server.respondWith(() => ({ status: 200, chunks: [JSON.stringify({ data: { noteAdded: null } })] }))

      await expect(collect(createEndpoint()({ __args: { bookingId: 'b1' }, id: true }))).rejects.toThrow(/application\/json/)
    })

    it('throws when the connection drops mid-stream', async () => {
      server.respondWith(() => ({ headers: { 'content-type': sse.contentType }, chunks: [sse.next(note('1'))], destroy: true }))

      const seen: unknown[] = []
      await expect(
        (async () => {
          for await (const value of createEndpoint()({ __args: { bookingId: 'b1' }, id: true })) seen.push(value)
        })()
      ).rejects.toThrow()
      expect(seen).toEqual([{ id: '1', body: 'note 1' }])
    })
  })

  describe('settle()', () => {
    it('classifies every event and never throws', async () => {
      server.respondWith(() => ({
        headers: { 'content-type': sse.contentType },
        chunks: [
          sse.next(note('1')),
          sse.next({ data: { noteAdded: { id: '2', body: null } }, errors: [{ message: 'x', path: ['noteAdded', 'body'] }] }),
          sse.next({ data: { noteAdded: null }, errors: [{ message: 'gone', path: ['noteAdded'] }] }),
          sse.complete,
        ],
      }))

      const results = await collect(createEndpoint().settle({ __args: { bookingId: 'b1' }, id: true, body: true }))

      expect(results.map(result => result.outcome)).toEqual(['success', 'partial', 'failure'])
      expect(results[0].data).toEqual({ id: '1', body: 'note 1' })
      expect(results[1].data).toEqual({ id: '2', body: undefined })
      expect(results[1].failedPaths).toEqual(['body'])
      expect(results[2]).toMatchObject({ reason: 'no-data', data: null, status: 200 })
    })

    it('yields one http failure and ends when the server refuses the subscription', async () => {
      server.respondWith(() => ({ status: 422, chunks: [JSON.stringify({ errors: [{ message: 'bad document' }] })] }))

      const results = await collect(createEndpoint().settle({ __args: { bookingId: 'b1' }, id: true }))

      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({ outcome: 'failure', reason: 'http', status: 422, data: null })
      expect(results[0].errors[0].message).toBe('bad document')
    })

    it('yields one http failure and ends when the connection drops mid-stream', async () => {
      server.respondWith(() => ({ headers: { 'content-type': sse.contentType }, chunks: [sse.next(note('1'))], destroy: true }))

      const results = await collect(createEndpoint().settle({ __args: { bookingId: 'b1' }, id: true }))

      expect(results.map(result => result.outcome)).toEqual(['success', 'failure'])
      expect(results[1]).toMatchObject({ reason: 'http', status: undefined })
    })
  })

  describe('raw()', () => {
    it('yields every event as a raw response with its outcome', async () => {
      server.respondWith(() => ({
        headers: { 'content-type': sse.contentType },
        chunks: [sse.next(note('1')), sse.next({ data: { noteAdded: null }, errors: [{ message: 'gone' }] }), sse.complete],
      }))

      const results = await collect(createEndpoint().raw({ __args: { bookingId: 'b1' }, id: true }))

      expect(results).toHaveLength(2)
      expect(results[0]).toMatchObject({ outcome: 'success', status: 200, data: { id: '1', body: 'note 1' } })
      expect(results[1]).toMatchObject({ outcome: 'failure', reason: 'no-data', data: null })
      expect(results[1].errors).toEqual([{ message: 'gone' }])
    })
  })

  describe('closing', () => {
    it('close() aborts the request and ends the iteration', async () => {
      server.respondWith(() => ({ headers: { 'content-type': sse.contentType }, chunks: [sse.next(note('1'))], hang: true }))

      const subscription = createEndpoint()({ __args: { bookingId: 'b1' }, id: true })
      const seen: unknown[] = []
      for await (const value of subscription) {
        seen.push(value)
        subscription.close()
      }

      expect(seen).toEqual([{ id: '1', body: 'note 1' }])
      await server.waitForClientClose()
    })

    it('breaking out of the loop closes the subscription', async () => {
      server.respondWith(() => ({ headers: { 'content-type': sse.contentType }, chunks: [sse.next(note('1'))], hang: true }))

      for await (const value of createEndpoint()({ __args: { bookingId: 'b1' }, id: true })) {
        expect(value).toEqual({ id: '1', body: 'note 1' })
        break
      }

      await server.waitForClientClose()
    })

    it('an aborted __signal closes the subscription', async () => {
      server.respondWith(() => ({ headers: { 'content-type': sse.contentType }, chunks: [sse.next(note('1'))], hang: true }))
      const controller = new AbortController()

      const seen: unknown[] = []
      for await (const value of createEndpoint()({ __signal: controller.signal, __args: { bookingId: 'b1' }, id: true })) {
        seen.push(value)
        controller.abort()
      }

      expect(seen).toEqual([{ id: '1', body: 'note 1' }])
      await server.waitForClientClose()
    })

    it('a signal aborted before the call never connects', async () => {
      const controller = new AbortController()
      controller.abort()

      const seen = await collect(createEndpoint()({ __signal: controller.signal, __args: { bookingId: 'b1' }, id: true }))

      expect(seen).toEqual([])
      expect(server.requests).toHaveLength(0)
    })
  })

  describe('subscribe()', () => {
    it('delivers events to the observer and reports completion', async () => {
      server.respondWith(() => ({
        headers: { 'content-type': sse.contentType },
        chunks: [sse.next(note('1')), sse.next(note('2')), sse.complete],
      }))
      const next = jest.fn()
      const error = jest.fn()

      await new Promise<void>(complete => {
        createEndpoint()({ __args: { bookingId: 'b1' }, id: true }).subscribe({ next, error, complete })
      })

      expect(next.mock.calls).toEqual([[{ id: '1', body: 'note 1' }], [{ id: '2', body: 'note 2' }]])
      expect(error).not.toHaveBeenCalled()
    })

    it('reports a failing event through error and stops', async () => {
      server.respondWith(() => ({
        headers: { 'content-type': sse.contentType },
        chunks: [sse.next({ data: { noteAdded: null }, errors: [{ message: 'gone' }] })],
        hang: true,
      }))

      const failure = await new Promise<unknown>(error => {
        createEndpoint()({ __args: { bookingId: 'b1' }, id: true }).subscribe({ error })
      })

      expect(failure).toBeInstanceOf(GraphQLClientError)
      await server.waitForClientClose()
    })

    it('the returned function unsubscribes', async () => {
      server.respondWith(() => ({ headers: { 'content-type': sse.contentType }, chunks: [sse.next(note('1'))], hang: true }))

      const unsubscribe = await new Promise<() => void>(resolve => {
        const stop = createEndpoint()({ __args: { bookingId: 'b1' }, id: true }).subscribe({ next: () => resolve(stop) })
      })
      unsubscribe()

      await server.waitForClientClose()
    })
  })

  describe('listeners', () => {
    it('runs request listeners before connecting and sends the headers they set', async () => {
      server.respondWith(() => ({ headers: { 'content-type': sse.contentType }, chunks: [sse.complete] }))
      const listener: IRequestListener = async info => {
        info.headers.Authorization = 'Bearer fresh'
      }

      await collect(createEndpoint({ requestListeners: [listener] })({ __args: { bookingId: 'b1' }, id: true }))

      expect(server.requests[0].headers.authorization).toBe('Bearer fresh')
    })

    it('notifies response listeners once per event', async () => {
      server.respondWith(() => ({
        headers: { 'content-type': sse.contentType },
        chunks: [sse.next(note('1')), sse.next(note('2')), sse.complete],
      }))
      const seen: string[] = []
      const listener: IResponseListener = info => {
        seen.push(`${info.queryName}:${info.response.outcome}:${info.response.data.noteAdded.id}`)
      }

      await collect(createEndpoint({ responseListeners: [listener] })({ __args: { bookingId: 'b1' }, id: true }))
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(seen).toEqual(['noteAdded:success:1', 'noteAdded:success:2'])
    })
  })

  describe('a 401', () => {
    it('is retried once with refreshed headers when retryConfig.unauthorized is set', async () => {
      server.respondWith(request =>
        request.headers.authorization === 'Bearer new'
          ? { headers: { 'content-type': sse.contentType }, chunks: [sse.next(note('1')), sse.complete] }
          : { status: 401, chunks: [JSON.stringify({ errors: [{ message: 'unauthorized' }] })] }
      )
      const listener: IRequestListener = info => {
        info.headers.Authorization = info.retry ? 'Bearer new' : 'Bearer expired'
      }
      const endpoint = createEndpoint({
        requestListeners: [listener],
        getClient: () => ({ url: server.url, headers: {}, retryConfig: { max: 0, before: () => undefined, unauthorized: true } }),
      })

      const notes = await collect(endpoint({ __args: { bookingId: 'b1' }, id: true }))

      expect(notes).toEqual([{ id: '1', body: 'note 1' }])
      expect(server.requests.map(request => request.headers.authorization)).toEqual(['Bearer expired', 'Bearer new'])
    })

    it('is not retried without retryConfig.unauthorized', async () => {
      server.respondWith(() => ({ status: 401, chunks: [JSON.stringify({ errors: [{ message: 'unauthorized' }] })] }))

      const results: SettledResponse<unknown>[] = await collect(
        createEndpoint().settle({ __args: { bookingId: 'b1' }, id: true })
      )

      expect(results[0]).toMatchObject({ outcome: 'failure', reason: 'http', status: 401 })
      expect(server.requests).toHaveLength(1)
    })
  })
})
