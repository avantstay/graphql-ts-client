import { classify } from './settle/classify'
import { SettledResponse } from './settle/types'
import { graphqlRequest } from './graphqlRequest'
import { clientWithRetries } from './testSupport/clientConfig'
import { createTestEndpointCreator } from './testSupport/endpointFixture'
import apollo from './testSupport/routerContracts/apollo.json'
import hive from './testSupport/routerContracts/hive.json'
import { GraphQLResponseBody, OperationTransportResponse } from './types'

type Fixture = { status: number; headers: Record<string, string>; body: GraphQLResponseBody; provenance: string }

const requestCases = [
  { name: 'validation', rootName: 'topProducts', code: 'GRAPHQL_VALIDATION_FAILED', errorCount: 2, status: 400 },
  { name: 'multiple-operations', rootName: 'viewer', code: 'GRAPHQL_VALIDATION_FAILED', errorCount: 1, status: 400 },
  { name: 'unknown-operation-name', rootName: 'viewer', code: 'GRAPHQL_UNKNOWN_OPERATION_NAME', errorCount: 1, status: 400 },
  { name: 'parse', rootName: 'i', code: 'PARSING_ERROR', errorCount: 1, status: 400 },
  { name: 'coercion', rootName: 'int', code: 'VALIDATION_INVALID_TYPE_VARIABLE', errorCount: 1, status: 400 },
  { name: 'coercion-null', rootName: 'int', code: 'VALIDATION_INVALID_TYPE_VARIABLE', errorCount: 1, status: 400 },
  { name: 'coercion-wrong-type', rootName: 'int', code: 'VALIDATION_INVALID_TYPE_VARIABLE', errorCount: 1, status: 400 },
  { name: 'csrf', rootName: 'viewer', code: 'CSRF_ERROR', errorCount: 1, status: 400 },
  { name: 'get-mutation', rootName: 'renameProduct', code: 'MUTATION_FORBIDDEN', errorCount: 1, status: 405 },
] as const

const cases = [
  { name: 'success', rootName: 'product', outcome: 'success', failedPaths: [], errorPaths: [], redacted: [] },
  {
    name: 'partial-path-error',
    rootName: 'product',
    outcome: 'partial',
    failedPaths: ['name'],
    errorPaths: [['name']],
    redacted: [true],
  },
  {
    name: 'partial-bad-user-input',
    rootName: 'product',
    outcome: 'partial',
    failedPaths: ['name'],
    errorPaths: [['name']],
    redacted: [true],
  },
  {
    name: 'redacted-subgraph-error',
    rootName: 'product',
    outcome: 'failure',
    reason: 'no-data',
    failedPaths: [],
    errorPaths: [undefined],
    redacted: [true],
  },
  {
    name: 'unauthenticated',
    rootName: 'product',
    outcome: 'failure',
    reason: 'http',
    failedPaths: [],
    errorPaths: [undefined],
    redacted: [false],
  },
  {
    name: 'unauthorized',
    rootName: 'product',
    outcome: 'failure',
    reason: 'http',
    failedPaths: [],
    errorPaths: [undefined],
    redacted: [false],
  },
  ...requestCases.map(contract => ({
    ...contract,
    outcome: 'failure' as const,
    reason: 'http' as const,
    failedPaths: [],
    errorPaths: Array.from({ length: contract.errorCount }, () => undefined),
    redacted: Array.from({ length: contract.errorCount }, () => false),
  })),
  {
    name: 'subgraph-error-with-code',
    rootName: 'product',
    outcome: 'failure',
    reason: 'no-data',
    failedPaths: [],
    errorPaths: [['requiredName']],
    redacted: [true],
  },
] as const

function attempt(fixture: Fixture): OperationTransportResponse {
  return { status: fixture.status, headers: fixture.headers, data: fixture.body }
}

