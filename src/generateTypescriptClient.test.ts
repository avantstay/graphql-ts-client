import { ApolloServer } from 'apollo-server'
import * as path from 'path'
import { generateTypescriptClient, generateTypescriptClientFromSDL } from './generateTypescriptClient'
import { startServer } from './testServer'
import { RequestListenerInfo, ResponseListenerInfo } from './types'

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

    expect(result.constructor.name).toContain('GraphQLClientError')
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

  it('request listener is called before the request', async () => {
    let requestData: RequestListenerInfo | undefined
    client.addRequestListener((data: any) => (requestData = data))

    await client.queries.booksWithoutParams({ title: true })

    expect(requestData?.queryName).toBe('booksWithoutParams')
    expect(requestData?.query).toBeDefined()
    expect(requestData?.variables).toBeDefined()
  })

  it('header set in request listener is sent with the request', async () => {
    const axios = require('axios')
    const axiosSpy = jest.spyOn(axios, 'post')

    client.addRequestListener(async () => {
      const token = await Promise.resolve('my-fresh-token')
      client.setHeader('Authorization', `Bearer ${token}`)
    })

    await client.queries.booksWithoutParams({ title: true })

    expect(axiosSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer my-fresh-token',
        }),
      })
    )

    axiosSpy.mockRestore()
    client.setHeader('Authorization', undefined)
  })

  it('request listener is called even for failing operations', async () => {
    let requestData: RequestListenerInfo | undefined
    client.addRequestListener((data: any) => (requestData = data))

    try {
      await client.queries.failingQuery({ __args: { id: 'hello' } })
    } catch {}

    expect(requestData?.queryName).toBe('failingQuery')
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

  it('removeRequestListener removes a previously added request listener', async () => {
    let callCount = 0
    const listener = () => { callCount++ }

    client.addRequestListener(listener)
    await client.queries.booksWithoutParams({ title: true })
    expect(callCount).toBe(1)

    client.removeRequestListener(listener)
    await client.queries.booksWithoutParams({ title: true })
    expect(callCount).toBe(1)
  })

  it('removeResponseListener removes a previously added response listener', async () => {
    let callCount = 0
    const listener = () => { callCount++ }

    client.addResponseListener(listener)
    await client.queries.booksWithoutParams({ title: true })
    expect(callCount).toBe(1)

    client.removeResponseListener(listener)
    await client.queries.booksWithoutParams({ title: true })
    expect(callCount).toBe(1)
  })

  it('addRequestListener returns an unsubscribe function', async () => {
    let callCount = 0
    const unsubscribe = client.addRequestListener(() => { callCount++ })

    await client.queries.booksWithoutParams({ title: true })
    expect(callCount).toBe(1)

    unsubscribe()
    await client.queries.booksWithoutParams({ title: true })
    expect(callCount).toBe(1)
  })

  it('addResponseListener returns an unsubscribe function', async () => {
    let callCount = 0
    const unsubscribe = client.addResponseListener(() => { callCount++ })

    await client.queries.booksWithoutParams({ title: true })
    expect(callCount).toBe(1)

    unsubscribe()
    await client.queries.booksWithoutParams({ title: true })
    expect(callCount).toBe(1)
  })

  it('should generate proper code from SDL', () => {
    const sdlString = `
  type Query {
    hello: String
  }
`
    expect(generateTypescriptClientFromSDL(sdlString, { endpoint: 'https://sample.endpoint.com/graphl' })).toMatchSnapshot()
  })
})
