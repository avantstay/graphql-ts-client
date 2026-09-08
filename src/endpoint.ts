import fromPairs from 'lodash/fromPairs.js'
import memoize from 'moize'
import { graphqlRequest } from './graphqlRequest'
import { jsonToGraphQLQuery } from './jsonToGraphQLQuery'
import { logRequest } from './logging'
import { ClassifiedRawResponse, settleRawResult, settleThrown } from './settle/settleRaw'
import { blockedBySource, findBlockingSource, validateSources } from './settle/sources'
import { SettledResponse } from './settle/types'
import {
  ClientConfig,
  Endpoint,
  GraphQLClientError,
  IRequestListener,
  IResponseListener,
  Projection,
  ResponseListenerInfo,
} from './types'

const KEYS_KEPT_IN_DOCUMENT = ['__args', '__typename']

/** Copies a selection without the endpoint's `__`-prefixed call options; `__args` and `__typename` belong in the document. */
function stripCallOptions(jsonQuery: any): any {
  if (!jsonQuery) return jsonQuery
  const documentKeys = Object.keys(jsonQuery).filter(key => !key.startsWith('__') || KEYS_KEPT_IN_DOCUMENT.includes(key))
  return fromPairs(documentKeys.map(key => [key, jsonQuery[key]]))
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

    const rawEndpoint: RawCall = async <S extends I>(failureMode: 'loud' | 'silent', jsonQuery?: S) => {
      const aliasOption = (jsonQuery as any)?.__alias
      const alias = aliasOption ?? queryName
      const shouldRetry = (jsonQuery as any)?.__retry ?? true
      const requestHeaders = (jsonQuery as any)?.__headers ?? {}
      const document = stripCallOptions(jsonQuery)
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
      const url = (jsonQuery as any)?.__url ?? clientConfig.url

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

        if (apiConfig.verbose && globalThis.document) {
          logRequest({
            ...logOptions,
            response: result,
            duration: +new Date() - start,
          })
        }

        executeListeners(apiConfig.responseListeners, {
          ...listenerData,
          response: result,
        })

        // The rest spread below drops the non-enumerable `classification`, so it is pulled out and re-attached the same way.
        const { classification, ...rawFields } = result
        const rawResult = { ...rawFields, data: rawFields.data?.[alias] } as ClassifiedRawResponse<Projection<S, O>>
        Object.defineProperty(rawResult, 'classification', { value: classification, enumerable: false })
        return rawResult
      } catch (error) {
        if (apiConfig.verbose && globalThis.document) {
          logRequest({
            ...logOptions,
            error: error as Error,
            duration: +new Date() - start,
          })
        }

        executeListeners(apiConfig.responseListeners, {
          ...listenerData,
          response: (error as GraphQLClientError).response,
        })

        throw error
      }
    }

    const endpoint: any = async <S extends I>(jsonQuery?: S): Promise<Projection<S, O>> => {
      const { data } = await rawEndpoint('loud', jsonQuery)
      return data
    }

    const memoizeeOptions = {
      maxAge: apiConfig.maxAge,
      isSerialized: true,
    }

    endpoint.raw = rawEndpoint.bind(null, 'silent')
    endpoint.memo = memoize(endpoint, memoizeeOptions)

    endpoint.settle = async <S extends I>(jsonQuery?: S): Promise<SettledResponse<Projection<S, O>>> => {
      if (kind === 'mutation') {
        const blocking = findBlockingSource(validateSources((jsonQuery as any)?.__settledSources))
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
    const memoRawWrapper = async (...args: any[]) => {
      const result = await memoizedRaw(...args)
      if (result.outcome !== 'success') memoizedRaw.remove(args)
      return result
    }
    endpoint.memoRaw = Object.assign(memoRawWrapper, memoizedRaw)

    return endpoint
  }
