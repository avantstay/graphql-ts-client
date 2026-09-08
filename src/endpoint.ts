import memoize from 'moize'
import { graphqlRequest } from './graphqlRequest'
import { jsonToGraphQLQuery } from './jsonToGraphQLQuery'
import { logRequest } from './logging'
import { applyFailedPaths, Classification, toSettled } from './settle/classify'
import { AnySettled, MutationSources, SettledResponse } from './settle/types'
import {
  ClientConfig,
  Endpoint,
  GraphQLClientError,
  IRequestListener,
  IResponseListener,
  MissingSourcesError,
  Projection,
  ResponseListenerInfo,
} from './types'

function stripCallOptions(jsonQuery: any): { document: any; require: string[] | undefined; sources: unknown } {
  if (!jsonQuery) return { document: jsonQuery, require: undefined, sources: undefined }
  const { __require: require, __sources: sources, ...document } = jsonQuery
  return { document, require, sources }
}

function validateSources(sources: unknown): MutationSources {
  const noneReason = !Array.isArray(sources) ? (sources as { none?: unknown } | undefined)?.none : undefined
  const missing =
    sources === undefined ||
    (Array.isArray(sources) && sources.length === 0) ||
    (!Array.isArray(sources) && (typeof noneReason !== 'string' || noneReason.trim() === ''))
  if (missing) throw new MissingSourcesError()
  return sources as MutationSources
}

// A source that failed blocks too, not only a partial one: a payload built from it carries undefined or stale values.
function findBlockingSource(sources: MutationSources): AnySettled | undefined {
  return Array.isArray(sources) ? sources.find(source => source.outcome !== 'success') : undefined
}

const executeListeners = (listeners: IResponseListener[], data: ResponseListenerInfo) =>
  setTimeout(() => listeners.forEach(runResponseListener => runResponseListener(data)))

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
    const rawEndpoint: any = async <S extends I>(
      failureMode: 'loud' | 'silent',
      jsonQuery?: S
    ): Promise<{
      data: Projection<S, O>
      errors: any[]
      warnings: any[]
      headers: any
      status: any
    }> => {
      const alias = (jsonQuery as any)?.__alias ?? queryName
      const shouldRetry = (jsonQuery as any)?.__retry ?? true
      const requestHeaders = (jsonQuery as any)?.__headers ?? {}
      const { document, require } = stripCallOptions(jsonQuery)
      const { query, variables } = jsonToGraphQLQuery({ kind, queryName, jsonQuery: document, typesTree: apiConfig.typesTree })
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
          require,
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

        const { classification, ...rawFields } = result
        const rawResult: any = { ...rawFields, data: rawFields.data?.[alias] }
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
        const sources = validateSources((jsonQuery as any)?.__sources)
        const blocking = findBlockingSource(sources)
        if (blocking) {
          return toSettled(null as any, {
            outcome: 'failure',
            reason: 'partial-source',
            errors: blocking.errors,
            warnings: [],
            failedPaths: blocking.failedPaths,
            failedSegments: [],
            codes: blocking.codes,
            requestIds: blocking.requestIds,
          })
        }
      }
      let rawResult: any
      try {
        rawResult = await rawEndpoint('silent', jsonQuery)
      } catch (error) {
        // settle() never throws except MissingSourcesError (thrown above, before this call): any other
        // thrown error — a GraphQLClientError from 'silent' mode, or a transport failure like axios
        // rejecting on a network error — becomes an outcome: 'failure', reason: 'http' result.
        return toSettled(
          null as any,
          {
            outcome: 'failure',
            reason: 'http',
            errors: [{ message: error instanceof Error ? error.message : String(error), redacted: false }],
            warnings: [],
            failedPaths: [],
            failedSegments: [],
            codes: [],
            requestIds: [],
          },
          undefined
        )
      }
      const classification: Classification = rawResult.classification
      // rawResult.data shares object references with the payload already handed to response listeners
      // (listeners fire on a setTimeout, after this call returns), so mutate a clone, never the original.
      let normalisedData = rawResult.data
      if (classification.outcome !== 'failure' && classification.failedSegments.length > 0) {
        normalisedData = JSON.parse(JSON.stringify(rawResult.data))
        applyFailedPaths(normalisedData, classification.failedSegments)
      }
      return toSettled(
        classification.outcome === 'failure' ? null : normalisedData,
        classification,
        typeof rawResult.status === 'number' ? rawResult.status : undefined
      )
    }

    const memoizedRaw = memoize(endpoint.raw, memoizeeOptions)
    const memoRawWrapper = async (...args: any[]) => {
      const result = await memoizedRaw(...args)
      if (result.outcome !== 'success') memoizedRaw.remove(args)
      return result
    }
    // Keep moize's surface (.clear(), .remove(), .cache, etc.) available on the wrapper.
    endpoint.memoRaw = Object.assign(memoRawWrapper, memoizedRaw)

    return endpoint
  }
