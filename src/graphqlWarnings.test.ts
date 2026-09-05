import { graphqlRequest } from './graphqlRequest'
import { GraphQLClientError } from './types'

const legacyWarnings = [{ message: 'Legacy warning' }]
const extensionWarnings = [{ message: 'Extension warning' }]
const data = { booking: null }
const errors = [{ message: 'Cannot modify booking', extensions: { code: 'SERVICE_DEFINED', requestId: 'request-1' } }]

const requestOptions = {
  shouldRetry: false,
  queryName: 'booking',
  query: 'mutation booking { booking }',
  variables: {},
  client: { url: 'https://example.invalid/graphql', headers: {}, retryConfig: { max: 0, before: () => undefined } },
}

describe('GraphQL warning envelopes', () => {
  it.each([
    { name: 'legacy warnings', body: { warnings: legacyWarnings }, warnings: legacyWarnings },
    { name: 'extension warnings', body: { extensions: { warnings: extensionWarnings } }, warnings: extensionWarnings },
    {
      name: 'extensions take precedence without duplicating warnings',
      body: { warnings: legacyWarnings, extensions: { warnings: extensionWarnings } },
      warnings: extensionWarnings,
    },
    {
      name: 'empty extension warnings take precedence',
      body: { warnings: legacyWarnings, extensions: { warnings: [] } },
      warnings: [],
    },
    {
      name: 'null extension warnings fall back',
      body: { warnings: legacyWarnings, extensions: { warnings: null } },
      warnings: legacyWarnings,
    },
    {
      name: 'unrelated extensions fall back',
      body: { warnings: legacyWarnings, extensions: { tracing: {} } },
      warnings: legacyWarnings,
    },
    { name: 'null extensions fall back', body: { warnings: legacyWarnings, extensions: null }, warnings: legacyWarnings },
    { name: 'absent warnings stay absent', body: {}, warnings: undefined },
  ])('$name', async ({ body, warnings }) => {
    const responseData = { data, errors, ...body }
    const response = await graphqlRequest({
      ...requestOptions,
      failureMode: 'silent',
      axios: { post: jest.fn().mockResolvedValue({ data: responseData, status: 200, headers: {} }) } as any,
    })

    expect(response.warnings).toEqual(warnings)
    expect(response.data).toBe(data)
    expect(response.errors).toBe(errors)
    expect(response.status).toBe(200)
  })

  it('retains extension warnings on a thrown GraphQLClientError', async () => {
    const response = graphqlRequest({
      ...requestOptions,
      failureMode: 'loud',
      axios: {
        post: jest.fn().mockResolvedValue({ data: { data, errors, extensions: { warnings: extensionWarnings } }, status: 200 }),
      } as any,
    })

    await expect(response).rejects.toBeInstanceOf(GraphQLClientError)
    await expect(response).rejects.toMatchObject({ response: { data, errors, warnings: extensionWarnings } })
  })

  it('does not turn warning-only responses into errors or retries', async () => {
    const post = jest.fn().mockResolvedValue({ data: { data, extensions: { warnings: extensionWarnings } }, status: 200 })
    const response = await graphqlRequest({ ...requestOptions, failureMode: 'loud', axios: { post } as any })

    expect(response.warnings).toEqual(extensionWarnings)
    expect(response.errors).toBeUndefined()
    expect(post).toHaveBeenCalledTimes(1)
  })
})
