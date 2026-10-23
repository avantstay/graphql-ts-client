import axios from 'axios'
import { generateTypescriptClientFromSDL } from './generateTypescriptClient'
import { GraphQLClientError, OperationTransportRequest, OperationTransportResponse } from './types'

const SDL = `
  scalar DateTime
  enum State { OPEN CLOSED }
  type Booking { id: ID!, note: String, state: State!, at: DateTime }
  type Query { booking(id: ID!, state: State, at: DateTime): Booking }
  type Mutation { updateBooking(id: ID!): Booking }
`

function generated() {
  const { js } = generateTypescriptClientFromSDL(SDL, {
    clientName: 'bookingApi',
    endpoint: 'https://default.invalid/graphql',
    skipCache: true,
  })
  const generatedModule = { exports: {} as any }
  new Function('require', 'module', 'exports', js)(require, generatedModule, generatedModule.exports)
  return generatedModule.exports
}

const success = (id: string, root = 'booking'): OperationTransportResponse => ({
  status: 200,
  headers: { 'x-request-id': id },
  data: { data: { [root]: { id, note: null, state: 'OPEN', at: '2026-01-01T00:00:00Z' } } },
})

// Response listeners are deliberately deferred by the endpoint API.
const flushListeners = () => new Promise(resolve => setTimeout(resolve, 0))

afterEach(() => jest.restoreAllMocks())

test('generated clients isolate concurrent wires, headers, listeners, results and memo state', async () => {
  const { createBookingApi, bookingApi, State } = generated()
  const requests: OperationTransportRequest[][] = [[], []]
  const clients = requests.map((seen, i) =>
    createBookingApi({
      transport: async (request: OperationTransportRequest) => {
        seen.push(request)
        await Promise.resolve()
        return success(String(i), request.body.operationName)
      },
    })
  )
  const sharedHeaders = { 'X-Client': 'initial' }
  clients.forEach(client => client.setHeaders(sharedHeaders))
  clients[0].setHeader('X-Client', 'first')
  clients[1].setHeader('X-Client', 'second')
  const responseListeners = clients.map(() => jest.fn())
  const detach = clients.map((client, i) => {
    client.setUrl(`https://client-${i}.invalid/graphql`)
    client.addResponseListener(responseListeners[i])
    return client.addRequestListener(async (info: any) => {
      await Promise.resolve()
      info.headers['X-Prepared'] = String(i)
    })
  })
  const selection = {
    __alias: 'selected',
    __args: { id: 'b1', state: State.open, at: null },
    __headers: { 'X-Call': 'call' },
    id: true,
    note: true,
    state: true,
    at: true,
  }
  const results = await Promise.all(clients.map(client => client.queries.booking.raw(selection)))
  await flushListeners()
  for (let i = 0; i < clients.length; i++) {
    expect(requests[i]).toEqual([
      {
        url: `https://client-${i}.invalid/graphql`,
        body: {
          query:
            'query selected($id: ID!, $state: State, $at: DateTime) { selected:booking(id:$id,state:$state,at:$at) { id note state at } }',
          variables: { id: 'b1', state: 'OPEN', at: null },
          operationName: 'selected',
        },
        headers: {
          'Content-Type': 'application/json',
          'X-Client': i === 0 ? 'first' : 'second',
          'X-Call': 'call',
          'X-Prepared': String(i),
        },
        params: { _q: 'selected' },
      },
    ])
    expect(results[i]).toMatchObject({
      status: 200,
      headers: { 'x-request-id': String(i) },
      outcome: 'success',
      data: { id: String(i), note: null },
    })
    expect(responseListeners[i]).toHaveBeenCalledTimes(1)
    expect(responseListeners[i].mock.calls[0][0]).toMatchObject({
      queryName: 'selected',
      response: { data: { selected: { id: String(i) } } },
    })
    detach[i]()
    const endpoint = clients[i].queries.booking
    await endpoint.memo(selection)
    await endpoint.memo(selection)
    await endpoint.memoRaw(selection)
    await endpoint.memoRaw(selection)
    expect(requests[i]).toHaveLength(3)
    expect(requests[i][1].headers['X-Prepared']).toBeUndefined()
    // raw never reads the memo cache, including for a selection already memoised.
    await endpoint.raw(selection)
    await endpoint.raw(selection)
    expect(requests[i]).toHaveLength(5)
  }
  expect(sharedHeaders).toEqual({ 'X-Client': 'initial' })
  const post = jest.spyOn(axios, 'post').mockResolvedValue(success('default'))
  expect(await bookingApi.queries.booking({ __args: { id: 'b1' }, id: true })).toMatchObject({ id: 'default' })
  expect(post).toHaveBeenCalledWith(
    'https://default.invalid/graphql',
    expect.anything(),
    expect.objectContaining({ headers: { 'Content-Type': 'application/json' } })
  )
})

