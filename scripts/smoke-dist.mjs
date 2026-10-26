/** Smoke test for the built dist/ bundles, covering the es5 downlevelling and cross-bundle behaviour jest cannot see. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { checkPackedHttp } from './packed-http.mjs'

import '../dist/endpoint.mjs'
import {
  generateTypescriptClientFromSDL as generateFromEsm,
  GraphQLClientError as GraphQLClientErrorFromEsm,
  isSettled as isSettledFromEsm,
  MissingSourcesError as MissingSourcesErrorFromEsm,
  resubscribe as resubscribeFromEsm,
} from '../dist/index.mjs'

const requireFromScript = createRequire(import.meta.url)

const cjsIndexBundle = requireFromScript('../dist/index.js')
const cjsEndpointBundle = requireFromScript('../dist/endpoint.js')
const axios = requireFromScript('axios')

const {
  generateTypescriptClientFromSDL: generateFromCjs,
  GraphQLClientError: GraphQLClientErrorFromCjs,
  MissingSourcesError: MissingSourcesErrorFromCjs,
} = cjsIndexBundle

const PUBLISHED_SPECIFIER = '@avantstay/graphql-ts-client'
const SDL = 'type Query { a: String }'

let failures = 0

/** Runs one check, recording a failure instead of throwing so the remaining checks still run. */
async function runCheck(description, check) {
  try {
    await check()
  } catch (error) {
    failures += 1
    console.error(`dist smoke FAILED: ${description}`)
    console.error(`  ${error?.message ?? error}`)
  }
}

function assertGeneratedOutput(moduleSystem, output) {
  assert.equal(typeof output.typings, 'string', `${moduleSystem}: typings should be a string`)
  assert.ok(output.typings.length > 0, `${moduleSystem}: typings should not be empty`)
  assert.ok(
    output.typings.includes(PUBLISHED_SPECIFIER),
    `${moduleSystem}: typings should import from ${PUBLISHED_SPECIFIER}, got:\n${output.typings.slice(0, 400)}`
  )
}

/** The one endpoint-creator fixture every endpoint check builds from, mirroring `src/testSupport/endpointFixture.ts`. */
const buildEndpointFromCjsBundle = cjsEndpointBundle.getApiEndpointCreator({
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
  formatGraphQL: query => query,
})

const PARTIAL_BODY = { data: { a: { b: null } }, errors: [{ message: 'x', path: ['a', 'b'] }] }
const NULL_ROOT_BODY = { data: { a: null }, errors: [{ message: 'x', path: ['a'] }] }
const SUCCESS_BODY = { data: { a: { b: 1 } } }

/** Wraps a check so it runs against `responseBody`, stubbing axios.post and never making a real request. */
function withStubbedPost(responseBody, check) {
  return async () => {
    axios.post = async () => ({ status: 200, headers: {}, data: responseBody })
    await check()
  }
}

function esmEntryGeneratesAClient() {
  assertGeneratedOutput('ESM', generateFromEsm(SDL, { endpoint: 'https://x', skipCache: true }))
}

function cjsEntryGeneratesAClient() {
  assertGeneratedOutput('CJS', generateFromCjs(SDL, { endpoint: 'https://x', skipCache: true }))
}

function cjsErrorsAreInstanceofEsmClasses() {
  const clientErrorFromCjs = new GraphQLClientErrorFromCjs({ errors: [{ message: 'x' }] })
  const sourcesErrorFromCjs = new MissingSourcesErrorFromCjs()
  assert.ok(clientErrorFromCjs instanceof GraphQLClientErrorFromEsm, 'CJS GraphQLClientError vs ESM class')
  assert.ok(sourcesErrorFromCjs instanceof MissingSourcesErrorFromEsm, 'CJS MissingSourcesError vs ESM class')
}

function esmErrorsAreInstanceofCjsClasses() {
  const clientErrorFromEsm = new GraphQLClientErrorFromEsm({ errors: [{ message: 'x' }] })
  const sourcesErrorFromEsm = new MissingSourcesErrorFromEsm()
  assert.ok(clientErrorFromEsm instanceof GraphQLClientErrorFromCjs, 'ESM GraphQLClientError vs CJS class')
  assert.ok(sourcesErrorFromEsm instanceof MissingSourcesErrorFromCjs, 'ESM MissingSourcesError vs CJS class')
}

function errorClassesStayDistinguishable() {
  assert.equal(new MissingSourcesErrorFromCjs() instanceof GraphQLClientErrorFromEsm, false)
  assert.equal(new GraphQLClientErrorFromCjs({ errors: [] }) instanceof MissingSourcesErrorFromEsm, false)
  assert.equal(new Error('plain') instanceof GraphQLClientErrorFromEsm, false)
}

