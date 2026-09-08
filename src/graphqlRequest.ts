import _axios, { AxiosStatic } from 'axios'
import { classify } from './settle/classify'
import { ClientConfig, GraphQLClientError, ResponseData } from './types'

const sleep = (ms = 0) => new Promise<void>(resolve => setTimeout(() => resolve(), ms))

/** Posts one GraphQL operation, retrying eligible queries, and returns the classified response. */
export async function graphqlRequest({
  shouldRetry = true,
  axios = _axios,
  kind,
  queryName,
  client,
  query,
  requestHeaders = {},
  variables,
  failureMode,
  errorsParser,
}: {
  shouldRetry?: boolean
  failureMode: 'loud' | 'silent'
  axios?: AxiosStatic
  kind: 'query' | 'mutation'
  client: ClientConfig
  /** The alias used in the document and as the root key of `data`. */
  queryName: string
  query: string
  requestHeaders?: { [_key: string]: any }
  variables: { [_key: string]: any }
  errorsParser?: (errors: any[]) => any
}) {
  let lastResponse: ResponseData | undefined
  // Mutations are never retried: a mutation that returned errors has an unknown server-side outcome.
  const maxRetrials = shouldRetry && kind === 'query' ? client.retryConfig.max : 0

  for (let trial = 0; true; trial++) {
    const infoParams = { _q: queryName, ...(trial > 0 ? { _retrial: trial + 1 } : {}) }
    const {
      data: responseData = {} as any,
      headers,
      status,
    } = await axios.post(
      client.url,
      { query, variables, operationName: queryName },
      {
        params: infoParams,
        headers: { 'Content-Type': 'application/json', ...client.headers, ...requestHeaders },
        validateStatus: () => true,
      }
    )

    let { data, errors } = responseData
    const warnings = responseData.extensions?.warnings ?? responseData.warnings
    if (status >= 400 && !errors?.length) {
      errors = [{ message: `Request "${queryName}" failed with status ${status}` }]
    }

    const classification = classify({
      data: data?.[queryName],
      errors,
      warnings,
      status: typeof status === 'number' ? status : undefined,
      rootName: queryName,
    })

    lastResponse = {
      errors: errorsParser ? errorsParser(errors) : errors,
      data,
      warnings,
      headers,
      status,
      outcome: classification.outcome,
      ...(classification.outcome === 'failure' ? { reason: classification.reason } : {}),
      failedPaths: classification.failedPaths,
    } as ResponseData
    // Non-enumerable so listener payloads and GraphQLClientError.response never carry it, while settle() still reads it by name.
    Object.defineProperty(lastResponse, 'classification', { value: classification, enumerable: false })

    const retryable =
      classification.outcome === 'failure' && (classification.reason === 'http' || classification.reason === 'no-data')
    if (!retryable || trial >= maxRetrials) break
    if (typeof client.retryConfig.before === 'function') {
      await client.retryConfig.before({ queryName, query, variables, response: lastResponse })
    }
    if (client.retryConfig.waitBeforeRetry) await sleep(client.retryConfig.waitBeforeRetry)
  }

  const response = lastResponse as ResponseData
  if (failureMode === 'loud' && response.errors?.length) {
    throw new GraphQLClientError(response)
  }
  return response
}
