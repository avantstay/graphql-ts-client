import { graphqlRequest } from './graphqlRequest'

function clientWithRetries(max: number) {
  return { url: 'https://example.invalid/graphql', headers: {}, retryConfig: { max, before: () => undefined } }
}

function axiosReturning(responses: Array<{ status: number; data?: unknown }>) {
  let call = 0
  return { post: async () => responses[Math.min(call++, responses.length - 1)] } as any
}

/** Same as axiosReturning, but exposes how many requests were actually made. */
function countingAxios(responses: Array<{ status: number; data?: unknown }>) {
  const calls: number[] = []
  const axios = {
    post: async () => {
      calls.push(Date.now())
      return responses[Math.min(calls.length - 1, responses.length - 1)]
    },
  } as any
  return { axios, calls }
}

const noDataResponse = { status: 200, data: { data: null, errors: [{ message: 'nothing came back' }] } }

const common = { queryName: 'user', query: 'query user { user { id } }', variables: {}, failureMode: 'silent' as const }

describe('retry policy', () => {
  it('retries a query on http failure until it succeeds', async () => {
    const axios = axiosReturning([{ status: 500 }, { status: 200, data: { data: { user: { id: 'user_1' } } } }])
    const result = await graphqlRequest({ ...common, kind: 'query', axios, client: clientWithRetries(2) })
    expect(result.status).toBe(200)
    expect(result.outcome).toBe('success')
  })

  it('does not retry a partial query', async () => {
    const axios = axiosReturning([
      {
        status: 200,
        data: { data: { user: { id: 'user_1', stats: null } }, errors: [{ message: 'x', path: ['user', 'stats'] }] },
      },
      { status: 200, data: { data: { user: { id: 'user_1', stats: {} } } } },
    ])
    const result = await graphqlRequest({ ...common, kind: 'query', axios, client: clientWithRetries(2) })
    expect(result.outcome).toBe('partial')
    expect(result.failedPaths).toEqual(['stats'])
  })

  it('never retries a mutation, even with retries enabled', async () => {
    const axios = axiosReturning([{ status: 500 }, { status: 200, data: { data: { updateUser: { id: 'user_1' } } } }])
    const result = await graphqlRequest({
      ...common,
      kind: 'mutation',
      queryName: 'updateUser',
      axios,
      client: clientWithRetries(2),
    })
    expect(result.status).toBe(500)
    expect(result.outcome).toBe('failure')
    expect(result.reason).toBe('http')
  })

  it('exposes codes and requestIds on the raw result and leaves data untouched', async () => {
    const data = { user: { id: 'user_1', stats: null } }
    const errors = [{ message: 'x', path: ['user', 'stats'], extensions: { code: 'SERVICE_UNAVAILABLE', requestId: 'r1' } }]
    const axios = axiosReturning([{ status: 200, data: { data, errors } }])
    const result = await graphqlRequest({ ...common, kind: 'query', axios, client: clientWithRetries(0) })
    expect(result.codes).toEqual(['SERVICE_UNAVAILABLE'])
    expect(result.requestIds).toEqual(['r1'])
    expect(result.data).toEqual(data)
    expect(result.errors).toEqual(errors)
  })

  it('retries a query on a no-data failure until it succeeds', async () => {
    const { axios, calls } = countingAxios([noDataResponse, { status: 200, data: { data: { user: { id: 'user_1' } } } }])
    const result = await graphqlRequest({ ...common, kind: 'query', axios, client: clientWithRetries(2) })

    expect(calls).toHaveLength(2)
    expect(result.outcome).toBe('success')
    expect(result.data).toEqual({ user: { id: 'user_1' } })
  })

  it('gives up on a no-data failure after the configured number of retries', async () => {
    const { axios, calls } = countingAxios([noDataResponse])
    const result = await graphqlRequest({ ...common, kind: 'query', axios, client: clientWithRetries(2) })

    expect(calls).toHaveLength(3)
    expect(result.outcome).toBe('failure')
    expect(result.reason).toBe('no-data')
  })

  it('calls the before hook once per retry with the response that triggered it', async () => {
    const beforeCalls: Array<{ queryName: string; response: any }> = []
    const { axios, calls } = countingAxios([{ status: 500 }, noDataResponse, { status: 200, data: { data: { user: {} } } }])
    const client = {
      url: 'https://example.invalid/graphql',
      headers: {},
      retryConfig: { max: 3, before: (info: any) => void beforeCalls.push(info) },
    }

    const result = await graphqlRequest({ ...common, kind: 'query', axios, client })

    expect(calls).toHaveLength(3)
    expect(beforeCalls).toHaveLength(2)
    expect(beforeCalls.map(call => call.queryName)).toEqual(['user', 'user'])
    expect(beforeCalls[0].response.status).toBe(500)
    expect(beforeCalls[0].response.reason).toBe('http')
    expect(beforeCalls[1].response.status).toBe(200)
    expect(beforeCalls[1].response.reason).toBe('no-data')
    expect(result.outcome).toBe('success')
  })

  it('awaits waitBeforeRetry between attempts', async () => {
    const waitBeforeRetry = 60
    const { axios, calls } = countingAxios([{ status: 500 }, { status: 200, data: { data: { user: { id: 'user_1' } } } }])
    const client = {
      url: 'https://example.invalid/graphql',
      headers: {},
      retryConfig: { max: 1, waitBeforeRetry, before: () => undefined },
    }

    const result = await graphqlRequest({ ...common, kind: 'query', axios, client })

    expect(calls).toHaveLength(2)
    // Timer granularity can shave a millisecond or two off the observed gap, so allow a small margin.
    expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(waitBeforeRetry - 5)
    expect(result.outcome).toBe('success')
  })

  it('does not retry when the call opts out with __retry: false', async () => {
    const beforeCalls: any[] = []
    const { axios, calls } = countingAxios([{ status: 500 }, { status: 200, data: { data: { user: { id: 'user_1' } } } }])
    const client = {
      url: 'https://example.invalid/graphql',
      headers: {},
      retryConfig: { max: 2, before: (info: any) => void beforeCalls.push(info) },
    }

    const result = await graphqlRequest({ ...common, kind: 'query', shouldRetry: false, axios, client })

    expect(calls).toHaveLength(1)
    expect(beforeCalls).toHaveLength(0)
    expect(result.status).toBe(500)
    expect(result.outcome).toBe('failure')
  })
})
