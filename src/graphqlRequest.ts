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

type Headers = { [_key: string]: any }

export type GraphqlRequestOptions = {
  shouldRetry?: boolean
  failureMode: FailureMode
  axios?: AxiosStatic
  kind: OperationKind
  client: ClientConfig
  /** The alias used in the document and as the root key of `data`. */
  queryName: string
  query: string
  /** Produces the headers for each attempt; on a retry it receives the retry, so it can refresh credentials. */
  headersFor?: (retry?: RequestRetry) => Promise<Headers>
  variables: { [_key: string]: any }
  errorsParser?: (errors: any[]) => any
}

/**
 * Posts one GraphQL operation and returns the classified response. Eligible queries are retried on errors up to
 * `retryConfig.max`; with `retryConfig.unauthorized`, a 401 is retried once more for any operation. Every attempt,
 * the first included, takes its headers from `headersFor`.
 */
export async function graphqlRequest({
  shouldRetry = true,
  axios = _axios,
  kind,
  queryName,
  client,
  query,
  headersFor = async () => ({}),
  variables,
  failureMode,
  errorsParser,
}: GraphqlRequestOptions) {
  let response!: ResponseData
  let retry: RequestRetry | undefined
  let budget = initialRetryBudget(client, shouldRetry && kind === 'query')

  for (let trial = 0; ; trial++) {
    const requestHeaders = await headersFor(retry)
    const attempt = await postOperation({ axios, client, requestHeaders, queryName, query, variables, trial })
    const built = buildResponse(attempt, queryName, errorsParser)
    response = built.response

    const next = nextRetry(attempt.status, built.classification, budget)
    if (!next) break
    budget = next.budget
    if (next.kind === 'error') await beforeErrorRetry(client, { queryName, query, variables, response })
    retry = { trial: trial + 1, previousResponse: response }
  }

  if (failureMode === 'loud' && response.errors?.length) {
    throw new GraphQLClientError(response)
  }
  return response
}

/** The retries one operation may still make. */
type RetryBudget = { unauthorized: boolean; errors: number }

/**
 * Mutations get no error retries: a mutation that returned errors has an unknown server-side outcome. A 401 retry is
 * allowed for any operation, because the server rejected the request before running it.
 */
function initialRetryBudget(client: ClientConfig, retriesErrors: boolean): RetryBudget {
  return { unauthorized: client.retryConfig.unauthorized === true, errors: retriesErrors ? client.retryConfig.max : 0 }
}

/** Which retry, if any, follows this attempt, and the budget left after it. */
export function nextRetry(
  status: number,
  classification: Classification,
  budget: RetryBudget
): { kind: 'unauthorized' | 'error'; budget: RetryBudget } | undefined {
  if (status === 401 && budget.unauthorized) {
    return { kind: 'unauthorized', budget: { ...budget, unauthorized: false } }
  }
  const failedToRun =
    classification.outcome === 'failure' && (classification.reason === 'http' || classification.reason === 'no-data')
  if (failedToRun && budget.errors > 0) {
    return { kind: 'error', budget: { ...budget, errors: budget.errors - 1 } }
  }
  return undefined
}

/** Runs the configured `before` hook and waits, as configured, before an error retry. */
async function beforeErrorRetry(client: ClientConfig, info: Parameters<ClientConfig['retryConfig']['before']>[0]) {
  if (typeof client.retryConfig.before === 'function') await client.retryConfig.before(info)
  if (client.retryConfig.waitBeforeRetry) await sleep(client.retryConfig.waitBeforeRetry)
}
