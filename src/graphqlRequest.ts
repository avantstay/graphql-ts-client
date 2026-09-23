import _axios, { AxiosStatic } from 'axios'
import { ClientConfig, GraphQLClientError, ResponseData } from './types'

const sleep = (ms = 0) =>
  new Promise<void>(resolve => {
    setTimeout(() => resolve(), ms)
  })

export async function graphqlRequest({
  shouldRetry = true,
  axios = _axios,
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
  client: ClientConfig
  queryName: string
  query: string
  requestHeaders?: { [_key: string]: any }
  variables: { [_key: string]: any }
  errorsParser?: (errors: any[]) => any
}) {
  let lastResponse: ResponseData

  const maxRetrials = shouldRetry ? client.retryConfig.max : 0

  for (let trial = 0; true; trial++) {
    const infoParams = {
      _q: queryName,
      ...(trial > 0 ? { _retrial: trial + 1 } : {}),
    }

    const {
      data: responseData = {} as any,
      headers,
      status,
    } = await axios.post(
      client.url,
      { query, variables, operationName: queryName },
      {
        params: infoParams,
        headers: {
          'Content-Type': 'application/json',
          ...client.headers,
          ...requestHeaders,
        },
        validateStatus: () => true,
      }
    )

    const { data } = responseData
    let errors = liftErrorExtensions(responseData.errors)
    const warnings = readWarnings(responseData)

    if (status >= 400 && !errors?.length) {
      errors = [{ message: `Request "${queryName}" failed with status ${status}` }]
    }

    lastResponse = {
      errors: errorsParser ? errorsParser(errors) : errors,
      data,
      warnings,
      headers,
      status,
    }

    if (!errors?.length) {
      break
    } else if (trial < maxRetrials && typeof client.retryConfig?.before === 'function') {
      await client.retryConfig?.before({
        queryName,
        query,
        variables,
        response: lastResponse,
      })

      if (client.retryConfig.waitBeforeRetry) {
        await sleep(client.retryConfig.waitBeforeRetry)
      }
    } else if (trial >= maxRetrials) {
      break
    }
  }

  if (failureMode === 'loud' && lastResponse!.errors && lastResponse!.errors?.length) {
    throw new GraphQLClientError(lastResponse)
  }

  return lastResponse!
}

// The Arriere monolith (arriere@16aefc85) moved request warnings from the top level to
// `extensions.warnings`, and each error's `code` and public fields to `errors[].extensions.code`
// and `errors[].extensions.details`. These helpers restore the legacy top-level shape so existing
// readers of `warnings` and `errors[].code` keep working against both old and new servers.

// Extension warnings win whenever they are present, an empty array included.
function readWarnings(responseData: any) {
  return responseData.extensions?.warnings ?? responseData.warnings
}

// Fields already on the error win over lifted ones, and `extensions` stays untouched.
function liftErrorExtensions(errors: any) {
  if (!Array.isArray(errors)) return errors

  return errors.map((error: any) =>
    error?.extensions
      ? Object.assign(
          {},
          error.extensions.details,
          error.extensions.code != null ? { code: error.extensions.code } : {},
          error
        )
      : error
  )
}
