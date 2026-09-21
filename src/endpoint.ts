import fromPairs from 'lodash/fromPairs.js'
import memoize from 'moize'
import { graphqlRequest } from './graphqlRequest'
import { jsonToGraphQLQuery } from './jsonToGraphQLQuery'
import { logRequest } from './logging'
import { Classification } from './settle/classify'
import { attachClassification, ClassifiedRawResponse, settleRawResult, settleThrown } from './settle/settleRaw'
import { blockedBySource, findBlockingSource, validateSources } from './settle/sources'
import { SettledResponse } from './settle/types'
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
  ResponseData,
  ResponseListenerInfo,
  SettleEndpoint,
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
  __settledSources?: unknown
}

function readCallOptions(jsonQuery: unknown): {
  alias?: string
  shouldRetry: boolean
  requestHeaders: Record<string, string>
  url?: string
  settledSources: unknown
} {
  const options = (jsonQuery ?? {}) as CallOptionInput
  return {
    alias: options.__alias,
    shouldRetry: options.__retry ?? true,
    requestHeaders: options.__headers ?? {},
    url: options.__url,
    settledSources: options.__settledSources,
  }
}

const executeListeners = (listeners: IResponseListener[], data: ResponseListenerInfo) =>
  setTimeout(() => listeners.forEach(runResponseListener => runResponseListener(data)))

/** Everything the endpoint factory needs from the generated client that owns it. */
type ApiConfig = {
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
}

/** Builds the endpoint factory a generated client uses to create one callable endpoint per query and mutation. */
export function getApiEndpointCreator(apiConfig: ApiConfig): ApiEndpointCreator {
  return <Selectable = any, Result = any, Ignored = any>(
    kind: OperationKind,
    queryName: string
  ): Endpoint<Selectable, Result, Ignored> => {
    type JsonResult = JsonOutput<Result, Ignored>

    type RawCall = <Selection extends Selectable>(
      failureMode: FailureMode,
      jsonQuery?: Selection
    ) => Promise<ClassifiedRawResponse<Projection<Selection, JsonResult, Ignored>>>

    const logIfVerbose = (logOptions: object, outcome: { response?: unknown; error?: Error }, start: number) => {
      if (!apiConfig.verbose || !globalThis.document) return
      logRequest({ ...logOptions, ...outcome, duration: +new Date() - start } as LogInfo)
    }

    const projectRootField = <Selection extends Selectable>(result: ResponseData, alias: string) => {
      const { classification, ...rawFields } = result
      const rawResult = { ...rawFields, data: rawFields.data?.[alias] } as ClassifiedRawResponse<
        Projection<Selection, JsonResult, Ignored>
      >
      return attachClassification(rawResult, classification as Classification)
    }

    const rawEndpoint: RawCall = async <Selection extends Selectable>(failureMode: FailureMode, jsonQuery?: Selection) => {
      const { alias: aliasOption, shouldRetry, requestHeaders, url: urlOption } = readCallOptions(jsonQuery)
      const alias = aliasOption ?? queryName
      const document = stripCallOptions(jsonQuery as Record<string, unknown> | undefined)
      const { query, variables } = jsonToGraphQLQuery({
        kind,
        queryName,
        alias: aliasOption,
        jsonQuery: document,
        typesTree: apiConfig.typesTree,
      })
      const start = +new Date()

      const logOptions = {
        kind,
        queryName: alias,
        formatGraphQL: apiConfig.formatGraphQL,
        requestHeaders,
        query,
        variables,
      }

      const listenerData = {
        queryName: alias,
        query: apiConfig.formatGraphQL(query),
        variables,
        headers: { ...requestHeaders },
      }

      await Promise.all(apiConfig.requestListeners.map(listener => listener(listenerData)))

      const clientConfig = apiConfig.getClient()
      const url = urlOption ?? clientConfig.url

      try {
        const result = await graphqlRequest({
          shouldRetry,
          failureMode,
          kind,
          queryName: alias,
          client: { ...clientConfig, url },
          requestHeaders: listenerData.headers,
          query,
          variables,
          errorsParser: apiConfig.errorsParser,
        })

        logIfVerbose(logOptions, { response: result }, start)
        executeListeners(apiConfig.responseListeners, { ...listenerData, response: result })
        return projectRootField<Selection>(result, alias)
      } catch (error) {
        logIfVerbose(logOptions, { error: error as Error }, start)
        executeListeners(apiConfig.responseListeners, {
          ...listenerData,
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
}
