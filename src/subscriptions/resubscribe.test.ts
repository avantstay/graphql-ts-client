import { createTestEndpointCreator } from '../testSupport/endpointFixture'
import { FakeAnswer, FakeConnection, installFakeFetch } from '../testSupport/fakeFetch'
import { sse } from '../testSupport/subscriptionServer'
import { GraphQLClientError, IRequestListener } from '../types'
import { backoffDelay, ConnectionStateChange, resubscribe, ResubscribeOptions } from './resubscribe'

const typesTree = { Subscription: { noteAdded: { __args: { bookingId: 'ID!' } } } }
const note = (id: string) => ({ data: { noteAdded: { id } } })

let fake: ReturnType<typeof installFakeFetch>
let tokens: number

function useFetch(answer?: (connection: FakeConnection, index: number) => FakeAnswer) {
  fake = installFakeFetch(answer)
}

afterEach(() => fake?.restore())

beforeEach(() => {
  tokens = 0
})

/** A token listener like an app's auth listener: every connection asks for, and sends, a new token. */
const tokenListener: IRequestListener = async info => {
  tokens++
  info.headers.Authorization = `Bearer token-${tokens}`
}

const noteAdded = () => createTestEndpointCreator({ typesTree, requestListeners: [tokenListener] })('subscription', 'noteAdded')

/** A resubscribing note subscription with fast, deterministic backoff, recording every state change. */
function live(options: ResubscribeOptions = {}) {
  const states: ConnectionStateChange[] = []
  const subscription = resubscribe(() => noteAdded()({ __args: { bookingId: 'b1' }, id: true }), {
    initialDelayMs: 4,
    maxDelayMs: 40,
    random: () => 0.5,
    onStateChange: change => states.push(change),
    ...options,
  })
  return { subscription, states, names: () => states.map(change => change.state) }
}

