/*
 * Smoke test for the BUILT package (dist/), not the sources.
 *
 * The unit suite runs through babel, which transpiles differently from the tsup/esbuild build: it does not
 * downlevel classes to es5, so it cannot see failures that only exist in the shipped bundles. The
 * `_classCallCheck` regression is the motivating example — a brand-only `Symbol.hasInstance` made
 * `new GraphQLClientError(...)` throw "Cannot call a class as a function" in dist while jest stayed green.
 *
 * It also covers the two other defects that only appear across the bundle boundary or through a real entry
 * point: `prettier.format is not a function` in the ESM entry, and `instanceof` failing between the
 * independent class copies that `tsup src/index.ts src/endpoint.ts` embeds in each bundle.
 *
 * Plain node asserts, no test framework, so it can run against a packed tarball as easily as against dist/.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { getApiEndpointCreator as getApiEndpointCreatorFromEsm } from '../dist/endpoint.mjs'
import {
  generateTypescriptClientFromSDL as generateFromEsm,
  GraphQLClientError as GraphQLClientErrorFromEsm,
  isSettled as isSettledFromEsm,
  MissingSourcesError as MissingSourcesErrorFromEsm,
} from '../dist/index.mjs'

const requireFromScript = createRequire(import.meta.url)

const cjsIndexBundle = requireFromScript('../dist/index.js')
const cjsEndpointBundle = requireFromScript('../dist/endpoint.js')
// Required by path rather than imported so this is provably the same module object the CJS bundles hold:
// stubbing `post` on it is what makes the endpoint checks below hermetic.
const axios = requireFromScript('axios')

const {
  generateTypescriptClientFromSDL: generateFromCjs,
  GraphQLClientError: GraphQLClientErrorFromCjs,
  MissingSourcesError: MissingSourcesErrorFromCjs,
} = cjsIndexBundle

const PUBLISHED_SPECIFIER = '@avantstay/graphql-ts-client'
const SDL = 'type Query { a: String }'

let failures = 0

function runCheck(description, check) {
  try {
    check()
    return true
  } catch (error) {
    failures += 1
    console.error(`dist smoke FAILED: ${description}`)
    console.error(`  ${error && error.message ? error.message : error}`)
    return false
  }
}

async function runAsyncCheck(description, check) {
  try {
    await check()
    return true
  } catch (error) {
    failures += 1
    console.error(`dist smoke FAILED: ${description}`)
    console.error(`  ${error && error.message ? error.message : error}`)
    return false
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

function buildEndpointFromCjsBundle(kind, queryName) {
  return cjsEndpointBundle.getApiEndpointCreator({
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
  })(kind, queryName)
}

function stubAxiosPost(responseBody) {
  axios.post = async () => ({ status: 200, headers: {}, data: responseBody })
}

async function main() {
  // The generator reads GQL_CLIENT_DIST_PATH at call time, so clearing it here is enough to make the
  // generated specifier deterministic no matter how the caller's environment is set up.
  delete process.env.GQL_CLIENT_DIST_PATH

  // (b) Both entry points of the generator produce a usable client.
  runCheck('ESM entry generates a client (guards the prettier default-import fix)', () => {
    assertGeneratedOutput('ESM', generateFromEsm(SDL, { endpoint: 'https://x', skipCache: true }))
  })
  runCheck('CJS entry generates a client', () => {
    assertGeneratedOutput('CJS', generateFromCjs(SDL, { endpoint: 'https://x', skipCache: true }))
  })

  // (c) Errors constructed by one bundle's class copy are recognised by the other's. Constructing them at
  // all is itself the _classCallCheck guard: a brand-only Symbol.hasInstance throws here.
  runCheck('CJS-constructed errors are instanceof the ESM classes', () => {
    const clientErrorFromCjs = new GraphQLClientErrorFromCjs({ errors: [{ message: 'x' }] })
    const sourcesErrorFromCjs = new MissingSourcesErrorFromCjs()
    assert.ok(clientErrorFromCjs instanceof GraphQLClientErrorFromEsm, 'CJS GraphQLClientError vs ESM class')
    assert.ok(sourcesErrorFromCjs instanceof MissingSourcesErrorFromEsm, 'CJS MissingSourcesError vs ESM class')
  })
  runCheck('ESM-constructed errors are instanceof the CJS classes', () => {
    const clientErrorFromEsm = new GraphQLClientErrorFromEsm({ errors: [{ message: 'x' }] })
    const sourcesErrorFromEsm = new MissingSourcesErrorFromEsm()
    assert.ok(clientErrorFromEsm instanceof GraphQLClientErrorFromCjs, 'ESM GraphQLClientError vs CJS class')
    assert.ok(sourcesErrorFromEsm instanceof MissingSourcesErrorFromCjs, 'ESM MissingSourcesError vs CJS class')
  })
  runCheck('the two error classes stay distinguishable from each other and from a plain Error', () => {
    assert.equal(new MissingSourcesErrorFromCjs() instanceof GraphQLClientErrorFromEsm, false)
    assert.equal(new GraphQLClientErrorFromCjs({ errors: [] }) instanceof MissingSourcesErrorFromEsm, false)
    assert.equal(new Error('plain') instanceof GraphQLClientErrorFromEsm, false)
  })
  runCheck('the ESM endpoint bundle exposes its endpoint creator', () => {
    assert.equal(typeof getApiEndpointCreatorFromEsm, 'function')
  })

  // (d) A real partial response, driven through the endpoint bundle. The root field must survive for the
  // response to be partial: a null root field is classified 'no-data' (asserted separately below), so the
  // failed path is nested one level under it.
  stubAxiosPost({ data: { a: { b: null } }, errors: [{ message: 'x', path: ['a', 'b'] }] })

  await runAsyncCheck('raw() on a partial response reports outcome partial', async () => {
    const rawResult = await buildEndpointFromCjsBundle('query', 'a').raw({ b: true })
    assert.equal(rawResult.outcome, 'partial', `expected partial, got ${rawResult.outcome}/${rawResult.reason}`)
    assert.deepEqual(rawResult.failedPaths, ['b'])
    assert.equal(rawResult.data.b, null, 'raw() must leave the server payload untouched')
  })

  await runAsyncCheck('settle() on a partial response is partial and carries the settled brand', async () => {
    const settledResult = await buildEndpointFromCjsBundle('query', 'a').settle({ b: true })
    assert.equal(settledResult.outcome, 'partial', `expected partial, got ${settledResult.outcome}/${settledResult.reason}`)
    assert.ok(isSettledFromEsm(settledResult), 'isSettled() from the index bundle must recognise the endpoint bundle result')
    assert.deepEqual(settledResult.failedPaths, ['b'])
    assert.equal(settledResult.data.b, undefined, 'settle() blanks the failed path')
  })

  // A null root field is a failure, not a partial: nothing usable came back for the request.
  stubAxiosPost({ data: { a: null }, errors: [{ message: 'x', path: ['a'] }] })

  await runAsyncCheck('a null root field is classified as a no-data failure', async () => {
    const rawResult = await buildEndpointFromCjsBundle('query', 'a').raw({ a: true })
    assert.equal(rawResult.outcome, 'failure')
    assert.equal(rawResult.reason, 'no-data')
  })

  await runAsyncCheck('settle() on a mutation without __sources throws a recognisable MissingSourcesError', async () => {
    await assert.rejects(
      () => buildEndpointFromCjsBundle('mutation', 'a').settle({ a: true }),
      error => error instanceof MissingSourcesErrorFromEsm
    )
  })

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
