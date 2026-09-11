/** Smoke test for the built dist/ bundles, covering the es5 downlevelling and cross-bundle behaviour jest cannot see. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import '../dist/endpoint.mjs'
import {
  generateTypescriptClientFromSDL as generateFromEsm,
  GraphQLClientError as GraphQLClientErrorFromEsm,
  isSettled as isSettledFromEsm,
  MissingSourcesError as MissingSourcesErrorFromEsm,
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

/** Every check the smoke test runs, in order, as `[description, check]`. */
const CHECKS = [
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
