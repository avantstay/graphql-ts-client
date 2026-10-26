import { Subscription, SubscriptionObserver } from '../types'

/** What a source pushes into a subscription: values, then either an error or completion, after which pushes are ignored. */
export type Sink<Value> = {
  /** The source is connected and streaming; observers hear of it once. */
  open(): void
  /** Bytes arrived, an event or a heartbeat. */
  activity(): void
  next(value: Value): void
  error(error: unknown): void
  complete(): void
}

type Terminal = { kind: 'complete' } | { kind: 'error'; error: unknown }

type Pull<Value> = { resolve: (result: IteratorResult<Value>) => void; reject: (error: unknown) => void }

/**
 * Builds a `Subscription` handle over a push source. `start` is called once, on the first pull or `subscribe()`, and
 * returns the function that tears the source down. Values are queued for the async iterator only once iteration has
 * begun, so a caller that only uses `subscribe()` never accumulates them.
 */
export function createSubscription<Value>(start: (sink: Sink<Value>) => () => void): Subscription<Value> {
  let started = false
  let closed = false
  let iterating = false
  let terminal: Terminal | undefined
  let errorDelivered = false
  let opened = false
  let teardown: (() => void) | undefined
  const queue: Value[] = []
  const pulls: Pull<Value>[] = []
  const observers: SubscriptionObserver<Value>[] = []

  const settlePulls = () => {
    while (pulls.length > 0 && (queue.length > 0 || terminal)) {
      const pull = pulls.shift()!
      const ended = terminal
      if (queue.length > 0) pull.resolve({ value: queue.shift()!, done: false })
      else if (ended && ended.kind === 'error' && !errorDelivered) {
        errorDelivered = true
        pull.reject(ended.error)
      } else pull.resolve({ value: undefined, done: true })
    }
  }

  const finish = (outcome: Terminal) => {
    if (terminal) return
    terminal = outcome
    closed = true
    const stop = teardown
    teardown = undefined
    if (stop) stop()
    settlePulls()
    const notified = observers.splice(0)
    notified.forEach(observer => {
      if (outcome.kind === 'error') observer.error?.(outcome.error)
      else observer.complete?.()
    })
  }

  const sink: Sink<Value> = {
    open() {
      if (closed || opened) return
      opened = true
      observers.slice().forEach(observer => observer.open?.())
    },
    activity() {
      if (closed) return
      observers.slice().forEach(observer => observer.activity?.())
    },
    next(value) {
      if (closed) return
      if (iterating) queue.push(value)
      observers.slice().forEach(observer => observer.next?.(value))
      settlePulls()
    },
    error(error) {
      if (!closed) finish({ kind: 'error', error })
    },
    complete() {
      if (!closed) finish({ kind: 'complete' })
    },
  }

  const ensureStarted = () => {
    if (started || closed) return
    started = true
    teardown = start(sink)
    // The source may have finished synchronously, in which case the teardown it returned is already due.
    if (terminal && teardown) {
      const stop = teardown
      teardown = undefined
      stop()
    }
  }

  const close = () => {
    if (closed) return
    closed = true
    terminal = { kind: 'complete' }
    const stop = teardown
    teardown = undefined
    if (stop) stop()
    settlePulls()
    observers.splice(0)
  }

  const iterator = (): AsyncIterator<Value> => {
    iterating = true
    return {
      next() {
        ensureStarted()
        return new Promise<IteratorResult<Value>>((resolve, reject) => {
          pulls.push({ resolve, reject })
          settlePulls()
        })
      },
      return() {
        close()
        return Promise.resolve({ value: undefined, done: true as const })
      },
      throw(error: unknown) {
        close()
        return Promise.reject(error)
      },
    }
  }

  return {
    [Symbol.asyncIterator]: iterator,
    subscribe(observer) {
      if (terminal) {
        if (terminal.kind === 'error') observer.error?.(terminal.error)
        else observer.complete?.()
        return () => undefined
      }
      observers.push(observer)
      if (opened) observer.open?.()
      ensureStarted()
      return () => {
        const index = observers.indexOf(observer)
        if (index > -1) observers.splice(index, 1)
        // The last observer leaving, with nobody iterating, leaves nobody to deliver to: close the connection.
        if (observers.length === 0 && !iterating) close()
      }
    },
    close,
  }
}
