import { ApolloServer } from 'apollo-server'
import * as path from 'path'
import { generateTypescriptClient, generateTypescriptClientFromSDL } from './generateTypescriptClient'
import { startServer } from './testServer'
import { GraphQLClientError, ResponseListenerInfo } from './types'

let testServer: { server: ApolloServer; url: string }
let client: any

describe('Generated Client', () => {
  beforeAll(async () => {
    testServer = await startServer()

    const clientName = 'myApiClient'

    const { js } = await generateTypescriptClient({
      clientName,
      endpoint: `${testServer.url}graphql`,
      // For the sake of checking the generated code, we'll
      // specify an output path
      output: path.resolve(__dirname, './__testClient.ts'),
      formatGraphQL: true,
      skipCache: true,
    })

    client = eval(`${js};${clientName}`)
  })

  afterAll(async () => await testServer.server.stop())

  it('should be able to pass custom headers to a query without args', async () => {
    const books = await client.queries.booksWithoutParams({
      __headers: { 'X-Custom-Header': 'Foo' },
      title: true,
      author: true,
    })

    expect(books).toHaveLength(2)
    expect(books[0]).toHaveProperty('title')
    expect(books[0]).toHaveProperty('author')
  })

  it('should be able to make queries with optional args, not passing args obj', async () => {
    // noinspection TypeScriptValidateJSTypes
    const books = await client.queries.booksWithOptionalParams({
      title: true,
      author: true,
    })

    expect(books).toHaveLength(2)
    expect(books[0]).toHaveProperty('title')
    expect(books[0]).toHaveProperty('author')
  })

  it('should be able to make queries with optional args, not passing args obj', async () => {
    // noinspection TypeScriptValidateJSTypes
    const books = await client.queries.booksWithOptionalParams({
      __alias: 'helloWorld',
      title: true,
      author: true,
    })

    expect(books).toHaveLength(2)
    expect(books[0]).toHaveProperty('title')
    expect(books[0]).toHaveProperty('author')
  })

  it('fail with broken queries', async () => {
    const result = await client.queries
      .failingQuery({
        __args: {
          id: 'hello',
        },
      })
      .then(
        () => 'success',
        (err: any) => err
      )

    expect(result).toBeInstanceOf(GraphQLClientError)
    expect(result.message).toBe('Failed lorem ipsum dolor')
  })

  it('does not fail with broken queries when using raw requests', async () => {
    const result = await client.queries.failingQuery.raw({
      __args: {
        id: 'hello',
      },
    })

    expect(result.status).toBe(200)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toBe('Failed lorem ipsum dolor')
  })

  it('failing operations throw errors', async () => {
    let failed = false

    try {
      await client.queries.failingQuery({
        __args: {
          id: 'hello',
        },
      })
    } catch (err) {
      failed = true
    }

    expect(failed).toBe(true)
  })

  it('failing operations throw errors', async () => {
    let responseData: ResponseListenerInfo | undefined
    client.addResponseListener((data: any) => (responseData = data))

    try {
      await client.queries.failingQuery({
        __args: {
          id: 'hello',
        },
      })
    } catch {}

    expect(responseData?.queryName).toBe('failingQuery')
    expect(responseData?.response.errors.length).toBeGreaterThan(0)
  })

  it('should generate proper code from SDL', ()=>{
    const sdlString = `
  type Query {
    hello: String
  }
`;
    expect(generateTypescriptClientFromSDL(sdlString, {endpoint: 'https://sample.endpoint.com/graphl'})).toMatchSnapshot()
  })
})