async function rawReportsOutcomePartial() {
  const rawResult = await buildEndpointFromCjsBundle('query', 'a').raw({ b: true })
  assert.equal(rawResult.outcome, 'partial', `expected partial, got ${rawResult.outcome}/${rawResult.reason}`)
  assert.deepEqual(rawResult.failedPaths, ['b'])
  assert.equal(rawResult.data.b, null, 'raw() must leave the server payload untouched')
  assert.equal(rawResult.status, 200)
}

async function settleIsPartialAndCarriesTheBrand() {
  const settledResult = await buildEndpointFromCjsBundle('query', 'a').settle({ b: true })
  assert.equal(settledResult.outcome, 'partial', `expected partial, got ${settledResult.outcome}/${settledResult.reason}`)
  assert.ok(isSettledFromEsm(settledResult), 'isSettled() from the index bundle must recognise the endpoint bundle result')
  assert.deepEqual(settledResult.failedPaths, ['b'])
  assert.equal(settledResult.data.b, undefined, 'settle() blanks the failed path')
  assert.equal(settledResult.status, 200, 'settle() exposes the HTTP status as `status`')
  assert.equal(settledResult.errors[0].extensions, undefined, 'this server sent no extensions')
}

async function nullRootFieldIsANoDataFailure() {
  const rawResult = await buildEndpointFromCjsBundle('query', 'a').raw({ a: true })
  assert.equal(rawResult.outcome, 'failure')
  assert.equal(rawResult.reason, 'no-data')
}

async function mutationWithoutSourcesThrowsMissingSourcesError() {
  await assert.rejects(
    () => buildEndpointFromCjsBundle('mutation', 'a').settle({ a: true }),
    error => error instanceof MissingSourcesErrorFromEsm
  )
  await assert.rejects(
    () => buildEndpointFromCjsBundle('mutation', 'a').settle({ __settledSources: [], a: true }),
    error => error instanceof MissingSourcesErrorFromEsm
  )
}

async function mutationWithNoneSourcesSendsAndSucceeds() {
  const settledResult = await buildEndpointFromCjsBundle('mutation', 'a').settle({ __settledSources: 'none', b: true })
  assert.equal(settledResult.outcome, 'success', `expected success, got ${settledResult.outcome}/${settledResult.reason}`)
  assert.deepEqual(settledResult.data, { b: 1 })
}

/** A subscription that opens, delivers one value and completes, for checking the bundled resubscribe(). */
function oneShotSubscription(value) {
  return {
    [Symbol.asyncIterator]: () => {
      throw new Error('not iterated in the smoke test')
    },
    subscribe: observer => {
      observer.open?.()
      observer.next?.(value)
      observer.complete?.()
      return () => undefined
    },
    close: () => undefined,
  }
}

async function resubscribeReconnectsOnCompletion(resubscribe) {
  let opened = 0
  const values = []
  await new Promise((resolve, reject) =>
    resubscribe(() => oneShotSubscription(++opened), { initialDelayMs: 1, maxRetries: 2 }).subscribe({
      next: value => values.push(value),
      error: reject,
      complete: resolve,
    })
  )
  assert.deepEqual(values, [1, 2, 3])
}