async function waitFor(condition: () => boolean, what = 'condition') {
  const deadline = Date.now() + 2000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

const connectionCount = (count: number) => () => fake.connections.length >= count
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('resubscribe', () => {
  it('reconnects when the server completes the stream, sending a fresh token each time', async () => {
    useFetch()
    const { subscription, names } = live()
    const values: unknown[] = []
    subscription.subscribe({ next: value => values.push(value) })

    await waitFor(connectionCount(1))
    await waitFor(() => names().includes('live'), 'live')
    fake.connections[0].push(sse.next(note('1')) + sse.complete)
    await waitFor(connectionCount(2))
    await waitFor(() => names().filter(name => name === 'live').length === 2, 'second live')
    fake.connections[1].push(sse.next(note('2')))
    await waitFor(() => values.length === 2, 'second value')

    expect(values).toEqual([{ id: '1' }, { id: '2' }])
    expect(fake.connections.map(connection => connection.headers.Authorization)).toEqual(['Bearer token-1', 'Bearer token-2'])
    expect(names()).toEqual(['connecting', 'live', 'retrying', 'connecting', 'live'])

    subscription.close()
    expect(fake.connections[1].signal.aborted).toBe(true)
    expect(names()).toEqual(['connecting', 'live', 'retrying', 'connecting', 'live', 'closed'])
  })

  it('reconnects after the connection drops, reporting the error with the retry', async () => {
    useFetch()
    const { subscription, states } = live()
    subscription.subscribe({})

    await waitFor(connectionCount(1))
    await waitFor(() => states.some(change => change.state === 'live'), 'live')
    fake.connections[0].fail(new TypeError('network error'))
    await waitFor(connectionCount(2))

    const retrying = states.find(change => change.state === 'retrying')
    expect(retrying).toMatchObject({ attempt: 1, delayMs: 3, error: new TypeError('network error') })
    subscription.close()
  })

  it('is connecting, not live, until the server answers with a stream', async () => {
    useFetch(() => ({ reject: new TypeError('offline') }))
    const { subscription, names } = live({ maxRetries: 0 })

    await expect(subscription[Symbol.asyncIterator]().next()).rejects.toThrow('offline')
    expect(names()).toEqual(['connecting', 'closed'])
  })

  it('backs off exponentially, with jitter, up to the cap while connections keep failing', async () => {
    useFetch(() => ({ reject: new TypeError('offline') }))
    const { subscription, states } = live({ maxRetries: 5 })

    const outcome = new Promise(resolve => subscription.subscribe({ error: resolve }))
    await expect(outcome).resolves.toEqual(new TypeError('offline'))

    const delays = states.filter(change => change.state === 'retrying').map(change => change.delayMs)
    // Base 4, 8, 16, 32, then capped at 40; with random() = 0.5 each wait is three quarters of its base.
    expect(delays).toEqual([3, 6, 12, 24, 30])
    expect(fake.connections).toHaveLength(6)
    expect(states[states.length - 1]).toMatchObject({ state: 'closed', error: new TypeError('offline') })
  })

  it('resets the backoff once a connection has stayed live for resetAfterMs', async () => {
    useFetch((connection, index): FakeAnswer => {
      if (index === 0) return { reject: new TypeError('offline') }
      setTimeout(() => connection.push(sse.complete), 15)
      return {}
    })
    const { subscription, states } = live({ resetAfterMs: 10 })
    subscription.subscribe({})

    await waitFor(connectionCount(3))
    subscription.close()

    const retries = states.filter(change => change.state === 'retrying')
    expect(retries.slice(0, 2).map(change => [change.attempt, change.delayMs])).toEqual([
      [1, 3],
      [1, 3],
    ])
  })

  it('keeps backing off when connections complete before resetAfterMs', async () => {
    useFetch(() => ({ text: sse.complete }))
    const { subscription, states } = live({ maxRetries: 3 })

    await new Promise(resolve => subscription.subscribe({ complete: () => resolve(undefined) }))

    expect(states.filter(change => change.state === 'retrying').map(change => change.delayMs)).toEqual([3, 6, 12])
    expect(states[states.length - 1]).toEqual({ state: 'closed', attempt: 3 })
  })

  it('stops for good when the signal aborts, closing the open connection', async () => {
    useFetch()
    const controller = new AbortController()
    const { subscription, names } = live({ signal: controller.signal })
    const completed = new Promise(resolve => subscription.subscribe({ complete: () => resolve(true) }))

    await waitFor(connectionCount(1))
    controller.abort()

    await expect(completed).resolves.toBe(true)
    expect(fake.connections[0].signal.aborted).toBe(true)
    await sleep(20)
    expect(fake.connections).toHaveLength(1)
    expect(names()[names().length - 1]).toBe('closed')
  })

  it('never connects when the signal is already aborted', async () => {
    useFetch()
    const controller = new AbortController()
    controller.abort()
    const { subscription } = live({ signal: controller.signal })

    const values: unknown[] = []
    for await (const value of subscription) values.push(value)

    expect(values).toEqual([])
    expect(fake.connections).toHaveLength(0)
  })

  it('close() while waiting to retry cancels the reconnect', async () => {
    useFetch(() => ({ reject: new TypeError('offline') }))
    const { subscription, names } = live({ initialDelayMs: 50 })
    subscription.subscribe({})

    await waitFor(() => names().includes('retrying'), 'retrying')
    subscription.close()
    await sleep(80)

    expect(fake.connections).toHaveLength(1)
    expect(names()).toEqual(['connecting', 'retrying', 'closed'])
  })

  it('breaking out of a for await loop closes the connection and stops reconnecting', async () => {
    useFetch((connection): FakeAnswer => {
      setTimeout(() => connection.push(sse.next(note('1'))), 1)
      return {}
    })
    const { subscription } = live()

    for await (const value of subscription) {
      expect(value).toEqual({ id: '1' })
      break
    }

    expect(fake.connections[0].signal.aborted).toBe(true)
    await sleep(20)
    expect(fake.connections).toHaveLength(1)
  })

  it('gives up, with the error, when shouldRetry rejects it', async () => {
    useFetch(() => ({
      status: 403,
      contentType: 'application/json',
      text: JSON.stringify({ errors: [{ message: 'forbidden' }] }),
    }))
    const { subscription, states } = live({ shouldRetry: error => !(error instanceof GraphQLClientError) })

    const error = await new Promise(resolve => subscription.subscribe({ error: resolve }))

    expect(error).toBeInstanceOf(GraphQLClientError)
    expect(fake.connections).toHaveLength(1)
    expect(states.map(change => change.state)).toEqual(['connecting', 'closed'])
  })

  it('keeps a connection that only sends heartbeats, and reconnects one that goes silent past idleTimeoutMs', async () => {
    useFetch()
    const { subscription, states } = live({ idleTimeoutMs: 30 })
    subscription.subscribe({})

    await waitFor(connectionCount(1))
    await waitFor(() => states.some(change => change.state === 'live'), 'live')
    for (let beat = 0; beat < 4; beat++) {
      await sleep(15)
      fake.connections[0].push(sse.heartbeat)
    }
    expect(fake.connections).toHaveLength(1)

    await waitFor(connectionCount(2))
    expect(fake.connections[0].signal.aborted).toBe(true)
    expect(states.find(change => change.state === 'retrying')).toMatchObject({
      error: new Error('The subscription received nothing for 30 ms'),
    })
    subscription.close()
  })

  it('reconnects after an event that carries errors, by default', async () => {
    useFetch((connection, index): FakeAnswer => {
      if (index === 0) connection.push(sse.next({ errors: [{ message: 'resolver failed' }] }))
      return {}
    })
    const { subscription, states } = live()
    subscription.subscribe({})

    await waitFor(connectionCount(2))
    subscription.close()

    expect(states.find(change => change.state === 'retrying')?.error).toBeInstanceOf(GraphQLClientError)
  })
})

describe('backoffDelay', () => {
  const options = { initialDelayMs: 1000, maxDelayMs: 30000, multiplier: 2 }

  it('waits between half and all of the base delay', () => {
    expect(backoffDelay(0, { ...options, random: () => 0 })).toBe(500)
    expect(backoffDelay(0, { ...options, random: () => 0.999999 })).toBe(1000)
  })

  it('grows the base delay by the multiplier up to the cap', () => {
    const delays = [0, 1, 2, 3, 4, 5, 6].map(reconnects => backoffDelay(reconnects, { ...options, random: () => 0.999999 }))
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })
})