describe.each(cases)('router contract: $name', contract => {
  it('preserves each body through classify, graphqlRequest and settle()', async () => {
    const results: SettledResponse<unknown>[] = []
    for (const router of [apollo, hive]) {
      const fixture: Fixture = router.responses[contract.name]
      const { body, status, headers } = fixture
      if ('code' in contract) {
        expect(status).toBe(contract.status)
        expect(body.data).toBeUndefined()
        expect(body.errors).toHaveLength(contract.errorCount)
        for (const error of body.errors ?? []) {
          expect(error.extensions?.code).toBe(contract.code)
          expect(error.path).toBeUndefined()
        }
      }
      const expected = {
        outcome: contract.outcome,
        ...('reason' in contract ? { reason: contract.reason } : {}),
        failedPaths: contract.failedPaths,
        errors: (body.errors ?? []).map((error, index) => ({
          message: error.message,
          extensions: error.extensions,
          locations: error.locations,
          path: contract.errorPaths[index],
          redacted: contract.redacted[index],
        })),
      }
      const classification = classify({
        data: body.data?.[contract.rootName],
        errors: body.errors,
        warnings: undefined,
        status,
        rootName: contract.rootName,
      })
      expect(classification).toEqual(expect.objectContaining(expected))

      const transport = jest.fn(async () => attempt(fixture))
      const client = { ...clientWithRetries(0), transport }
      const kind = contract.name === 'get-mutation' ? 'mutation' : 'query'
      const raw = await graphqlRequest({
        kind,
        queryName: contract.rootName,
        query: '',
        variables: {},
        failureMode: 'silent',
        client,
      })
      expect(raw).toMatchObject({ outcome: expected.outcome, failedPaths: expected.failedPaths, status, headers })
      expect(raw.reason).toBe('reason' in contract ? contract.reason : undefined)
      expect(raw.errors).toEqual(body.errors)
      expect(raw.data).toEqual(body.data)

      const createEndpoint = createTestEndpointCreator({ getClient: () => client })
      const endpoint =
        kind === 'mutation' ? createEndpoint('mutation', contract.rootName) : createEndpoint('query', contract.rootName)
      const settled = await endpoint.settle({ id: true, ...(kind === 'mutation' ? { __settledSources: 'none' } : {}) } as any)
      expect(settled).toMatchObject({ ...expected, status })
      expect(settled.warnings).toEqual([])
      if (contract.outcome === 'failure') expect(settled.data).toBeNull()
      if (contract.name === 'partial-path-error' || contract.name === 'partial-bad-user-input') {
        expect(settled.data).toEqual({ id: '1', name: undefined, requiredName: 'Desk' })
      }
      if (contract.name === 'partial-bad-user-input') expect(settled.errors[0].extensions?.code).toBe('BAD_USER_INPUT')
      if (contract.name === 'get-mutation') expect(raw.headers).toEqual({ allow: 'POST' })
      expect(transport).toHaveBeenCalledTimes(2)
      results.push(settled)
    }
    const comparable = ({ outcome, failedPaths, errors, data, status, warnings, ...result }: SettledResponse<unknown>) => ({
      outcome,
      data,
      status,
      warnings,
      reason: 'reason' in result ? result.reason : undefined,
      failedPaths,
      errors: errors.map(({ path, redacted, extensions }) => ({ path, redacted, code: extensions?.code })),
    })
    // Router diagnostics and extensions.name may differ; each is preserved above.
    expect(comparable(results[0])).toEqual(comparable(results[1]))
  })
})

it.each(['unauthenticated', 'unauthorized'] as const)(
  'retries each router %s 401 once, retaining WWW-Authenticate',
  async name => {
    for (const router of [apollo, hive]) {
      const fixture: Fixture = router.responses[name]
      const transport = jest.fn().mockResolvedValue(attempt(fixture))
      const before = jest.fn()
      const client = clientWithRetries(0, { before })
      client.retryConfig.unauthorized = true
      client.transport = transport
      const headersFor = jest.fn(async () => ({}))
      const result = await graphqlRequest({
        kind: 'query',
        queryName: 'product',
        query: '',
        variables: {},
        failureMode: 'silent',
        client,
        headersFor,
      })
      expect(transport).toHaveBeenCalledTimes(2)
      expect(before).not.toHaveBeenCalled()
      expect(headersFor).toHaveBeenLastCalledWith({
        trial: 1,
        previousResponse: expect.objectContaining({ headers: { 'www-authenticate': 'Bearer error="invalid_token"' } }),
      })
      expect(result).toMatchObject({ status: 401, outcome: 'failure', reason: 'http', headers: fixture.headers })
    }
  }
)

it.each(requestCases)('preserves 13.2.0 retry behavior for $name', async contract => {
  for (const router of [apollo, hive]) {
    const fixture: Fixture = router.responses[contract.name]
    const transport = jest.fn().mockResolvedValue(attempt(fixture))
    const before = jest.fn()
    const client = { ...clientWithRetries(2, { before }), transport }
    const kind = contract.name === 'get-mutation' ? 'mutation' : 'query'
    const result = await graphqlRequest({
      kind,
      queryName: contract.rootName,
      query: '',
      variables: {},
      failureMode: 'silent',
      client,
    })
    expect(result).toMatchObject({ outcome: 'failure', reason: 'http', status: contract.status })
    expect(transport).toHaveBeenCalledTimes(kind === 'query' ? 3 : 1)
    expect(before).toHaveBeenCalledTimes(kind === 'query' ? 2 : 0)
  }
})

it('does not retry a partial subgraph BAD_USER_INPUT', async () => {
  for (const router of [apollo, hive]) {
    const fixture: Fixture = router.responses['partial-bad-user-input']
    const transport = jest.fn().mockResolvedValue(attempt(fixture))
    const before = jest.fn()
    const client = { ...clientWithRetries(2, { before }), transport }
    const endpoint = createTestEndpointCreator({ getClient: () => client })('query', 'product')
    const result = await endpoint.settle({ id: true, name: true } as any)
    expect(result).toMatchObject({
      outcome: 'partial',
      status: 200,
      data: { id: '1', name: undefined },
      failedPaths: ['name'],
      errors: [{ path: ['name'], extensions: { code: 'BAD_USER_INPUT' } }],
    })
    expect(transport).toHaveBeenCalledTimes(1)
    expect(before).not.toHaveBeenCalled()
  }
})
