import fromPairs from 'lodash/fromPairs.js'
import memoize from 'moize'
import { graphqlRequest } from './graphqlRequest'
import { jsonToGraphQLQuery } from './jsonToGraphQLQuery'
import { logRequest } from './logging'
import { Classification } from './settle/classify'
import { attachClassification, ClassifiedRawResponse, settleRawResult, settleThrown } from './settle/settleRaw'
import { blockedBySource, findBlockingSource, validateSources } from './settle/sources'
import { SettledResponse } from './settle/types'
import { createSubscriptionEndpoint } from './subscriptions/subscriptionEndpoint'
import {
  ClientConfig,
  Endpoint,
  FailureMode,
  GraphQLClientError,
  IRequestListener,
  IResponseListener,
  JsonOutput,
  LogInfo,
  MutationEndpoint,
  OperationKind,
  Projection,
  RawEndpoint,
  RequestListenerInfo,
  RequestRetry,
  ResponseData,
  ResponseListenerInfo,
  SettleEndpoint,
  SubscriptionEndpoint,
  TolerateSettledSources,
} from './types'

const KEYS_KEPT_IN_DOCUMENT = ['__args', '__typename']

/** Copies a selection without the endpoint's `__`-prefixed call options; `__args` and `__typename` belong in the document. */
function stripCallOptions(jsonQuery: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!jsonQuery) return jsonQuery
  const documentKeys = Object.keys(jsonQuery).filter(key => !key.startsWith('__') || KEYS_KEPT_IN_DOCUMENT.includes(key))
  return fromPairs(documentKeys.map(key => [key, jsonQuery[key]]))
}

/** The `__`-prefixed options a call may carry; they configure the request and never reach the document. */
type CallOptionInput = {
  __alias?: string
  __retry?: boolean
  __headers?: Record<string, string>
  __url?: string
  __signal?: AbortSignal
  __settledSources?: unknown
}

export function readCallOptions(jsonQuery: unknown): {
  alias?: string
  shouldRetry: boolean
  requestHeaders: Record<string, string>
  url?: string
  signal?: AbortSignal
  settledSources: unknown
} {
  const options = (jsonQuery ?? {}) as CallOptionInput
  return {
    alias: options.__alias,
    shouldRetry: options.__retry ?? true,
    requestHeaders: options.__headers ?? {},
    url: options.__url,
    signal: options.__signal,
    settledSources: options.__settledSources,
  }
}

export const executeListeners = (listeners: IResponseListener[], data: ResponseListenerInfo) =>
  setTimeout(() => listeners.forEach(runResponseListener => runResponseListener(data)))

/** Everything the endpoint factory needs from the generated client that owns it. */
export type ApiConfig = {
  getClient: () => ClientConfig
  requestListeners: IRequestListener[]
  responseListeners: IResponseListener[]
  typesTree: any
  maxAge: number
  verbose: boolean
  formatGraphQL: any
  errorsParser?: (errors: any[]) => any
}

/** One overload per operation kind, so a mutation's `settle()` requires `__settledSources` and a query's does not. */
type ApiEndpointCreator = {
  <Selectable = any, Result = any, Ignored = any>(kind: 'query', queryName: string): Endpoint<Selectable, Result, Ignored>
  <Selectable = any, Result = any, Ignored = any>(kind: 'mutation', queryName: string): MutationEndpoint<
    Selectable,
    Result,
    Ignored
  >
  <Selectable = any, Result = any, Ignored = any>(kind: 'subscription', queryName: string): SubscriptionEndpoint<
    Selectable,
    Result,
    Ignored
  >
}

/** What `prepareCall` resolves to: one call's document, variables and per-attempt headers. */
export type PreparedCall = {
  alias: string
  query: string
  variables: Record<string, unknown>
  url: string
  signal?: AbortSignal
  shouldRetry: boolean
  clientConfig: ClientConfig
  logOptions: Omit<LogInfo, 'response' | 'error' | 'duration'>
  /** The headers for the attempt `retry` describes, after the request listeners have run for it. */
  headersFor: (retry?: RequestRetry) => Promise<Record<string, string>>
  /** The info the request listeners last prepared, which the response listeners are told about. */
  lastAttempt: () => RequestListenerInfo
}

/**
 * Prepares one call the same way for every operation kind. Request listeners prepare every attempt from the call's
 * own headers, so a retry never resends stale ones; the first attempt is prepared here, before the client config is
 * read. Response listeners see the last attempt.
 */
export async function prepareCall(
  apiConfig: ApiConfig,
  kind: OperationKind,
  queryName: string,
  jsonQuery: unknown
): Promise<PreparedCall> {
  const { alias: aliasOption, shouldRetry, requestHeaders, url: urlOption, signal } = readCallOptions(jsonQuery)
  const alias = aliasOption ?? queryName
  const document = stripCallOptions(jsonQuery as Record<string, unknown> | undefined)
  const { query, variables } = jsonToGraphQLQuery({
    kind,
    queryName,
    alias: aliasOption,
    jsonQuery: document,
    typesTree: apiConfig.typesTree,
  })

  const prepareAttempt = async (retry?: RequestRetry) => {
    const info: RequestListenerInfo = {
      queryName: alias,
      query: apiConfig.formatGraphQL(query),
      variables,
      headers: { ...requestHeaders },
      ...(retry ? { retry } : {}),
    }
    await Promise.all(apiConfig.requestListeners.map(listener => listener(info)))
    return info
  }
  let lastAttempt = await prepareAttempt()
  const headersFor = async (retry?: RequestRetry) => {
    if (retry) lastAttempt = await prepareAttempt(retry)
    return lastAttempt.headers
  }

  const clientConfig = apiConfig.getClient()

  return {
    alias,
    query,
    variables,
    url: urlOption ?? clientConfig.url,
    signal,
    shouldRetry,
    clientConfig,
    logOptions: { kind, queryName: alias, formatGraphQL: apiConfig.formatGraphQL, query, variables },
    headersFor,
    lastAttempt: () => lastAttempt,
  }
}