test('generated transport preserves direct, raw and settle error semantics and memo failure eviction', async () => {
  const { createBookingApi } = generated()
  const response = {
    status: 200,
    headers: {},
    data: { data: { booking: { id: 'b1', note: null } }, errors: [{ message: 'unavailable', path: ['booking', 'note'] }] },
  }
  const transport = jest.fn(async () => response)
  const client = createBookingApi({ transport })
  const selection = { __args: { id: 'b1' }, id: true, note: true }
  await expect(client.queries.booking(selection)).rejects.toBeInstanceOf(GraphQLClientError)
  expect(await client.queries.booking.raw(selection)).toMatchObject({
    outcome: 'partial',
    data: { note: null },
    failedPaths: ['note'],
  })
  expect(await client.queries.booking.settle(selection)).toMatchObject({
    outcome: 'partial',
    data: { id: 'b1', note: undefined },
    failedPaths: ['note'],
    errors: [{ message: 'unavailable', path: ['note'] }],
  })
  await client.queries.booking.memoRaw(selection)
  await client.queries.booking.memoRaw(selection)
  expect(transport).toHaveBeenCalledTimes(5)
  const rejected = createBookingApi({
    transport: async () => {
      throw new Error('transport stopped')
    },
  })
  await expect(rejected.queries.booking.raw(selection)).rejects.toThrow('transport stopped')
  expect(await rejected.queries.booking.settle(selection)).toMatchObject({ outcome: 'failure', reason: 'http' })
})

test.each([401, 500])('__retry:false makes one attempt even with both retry policies enabled, status %s', async status => {
  const { createBookingApi } = generated()
  const transport = jest.fn(async () => ({ status, headers: {}, data: { errors: [{ message: 'failed' }] } }))
  const client = createBookingApi({ transport })
  const before = jest.fn()
  client.setRetryConfig({ max: 2, unauthorized: true, before })
  expect(await client.queries.booking.raw({ __retry: false, __args: { id: 'b1' }, id: true })).toMatchObject({
    status,
    outcome: 'failure',
    reason: 'http',
  })
  expect(transport).toHaveBeenCalledTimes(1)
  expect(before).not.toHaveBeenCalled()
})

test('injected transport retains opt-in retry preparation and mutation settle source handling', async () => {
  const { createBookingApi } = generated()
  let attempts = 0
  const transport = jest.fn(async (request: OperationTransportRequest) =>
    ++attempts === 1
      ? { status: 401, headers: {}, data: { errors: [{ message: 'expired' }] } }
      : success('updated', request.body.operationName)
  )
  const client = createBookingApi({ transport })
  client.setRetryConfig({ max: 0, unauthorized: true })
  client.addRequestListener((info: any) => {
    info.headers['X-Attempt'] = String(info.retry?.trial ?? 0)
  })
  expect(await client.mutations.updateBooking.settle({ __settledSources: 'none', __args: { id: 'b1' }, id: true })).toMatchObject(
    { outcome: 'success', data: { id: 'updated' } }
  )
  expect(transport.mock.calls.map(([request]) => ({ params: request.params, headers: request.headers }))).toEqual([
    { params: { _q: 'updateBooking' }, headers: { 'Content-Type': 'application/json', 'X-Attempt': '0' } },
    { params: { _q: 'updateBooking', _retrial: 2 }, headers: { 'Content-Type': 'application/json', 'X-Attempt': '1' } },
  ])
})
