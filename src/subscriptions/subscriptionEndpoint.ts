import { ApiConfig, executeListeners, logIfVerbose, prepareCall, PreparedCall, projectRootField } from '../endpoint'
import { buildResponse, nextRetry } from '../graphqlRequest'
import { GraphQLResponseBody } from '../types'
import { ClassifiedRawResponse, settleRawResult, settleThrown } from '../settle/settleRaw'
import { SettledResponse } from '../settle/types'
import {
  GraphQLClientError,
  JsonOutput,
  Projection,
  RawResponse,
  RequestRetry,
  ResponseData,
  Subscription,
  SubscriptionEndpoint,
} from '../types'
import { createSubscription, Sink } from './channel'
import { openSubscription, readSubscription, SubscriptionResponse } from './stream'

/** How one call turns a classified event, or a transport failure, into the values it yields. */
type EventMapping<Data, Value> = {
  /** The value for one event, given the root field's value and the whole response; throwing ends the subscription with that error. */
  onEvent: (event: ClassifiedRawResponse<Data>, response: ResponseData) => Value
  /** The last value for a failure that is not an event, or undefined to end with the error instead. */
  onFailure: (error: unknown) => Value | undefined
}

/** The HTTP response once any 401 retry is spent: the attempt the stream is read from. */
async function connectWithRetry(call: PreparedCall, signal: AbortSignal): Promise<SubscriptionResponse> {
  let unauthorizedRetries = call.clientConfig.retryConfig.unauthorized === true ? 1 : 0
  let retry: RequestRetry | undefined

  for (let trial = 0; ; trial++) {
    const requestHeaders = await call.headersFor(retry)
    const response = await openSubscription({
      url: call.url,
      headers: { ...call.clientConfig.headers, ...requestHeaders },
      body: { query: call.query, variables: call.variables, operationName: call.alias },
      signal,
    })
    const retryBudget = { unauthorized: unauthorizedRetries > 0, errors: 0 }
    const classified = buildResponse({ responseData: {}, headers: response.headers, status: response.status }, call.alias)
    const next = nextRetry(response.status, classified.classification, retryBudget)
    if (!next) return response
    // The refused attempt's body is never read; release the connection before opening the next one.
    response.body?.cancel().catch(() => undefined)
    unauthorizedRetries--
    retry = { trial: trial + 1, previousResponse: classified.response }
  }
}

/** One endpoint for a subscription: a streamed request whose every result is classified like a query's response. */
export function createSubscriptionEndpoint<Selectable, Result, Ignored>(
  apiConfig: ApiConfig,
  queryName: string
): SubscriptionEndpoint<Selectable, Result, Ignored> {
  type JsonResult = JsonOutput<Result, Ignored>
  type Data<Selection> = Projection<Selection, JsonResult, Ignored>

  const open = <Selection extends Selectable, Value>(
    jsonQuery: Selection | undefined,
    mapping: EventMapping<Data<Selection>, Value>
  ): Subscription<Value> =>
    createSubscription<Value>(sink => {
      const controller = new AbortController()
      const { __signal: callerSignal } = (jsonQuery ?? {}) as { __signal?: AbortSignal }
      const abort = () => controller.abort()
      if (callerSignal) {
        if (callerSignal.aborted) {
          sink.complete()
          return () => undefined
        }
        callerSignal.addEventListener('abort', abort)
      }

      const fail = (error: unknown) => {
        const last = mapping.onFailure(error)
        if (last !== undefined) {
          sink.next(last)
          sink.complete()
        } else sink.error(error)
      }

      run(jsonQuery, controller.signal, mapping, sink, fail).catch(fail)

      return () => {
        if (callerSignal) callerSignal.removeEventListener('abort', abort)
        controller.abort()
      }
    })

  /** Connects, then streams every event through the mapping into the sink until the stream or the mapping ends it. */
  const run = async <Selection extends Selectable, Value>(
    jsonQuery: Selection | undefined,
    signal: AbortSignal,
    mapping: EventMapping<Data<Selection>, Value>,
    sink: Sink<Value>,
    fail: (error: unknown) => void
  ) => {
    const call = await prepareCall(apiConfig, 'subscription', queryName, jsonQuery)
    const start = +new Date()
    const response = await connectWithRetry(call, signal)

    const deliver = (body: GraphQLResponseBody, status: number) => {
      const { response: result } = buildResponse(
        { responseData: body, headers: response.headers, status },
        call.alias,
        apiConfig.errorsParser
      )
      logIfVerbose(apiConfig, call.logOptions, { response: result }, start)
      executeListeners(apiConfig.responseListeners, { ...call.lastAttempt(), response: result })
      try {
        sink.next(mapping.onEvent(projectRootField<Data<Selection>>(result, call.alias), result))
      } catch (error) {
        sink.error(error)
      }
    }

    if (response.status >= 400) {
      // The server refused the subscription the way it refuses a bad query: one JSON error response.
      const text = await response.text()
      let body: GraphQLResponseBody = {}
      try {
        body = JSON.parse(text)
      } catch {
        // A non-JSON error body: the status alone names the failure.
      }
      deliver(body, response.status)
      sink.complete()
      return
    }

    await readSubscription(response, signal, {
      open: () => sink.open(),
      next: body => deliver(body, response.status),
      error: fail,
      complete: () => sink.complete(),
    })
  }

  const loudMapping = <Selection>(): EventMapping<Data<Selection>, Data<Selection>> => ({
    onEvent: (event, response) => {
      if (event.errors?.length) throw new GraphQLClientError(response)
      return event.data
    },
    onFailure: () => undefined,
  })

  const rawMapping = <Selection>(): EventMapping<Data<Selection>, RawResponse<Data<Selection>>> => ({
    onEvent: event => event,
    onFailure: () => undefined,
  })

  const settleMapping = <Selection>(): EventMapping<Data<Selection>, SettledResponse<Data<Selection>>> => ({
    onEvent: event => settleRawResult(event),
    onFailure: error => settleThrown(error),
  })

  const endpoint = (<Selection extends Selectable>(jsonQuery?: Selection) =>
    open(jsonQuery, loudMapping<Selection>())) as SubscriptionEndpoint<Selectable, Result, Ignored>

  endpoint.raw = <Selection extends Selectable>(jsonQuery?: Selection) => open(jsonQuery, rawMapping<Selection>())
  endpoint.settle = <Selection extends Selectable>(jsonQuery?: Selection) => open(jsonQuery, settleMapping<Selection>())

  return endpoint
}