/** Logs one request to the browser console when the client is verbose; never outside a browser. */
export function logIfVerbose(
  apiConfig: ApiConfig,
  logOptions: PreparedCall['logOptions'],
  outcome: { response?: unknown; error?: Error },
  start: number
) {
  if (!apiConfig.verbose || !globalThis.document) return
  logRequest({ ...logOptions, ...outcome, duration: +new Date() - start } as LogInfo)
}

/** Unwraps the root field by its alias and keeps the classification alongside, as `raw()` and `settle()` read it. */
export function projectRootField<Data>(result: ResponseData, alias: string): ClassifiedRawResponse<Data> {
  const { classification, ...rawFields } = result
  const rawResult = { ...rawFields, data: rawFields.data?.[alias] } as ClassifiedRawResponse<Data>
  return attachClassification(rawResult, classification as Classification)
}

/** Builds the endpoint factory a generated client uses to create one callable endpoint per operation. */
export function getApiEndpointCreator(apiConfig: ApiConfig): ApiEndpointCreator {
  return (<Selectable = any, Result = any, Ignored = any>(kind: OperationKind, queryName: string) => {
    if (kind === 'subscription') return createSubscriptionEndpoint<Selectable, Result, Ignored>(apiConfig, queryName)
    return createRequestEndpoint<Selectable, Result, Ignored>(apiConfig, kind, queryName)
  }) as ApiEndpointCreator
}

/** One endpoint for a query or mutation: a single request, retried as configured, answered once. */
function createRequestEndpoint<Selectable, Result, Ignored>(
  apiConfig: ApiConfig,
  kind: 'query' | 'mutation',
  queryName: string
): Endpoint<Selectable, Result, Ignored> {
  type JsonResult = JsonOutput<Result, Ignored>

  type RawCall = <Selection extends Selectable>(
    failureMode: FailureMode,
    jsonQuery?: Selection
  ) => Promise<ClassifiedRawResponse<Projection<Selection, JsonResult, Ignored>>>

  const rawEndpoint: RawCall = async <Selection extends Selectable>(failureMode: FailureMode, jsonQuery?: Selection) => {
    const call = await prepareCall(apiConfig, kind, queryName, jsonQuery)
    const start = +new Date()

    try {
      const result = await graphqlRequest({
        shouldRetry: call.shouldRetry,
        failureMode,
        kind,
        queryName: call.alias,
        client: { ...call.clientConfig, url: call.url },
        headersFor: call.headersFor,
        query: call.query,
        variables: call.variables,
        errorsParser: apiConfig.errorsParser,
      })

      logIfVerbose(apiConfig, call.logOptions, { response: result }, start)
      executeListeners(apiConfig.responseListeners, { ...call.lastAttempt(), response: result })
      return projectRootField<Projection<Selection, JsonResult, Ignored>>(result, call.alias)
    } catch (error) {
      logIfVerbose(apiConfig, call.logOptions, { error: error as Error }, start)
      executeListeners(apiConfig.responseListeners, {
        ...call.lastAttempt(),
        response: (error as GraphQLClientError).response,
      })

      throw error
    }
  }

  const callEndpoint = async <Selection extends Selectable>(
    jsonQuery?: Selection
  ): Promise<Projection<Selection, JsonResult, Ignored>> => {
    const { data } = await rawEndpoint('loud', jsonQuery)
    return data
  }

  const endpoint = callEndpoint as typeof callEndpoint & {
    raw: RawEndpoint<Selectable, JsonResult, Ignored>
    memo: typeof callEndpoint
    memoRaw: RawEndpoint<Selectable, JsonResult, Ignored>
    settle: SettleEndpoint<Selectable, JsonResult, Ignored>
  }

  const memoizeeOptions = {
    maxAge: apiConfig.maxAge,
    isSerialized: true,
  }

  endpoint.raw = <Selection extends Selectable>(jsonQuery?: Selection & TolerateSettledSources) =>
    rawEndpoint<Selection>('silent', jsonQuery)
  endpoint.memo = memoize(endpoint, memoizeeOptions)

  endpoint.settle = async <Selection extends Selectable>(
    jsonQuery?: Selection
  ): Promise<SettledResponse<Projection<Selection, JsonResult, Ignored>>> => {
    if (kind === 'mutation') {
      const blocking = findBlockingSource(validateSources(readCallOptions(jsonQuery).settledSources))
      if (blocking) return blockedBySource(blocking)
    }

    let rawResult: ClassifiedRawResponse<Projection<Selection, JsonResult, Ignored>>
    try {
      rawResult = await rawEndpoint('silent', jsonQuery)
    } catch (error) {
      return settleThrown(error)
    }
    return settleRawResult(rawResult)
  }

  const memoizedRaw = memoize(endpoint.raw, memoizeeOptions)
  const memoRawWrapper = async (...args: Parameters<typeof memoizedRaw>) => {
    const result = await memoizedRaw(...args)
    if (result.outcome !== 'success') memoizedRaw.remove(args)
    return result
  }
  endpoint.memoRaw = Object.assign(memoRawWrapper, memoizedRaw)

  return endpoint
}
