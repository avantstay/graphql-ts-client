import { classify } from './settle/classify'
import { SettledResponse } from './settle/types'
import { graphqlRequest } from './graphqlRequest'
import { clientWithRetries } from './testSupport/clientConfig'
import { createTestEndpointCreator } from './testSupport/endpointFixture'
import apollo from './testSupport/routerContracts/apollo.json'
import hive from './testSupport/routerContracts/hive.json'
import { GraphQLResponseBody, OperationTransportResponse } from './types'

type Fixture = { status: number; headers: Record<string, string>; body: GraphQLResponseBody; provenance: string }

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
  {
    name: 'validation',
    rootName: 'topProducts',
    outcome: 'failure',
    reason: 'http',
    failedPaths: [],
    errorPaths: [undefined, undefined],
    redacted: [false, false],
  },
  {
    name: 'parse',
    rootName: 'i',
    outcome: 'failure',
    reason: 'http',
    failedPaths: [],
    errorPaths: [undefined],
    redacted: [false],
  },
  {
    name: 'coercion',
    rootName: 'int',
    outcome: 'failure',
    reason: 'http',
    failedPaths: [],
    errorPaths: [undefined],
    redacted: [false],
  },
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
      const raw = await graphqlRequest({
        kind: 'query',
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

      const endpoint = createTestEndpointCreator({ getClient: () => client })('query', contract.rootName)
      const settled = await endpoint.settle({ id: true } as any)
      expect(settled).toMatchObject({ ...expected, status })
      if (contract.name === 'partial-path-error') {
        expect(settled.data).toEqual({ id: '1', name: undefined, requiredName: 'Desk' })
      }
      results.push(settled)
    }
    const comparable = ({ outcome, failedPaths, errors, ...result }: SettledResponse<unknown>) => ({
      outcome,
      reason: 'reason' in result ? result.reason : undefined,
      failedPaths,
      errors: errors.map(({ path, redacted, extensions }) => ({ path, redacted, extensions })),
    })
    if (contract.name === 'coercion') {
      expect(results.map(result => result.errors[0].extensions?.code)).toEqual([
        'VALIDATION_INVALID_TYPE_VARIABLE',
        'BAD_USER_INPUT',
      ])
      expect(results.map(result => result.outcome)).toEqual(['failure', 'failure'])
      expect(results.map(result => 'reason' in result && result.reason)).toEqual(['http', 'http'])
      expect(results.map(result => result.failedPaths)).toEqual([[], []])
    } else {
      expect(comparable(results[0])).toEqual(comparable(results[1]))
      if (contract.name !== 'parse') expect(results[0].errors).toEqual(results[1].errors)
    }
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

it.each(['validation', 'parse', 'coercion'] as const)('keeps request failure retry behavior explicit for %s', async name => {
  for (const router of [apollo, hive]) {
    const fixture: Fixture = router.responses[name]
    const transport = jest.fn().mockResolvedValue(attempt(fixture))
    const client = { ...clientWithRetries(2), transport }
    await graphqlRequest({ kind: 'query', queryName: 'product', query: '', variables: {}, failureMode: 'silent', client })
    // Apollo's coercion code is outside the request-error set; the router shim still needs to align it.
    expect(transport).toHaveBeenCalledTimes(name === 'coercion' && router === apollo ? 3 : 1)
  }
})
