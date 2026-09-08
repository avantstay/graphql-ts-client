import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import ts from 'typescript'
import { generateTypescriptClientFromSDL } from './generateTypescriptClient'

const sdl = `
  type Query { user(id: ID!): User! }
  type Mutation { updateUser(input: String!): User }
  type User { id: ID!, name: String }
`

const createdDirectories: string[] = []

afterAll(() => {
  createdDirectories.forEach(dir => fs.rmSync(dir, { recursive: true, force: true }))
})

function diagnosticsFor(sample: string): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gql-typing-'))
  createdDirectories.push(dir)
  const output = generateTypescriptClientFromSDL(sdl, { endpoint: 'https://x', clientName: 'sample', skipCache: true })
  // The generator's `prettier.format` call doesn't load this repo's .prettierrc (no singleQuote option passed),
  // so the emitted typings use prettier's default double-quoted import specifiers (e.g. `from "."`), not
  // single-quoted ones. Match either quote style when rewriting the module specifier for the probe.
  // The specifier itself depends on GQL_CLIENT_DIST_PATH: `.` when the suite runs with it set, the published
  // `@avantstay/graphql-ts-client` when it is not. Rewrite both — an unrewritten specifier does not resolve,
  // and because sample.d.ts is a declaration file, `skipLibCheck` would swallow that silently, leaving every
  // imported type `any` and every probe vacuously diagnostic-free.
  const clientSpecifier = /from ["'](?:\.|@avantstay\/graphql-ts-client)["']/g
  fs.writeFileSync(
    path.join(dir, 'sample.d.ts'),
    output.typings.replace(clientSpecifier, `from '${path.resolve(__dirname, 'index')}'`)
  )
  const samplePath = path.join(dir, 'probe.ts')
  fs.writeFileSync(samplePath, `import { sample } from './sample'\n${sample}`)
  // resolveJsonModule matches this repo's own tsconfig.json: pointing the probe at src/index.ts pulls in
  // generateTypescriptClient.ts, which imports ../package.json directly.
  const program = ts.createProgram([samplePath], {
    strict: true,
    noEmit: true,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
    skipLibCheck: true,
    resolveJsonModule: true,
  })
  return ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
}

describe('generated typings', () => {
  it('accepts settle() on a query without sources and narrows data by outcome', () => {
    expect(
      diagnosticsFor(`
        async function probe() {
          const result = await sample.queries.user.settle({ __args: { id: 'user_1' }, id: true })
          if (result.outcome === 'failure') { const nothing: null = result.data; return nothing }
          const id: string = result.data.id
          return id
        }`)
    ).toEqual([])
  })

  it('rejects settle() on a mutation without __sources', () => {
    expect(diagnosticsFor(`sample.mutations.updateUser.settle({ __args: { input: 'x' }, id: true })`).join('\n')).toMatch(
      /__sources/
    )
  })

  it('keeps raw() additive: data typed as before, outcome available', () => {
    expect(
      diagnosticsFor(`
        async function probe() {
          const result = await sample.queries.user.raw({ __args: { id: 'user_1' }, id: true })
          const id: string = result.data.id
          const outcome: 'success' | 'partial' | 'failure' = result.outcome
          return [id, outcome]
        }`)
    ).toEqual([])
  })
})
