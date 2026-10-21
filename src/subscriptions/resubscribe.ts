import { Subscription } from '../types'
import { createSubscription } from './channel'

/** Where a resubscribing subscription stands: opening a connection, streaming, waiting to retry, or stopped for good. */
export type ConnectionState = 'connecting' | 'live' | 'retrying' | 'closed'

/** One change of `ConnectionState`, as `onStateChange` receives it. */
export type ConnectionStateChange = {
  state: ConnectionState
  /** How many reconnects in a row have happened since a connection last stayed live for `resetAfterMs`; 0 at first. */
  attempt: number
  /** On `retrying`: how long until the next attempt, in milliseconds. */
  delayMs?: number
  /** On `retrying` or `closed`: the error that ended the last connection; absent when the server completed it. */
  error?: unknown
}

export type ResubscribeOptions = {
  /** Stops for good when aborted: the open connection is closed and no retry is scheduled. */
  signal?: AbortSignal
  /** Called on every state change, starting with `connecting`. */
  onStateChange?: (change: ConnectionStateChange) => void
  /** The base delay before the first reconnect. Default 1000. */
  initialDelayMs?: number
  /** The cap on the base delay. Default 30000. */
  maxDelayMs?: number
  /** How much the base delay grows per reconnect in a row. Default 2. */
  multiplier?: number
  /** A connection that stays live this long resets the backoff, so the next reconnect starts from `initialDelayMs`. Default 10000. */
  resetAfterMs?: number
  /** How many reconnects in a row before giving up and ending with the last error. Default unlimited. */
  maxRetries?: number
  /** Whether a connection that ended with `error` is worth reopening. A server completion always is. Default: every error is. */
  shouldRetry?: (error: unknown) => boolean
  /** The random source for jitter, in [0, 1). Default `Math.random`. */
  random?: () => number
}

/**
 * Keeps a subscription open: `open` is called for every connection, so the request listeners run again and send a fresh
 * token, and a new connection is opened, after an exponential backoff with jitter, whenever the last one fails or the
 * server completes it (a server may end long-lived streams on purpose). Values from every connection flow into the
 * returned subscription, which ends only when it is closed, `signal` aborts, or the retries run out.
 *
 * ```ts
 * const live = resubscribe(() => api.subscriptions.noteAdded({ __args: { bookingId }, id: true }), {
 *   signal: controller.signal,
 *   onStateChange: ({ state }) => setLive(state === 'live'),
 * })
 * live.subscribe({ next: () => refetch() })
 * ```
 */
export function resubscribe<Value>(open: () => Subscription<Value>, options: ResubscribeOptions = {}): Subscription<Value> {
  const {
    signal,
    onStateChange,
    initialDelayMs = 1000,
    maxDelayMs = 30000,
    multiplier = 2,
    resetAfterMs = 10000,
    maxRetries = Infinity,
    shouldRetry = () => true,
    random = Math.random,
  } = options

  return createSubscription<Value>(sink => {
    let stopped = false
    let reconnects = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let current: Subscription<Value> | undefined

    const report = (change: ConnectionStateChange) => onStateChange?.(change)

    const giveUp = (failure?: { error: unknown }) => {
      stopped = true
      report({ state: 'closed', attempt: reconnects, ...failure })
      if (failure) sink.error(failure.error)
      else sink.complete()
    }

    const scheduleReconnect = (failure: { error: unknown } | undefined, liveSince: number | undefined) => {
      if (liveSince !== undefined && Date.now() - liveSince >= resetAfterMs) reconnects = 0
      if ((failure && !shouldRetry(failure.error)) || reconnects >= maxRetries) return giveUp(failure)
      const delayMs = backoffDelay(reconnects, { initialDelayMs, maxDelayMs, multiplier, random })
      reconnects++
      report({ state: 'retrying', attempt: reconnects, delayMs, ...failure })
      timer = setTimeout(connect, delayMs)
    }

    const connect = () => {
      timer = undefined
      if (stopped) return
      report({ state: 'connecting', attempt: reconnects })

      let ended = false
      let liveSince: number | undefined
      const markLive = () => {
        if (ended || stopped || liveSince !== undefined) return
        liveSince = Date.now()
        report({ state: 'live', attempt: reconnects })
      }
      const end = (failure?: { error: unknown }) => {
        if (ended || stopped) return
        ended = true
        current = undefined
        scheduleReconnect(failure, liveSince)
      }

      let attempt: Subscription<Value>
      try {
        attempt = open()
      } catch (error) {
        return end({ error })
      }
      current = attempt
      attempt.subscribe({
        open: markLive,
        next: value => {
          if (ended || stopped) return
          // A source that never reports `open` is live once it delivers.
          markLive()
          sink.next(value)
        },
        error: error => end({ error }),
        complete: () => end(),
      })
    }

    const stop = () => {
      if (stopped) return
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      const connection = current
      current = undefined
      connection?.close()
      report({ state: 'closed', attempt: reconnects })
    }

    if (signal?.aborted) {
      stopped = true
      sink.complete()
      return () => undefined
    }
    const onAbort = () => sink.complete()
    signal?.addEventListener('abort', onAbort)

    connect()

    return () => {
      signal?.removeEventListener('abort', onAbort)
      stop()
    }
  })
}

/**
 * The wait before reconnect number `reconnects` (0-based): the base delay grows by `multiplier` per reconnect up to
 * `maxDelayMs`, and the wait is a random point in its upper half, so clients that dropped together spread out.
 */
export function backoffDelay(
  reconnects: number,
  options: { initialDelayMs: number; maxDelayMs: number; multiplier: number; random: () => number }
): number {
  const base = Math.min(options.maxDelayMs, options.initialDelayMs * Math.pow(options.multiplier, reconnects))
  return Math.round(base / 2 + (options.random() * base) / 2)
}
