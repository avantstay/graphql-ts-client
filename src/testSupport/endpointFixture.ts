import { getApiEndpointCreator } from '../endpoint'

/** The endpoint creator every endpoint test starts from; each test passes only the config it varies. */
export function createTestEndpointCreator(overrides: Partial<Parameters<typeof getApiEndpointCreator>[0]> = {}) {
  return getApiEndpointCreator({
    getClient: () => ({
      url: 'https://example.invalid/graphql',
      headers: {},
      retryConfig: { max: 0, before: () => undefined },
    }),
    requestListeners: [],
    responseListeners: [],
    typesTree: {},
    maxAge: 0,
    verbose: false,
    formatGraphQL: (query: string) => query,
    ...overrides,
  })
}