/** Exercise generated consumers of the packed package, using only its public export map. */
async function packedGeneratedClients() {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url))
  const cacheRoot = path.join(repoRoot, '.cache')
  fs.mkdirSync(cacheRoot, { recursive: true })
  const root = fs.mkdtempSync(path.join(cacheRoot, 'packed-smoke-'))
  try {
    const packOutput = JSON.parse(
      execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
    )
    const packed = Array.isArray(packOutput) ? packOutput[0] : packOutput[PUBLISHED_SPECIFIER]
    const packageRoot = path.join(root, 'node_modules', '@avantstay', 'graphql-ts-client')
    fs.mkdirSync(packageRoot, { recursive: true })
    execFileSync('tar', ['-xzf', path.join(root, packed.filename), '--strip-components=1', '-C', packageRoot])
    const consumerRequire = createRequire(path.join(root, 'consumer.js'))
    const packedCjs = consumerRequire(PUBLISHED_SPECIFIER)
    const output = packedCjs.generateTypescriptClientFromSDL(
      'type Query { a(id: String): String } type Mutation { updateA(id: String): String }',
      {
        endpoint: 'https://packed.invalid/graphql',
        clientName: 'smokeApi',
        output: path.join(root, 'client.ts'),
        skipCache: true,
      }
    )
    assertGeneratedOutput('packed', output)
    const cjs = consumerRequire('./client.js')
    const esm = await import(pathToFileURL(path.join(root, 'client.mjs')).href)
    for (const clientModule of [cjs, esm]) {
      assert.equal(clientModule.default, clientModule.smokeApi)
      assert.equal(typeof clientModule.createSmokeApi, 'function')
      const requests = []
      const client = clientModule.createSmokeApi({
        transport: async request => {
          requests.push(request)
          return { status: 200, headers: { 'x-smoke': 'ok' }, data: { data: { a: 'packed' } } }
        },
      })
      client.setHeader('X-Client', 'packed')
      assert.equal(await client.queries.a({ __retry: false }), 'packed')
      assert.deepEqual(requests, [
        {
          url: 'https://packed.invalid/graphql',
          body: { query: 'query a { a  }', variables: {}, operationName: 'a' },
          headers: { 'Content-Type': 'application/json', 'X-Client': 'packed' },
          params: { _q: 'a' },
        },
      ])
    }
    // This runs before CHECKS installs any Axios stubs.
    await checkPackedHttp(cjs, esm)
    const probePath = path.join(root, 'probe.ts')
    fs.writeFileSync(
      probePath,
      `
      import { createSmokeApi, smokeApi } from './client'
      import type { OperationTransport, OperationTransportRequest, OperationTransportResponse, GeneratedClientOptions } from '${PUBLISHED_SPECIFIER}'
      import { getApiEndpointCreator } from '${PUBLISHED_SPECIFIER}/endpoint'
      const transport: OperationTransport = async (request: OperationTransportRequest): Promise<OperationTransportResponse> => {
        const query: string = request.body.query
        const url: string = request.url
        const header: string = request.headers['X-Client']
        const retry: number | undefined = request.params._retrial
        const serialized: string = JSON.stringify(request.body)
        const id = request.body.variables.id
        // @ts-expect-error opaque variable values must be narrowed before string operations
        id.toUpperCase()
        if (typeof id === 'string') {
          const upper: string = id.toUpperCase()
          void upper
        }
        // @ts-expect-error serialized variables are transport input, not writable adapter state
        request.body.variables.id = 'changed'
        void [query, url, header, retry, serialized]
        return { status: 200, headers: {}, data: { data: { a: 'typed' } } }
      }
      const options: GeneratedClientOptions = { url: 'https://runtime.invalid/graphql', transport }
      const client: typeof smokeApi = createSmokeApi(options)
      const result: Promise<string> = client.queries.a()
      void [result, getApiEndpointCreator]
      // @ts-expect-error a transport must return an HTTP status number
      createSmokeApi({ transport: async () => ({ status: 'wrong', headers: {} }) })
      // @ts-expect-error a runtime URL must be a string
      createSmokeApi({ url: 123 })
    `
    )
    const program = ts.createProgram([probePath], {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2020,
      moduleResolution: ts.ModuleResolutionKind.Node16,
      module: ts.ModuleKind.Node16,
      esModuleInterop: true,
      skipLibCheck: true,
    })
    const diagnostics = ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    assert.deepEqual(diagnostics, [], 'packed public declarations must type-check')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

/** Every check the smoke test runs, in order, as `[description, check]`. */
const CHECKS = [
  ['packed CJS/ESM generated factories and public declarations', packedGeneratedClients],
  ['ESM entry generates a client (guards the prettier default-import fix)', esmEntryGeneratesAClient],
  ['CJS entry generates a client', cjsEntryGeneratesAClient],
  ['CJS-constructed errors are instanceof the ESM classes', cjsErrorsAreInstanceofEsmClasses],
  ['ESM-constructed errors are instanceof the CJS classes', esmErrorsAreInstanceofCjsClasses],
  ['the two error classes stay distinguishable from each other and from a plain Error', errorClassesStayDistinguishable],
  ['raw() on a partial response reports outcome partial', withStubbedPost(PARTIAL_BODY, rawReportsOutcomePartial)],
  [
    'settle() on a partial response is partial and carries the settled brand',
    withStubbedPost(PARTIAL_BODY, settleIsPartialAndCarriesTheBrand),
  ],
  ['a null root field is classified as a no-data failure', withStubbedPost(NULL_ROOT_BODY, nullRootFieldIsANoDataFailure)],
  [
    'settle() on a mutation without __settledSources throws a recognisable MissingSourcesError',
    withStubbedPost(NULL_ROOT_BODY, mutationWithoutSourcesThrowsMissingSourcesError),
  ],
  [
    "settle() on a mutation with __settledSources: 'none' sends and succeeds",
    withStubbedPost(SUCCESS_BODY, mutationWithNoneSourcesSendsAndSucceeds),
  ],
  [
    'resubscribe() from the CJS entry reconnects on completion',
    () => resubscribeReconnectsOnCompletion(cjsIndexBundle.resubscribe),
  ],
  ['resubscribe() from the ESM entry reconnects on completion', () => resubscribeReconnectsOnCompletion(resubscribeFromEsm)],
]

async function main() {
  delete process.env.GQL_CLIENT_DIST_PATH

  for (const [description, check] of CHECKS) {
    await runCheck(description, check)
  }

  if (failures > 0) {
    console.error(`dist smoke: ${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('dist smoke: ok')
}

main().catch(error => {
  console.error('dist smoke FAILED: unexpected error')
  console.error(error)
  process.exit(1)
})
