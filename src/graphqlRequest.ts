import _axios, { AxiosStatic } from 'axios'
import { classify, Classification } from './settle/classify'
import { attachClassification } from './settle/settleRaw'
import { ClientConfig, GraphQLClientError, ResponseData } from './types'

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
  let lastResponse!: ResponseData
  // Mutations are never retried: a mutation that returned errors has an unknown server-side outcome.
  const maxRetrials = shouldRetry && kind === 'query' ? client.retryConfig.max : 0

  for (let trial = 0; ; trial++) {
    const attempt = await postOperation({ axios, client, requestHeaders, queryName, query, variables, trial })
    const { response, classification } = buildResponse(attempt, queryName, errorsParser)
    lastResponse = response

    const retryable =
      classification.outcome === 'failure' && (classification.reason === 'http' || classification.reason === 'no-data')
    if (!retryable || trial >= maxRetrials) break
    if (typeof client.retryConfig.before === 'function') {
      await client.retryConfig.before({ queryName, query, variables, response: lastResponse })
    }
    if (client.retryConfig.waitBeforeRetry) await sleep(client.retryConfig.waitBeforeRetry)
  }

  if (failureMode === 'loud' && lastResponse.errors?.length) {
    throw new GraphQLClientError(lastResponse)
  }
  return lastResponse
}
