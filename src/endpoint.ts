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
  GraphQLClientError,
  IRequestListener,
  IResponseListener,
  LogInfo,
  Projection,
  ResponseData,
  ResponseListenerInfo,
  SettleEndpoint,
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

/** Builds the endpoint factory a generated client uses to create one callable endpoint per query and mutation. */
export const getApiEndpointCreator =
  (apiConfig: {
    getClient: () => ClientConfig
    requestListeners: IRequestListener[]
    responseListeners: IResponseListener[]
    typesTree: any
    maxAge: number
    verbose: boolean
    formatGraphQL: any
    errorsParser?: (errors: any[]) => any
  }) =>
  <I = any, O = any, E = any>(kind: 'mutation' | 'query', queryName: string): Endpoint<I, O, E> => {
    type RawCall = <S extends I>(
      failureMode: 'loud' | 'silent',
      jsonQuery?: S
    ) => Promise<ClassifiedRawResponse<Projection<S, O>>>

    const logIfVerbose = (logOptions: object, outcome: { response?: unknown; error?: Error }, start: number) => {
      if (!apiConfig.verbose || !globalThis.document) return
      logRequest({ ...logOptions, ...outcome, duration: +new Date() - start } as LogInfo)
    }

    const projectRootField = <S extends I>(result: ResponseData, alias: string) => {
      const { classification, ...rawFields } = result
      const rawResult = { ...rawFields, data: rawFields.data?.[alias] } as ClassifiedRawResponse<Projection<S, O>>
      return attachClassification(rawResult, classification as Classification)
    }

    const rawEndpoint: RawCall = async <S extends I>(failureMode: 'loud' | 'silent', jsonQuery?: S) => {
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
        return projectRootField<S>(result, alias)
      } catch (error) {
        logIfVerbose(logOptions, { error: error as Error }, start)
        executeListeners(apiConfig.responseListeners, {
          ...listenerData,
          response: (error as GraphQLClientError).response,
        })

        throw error
      }
    }

    const callEndpoint = async <S extends I>(jsonQuery?: S): Promise<Projection<S, O>> => {
      const { data } = await rawEndpoint('loud', jsonQuery)
      return data
    }

    const endpoint = callEndpoint as typeof callEndpoint & {
      raw: (jsonQuery?: I) => Promise<ClassifiedRawResponse<Projection<I, O>>>
      memo: typeof callEndpoint
      memoRaw: (jsonQuery?: I) => Promise<ClassifiedRawResponse<Projection<I, O>>>
      settle: SettleEndpoint<I, O, never>
    }

    const memoizeeOptions = {
      maxAge: apiConfig.maxAge,
      isSerialized: true,
    }

    endpoint.raw = rawEndpoint.bind(null, 'silent')
    endpoint.memo = memoize(endpoint, memoizeeOptions)

    endpoint.settle = async <S extends I>(jsonQuery?: S): Promise<SettledResponse<Projection<S, O>>> => {
      if (kind === 'mutation') {
        const blocking = findBlockingSource(validateSources(readCallOptions(jsonQuery).settledSources))
        if (blocking) return blockedBySource(blocking)
      }

      let rawResult: ClassifiedRawResponse<Projection<S, O>>
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

    return endpoint as unknown as Endpoint<I, O, E>
  }
