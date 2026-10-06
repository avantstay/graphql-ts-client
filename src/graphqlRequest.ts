import _axios, { AxiosStatic } from 'axios'
import { classify, Classification } from './settle/classify'
import { attachClassification } from './settle/settleRaw'
import { ClientConfig, FailureMode, GraphQLClientError, OperationKind, RequestRetry, ResponseData } from './types'

const sleep = (ms = 0) => new Promise<void>(resolve => setTimeout(() => resolve(), ms))

/** The GraphQL envelope a server returns; every field is optional because an error response may carry none of them. */
type GraphQLBody = {
  data?: any
  errors?: any[]
  warnings?: any
  extensions?: { warnings?: any }
}

/** One attempt at the operation; `trial > 0` tags the request as a retry so the server can tell them apart. */
async function postOperation({
  axios,
  client,
  requestHeaders,
  queryName,
  query,
  variables,
  trial,
}: {
  axios: AxiosStatic
  client: ClientConfig
  requestHeaders: { [_key: string]: any }
  queryName: string
  query: string
  variables: { [_key: string]: any }
  trial: number
}) {
  const infoParams = { _q: queryName, ...(trial > 0 ? { _retrial: trial + 1 } : {}) }
  const {
    data: responseData = {} as GraphQLBody,
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

  return { responseData, headers, status }
}

/** Classifies one attempt's payload and assembles the response the endpoint layer reads. */
function buildResponse(
  attempt: { responseData: GraphQLBody; headers: any; status: number },
  queryName: string,
  errorsParser?: (errors: any[]) => any
): { response: ResponseData; classification: Classification } {
  const { responseData, headers, status } = attempt
  const { data } = responseData
  const warnings = responseData.extensions?.warnings ?? responseData.warnings
  let errors: any = responseData.errors
  if (status >= 400 && !errors?.length) {
    errors = [{ message: `Request "${queryName}" failed with status ${status}` }]
  }

  const classification = classify({
    data: data?.[queryName],
    errors,
    warnings,
    status,
    rootName: queryName,
  })

  const response = attachClassification(
    {
      errors: errorsParser ? errorsParser(errors) : errors,
      data,
      warnings,
      headers,
      status,
      outcome: classification.outcome,
      ...(classification.outcome === 'failure' ? { reason: classification.reason } : {}),
      failedPaths: classification.failedPaths,
    } as ResponseData,
    classification
  )

  return { response, classification }
}

export type GraphqlRequestOptions = {
  shouldRetry?: boolean
  failureMode: FailureMode
  axios?: AxiosStatic
  kind: OperationKind
  client: ClientConfig
  /** The alias used in the document and as the root key of `data`. */
  queryName: string
  query: string
  requestHeaders?: { [_key: string]: any }
  /** Produces the headers for each retry, so they are as current as the first attempt's; defaults to reusing them. */
  prepareRetryHeaders?: (retry: RequestRetry) => Promise<{ [_key: string]: any }>
  variables: { [_key: string]: any }
  errorsParser?: (errors: any[]) => any
}

/**
 * Posts one GraphQL operation and returns the classified response. Eligible queries are retried up to
 * `retryConfig.max`; with `retryConfig.unauthorized`, a 401 is retried once more for any operation. Every retry asks
 * `prepareRetryHeaders` for its headers.
 */
export async function graphqlRequest({
  shouldRetry = true,
  axios = _axios,
  kind,
  queryName,
  client,
  query,
  requestHeaders = {},
  prepareRetryHeaders,
  variables,
  failureMode,
  errorsParser,
}: GraphqlRequestOptions) {
  let lastResponse!: ResponseData
  // Mutations are never retried on errors: a mutation that returned errors has an unknown server-side outcome.
  const maxRetrials = shouldRetry && kind === 'query' ? client.retryConfig.max : 0
  // A 401 means the server rejected the request before running it, so one more attempt is safe for any operation.
  let unauthorizedRetryLeft = client.retryConfig.unauthorized === true
  let errorRetries = 0
  let headers = requestHeaders

  for (let trial = 0; ; trial++) {
    const attempt = await postOperation({ axios, client, requestHeaders: headers, queryName, query, variables, trial })
    const { response, classification } = buildResponse(attempt, queryName, errorsParser)
    lastResponse = response

    if (attempt.status === 401 && unauthorizedRetryLeft) {
      unauthorizedRetryLeft = false
    } else {
      const retryable =
        classification.outcome === 'failure' && (classification.reason === 'http' || classification.reason === 'no-data')
      if (!retryable || errorRetries >= maxRetrials) break
      errorRetries++
      if (typeof client.retryConfig.before === 'function') {
        await client.retryConfig.before({ queryName, query, variables, response: lastResponse })
      }
      if (client.retryConfig.waitBeforeRetry) await sleep(client.retryConfig.waitBeforeRetry)
    }

    if (prepareRetryHeaders) headers = await prepareRetryHeaders({ trial: trial + 1, previousResponse: lastResponse })
  }

  if (failureMode === 'loud' && lastResponse.errors?.length) {
    throw new GraphQLClientError(lastResponse)
  }
  return lastResponse
}
