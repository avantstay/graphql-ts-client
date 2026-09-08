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
  // Rewrite both possible specifiers; an unresolved one is swallowed by skipLibCheck and makes every probe vacuous.
  const clientSpecifier = /from ["'](?:\.|@avantstay\/graphql-ts-client)["']/g
  fs.writeFileSync(
    path.join(dir, 'sample.d.ts'),
    output.typings.replace(clientSpecifier, `from '${path.resolve(__dirname, 'index')}'`)
  )
  const samplePath = path.join(dir, 'probe.ts')
  fs.writeFileSync(samplePath, `import { sample } from './sample'\n${sample}`)
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

  it('rejects settle() on a mutation without __settledSources', () => {
    expect(diagnosticsFor(`sample.mutations.updateUser.settle({ __args: { input: 'x' }, id: true })`).join('\n')).toMatch(
      /__settledSources/
    )
  })

  it("accepts settle() on a mutation with __settledSources: 'none'", () => {
    expect(
      diagnosticsFor(`sample.mutations.updateUser.settle({ __settledSources: 'none', __args: { input: 'x' }, id: true })`)
    ).toEqual([])
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
