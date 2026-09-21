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

/** The shared prelude every exact-type probe compiles against: an `Equal` helper plus a schema-shaped fixture. */
const TYPE_PROBE_PRELUDE = `
  import { DeepReplace, JsonOutput, Projection } from '${path.resolve(__dirname, 'types')}'

  type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
  type Expect<T extends true> = T

  enum Status { active = 'ACTIVE', inactive = 'INACTIVE' }
  enum Colour { red = 'RED' }
  type IDate = string | Date
  type Profile = { bio?: string; avatar: string }
  type User = {
    id: string
    name?: string
    status?: Status
    profile?: Profile
    profiles?: Profile[]
    tags?: string[]
    createdAt?: IDate
  }
`

/** Compiles exact-type assertions against the package's own conditional types; `[]` means every one held. */
function typeProbeDiagnostics(assertions: string): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gql-typing-'))
  createdDirectories.push(dir)
  const samplePath = path.join(dir, 'probe.ts')
  fs.writeFileSync(samplePath, `${TYPE_PROBE_PRELUDE}\n${assertions}`)
  const program = ts.createProgram([samplePath], {
    strict: true,
    noEmit: true,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
    skipLibCheck: true,
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

describe('Projection', () => {
  it('resolves each selected field to exactly the projected type', () => {
    expect(
      typeProbeDiagnostics(`
        type PScalar = Expect<Equal<Projection<{ id: true }, User, Status>, { id: string }>>
        type PNullableScalar = Expect<Equal<Projection<{ name: true }, User, Status>, { name: string | undefined }>>
        type PEnum = Expect<Equal<Projection<{ status: true }, User, Status>, { status: Status | undefined }>>
        type PUnionE = Expect<Equal<Projection<{ status: true }, User, Status | Colour>, { status: Status | undefined }>>
        type PNullableObject = Expect<
          Equal<Projection<{ profile: { bio: true } }, User, Status>, { profile: { bio: string | undefined } | undefined }>
        >
        type PListOfObjects = Expect<
          Equal<Projection<{ profiles: { bio: true } }, User, Status>, { profiles: { bio: string | undefined }[] | undefined }>
        >
        type PListOfScalars = Expect<Equal<Projection<{ tags: true }, User, Status>, { tags: string[] | undefined }>>
        type PNested = Expect<
          Equal<
            Projection<{ id: true; profile: { bio: true; avatar: true } }, User, Status>,
            { id: string; profile: { bio: string | undefined; avatar: string } | undefined }
          >
        >
        type PTopLevelList = Expect<Equal<Projection<{ bio: true }, Profile[], Status>, { bio: string | undefined }[]>>
        type PLeafDefined = Expect<Equal<Projection<true, string, Status>, string>>
        type PLeafUndefined = Expect<Equal<Projection<undefined, string, Status>, string | undefined>>
        type PEnumLeaf = Expect<Equal<Projection<true, Status, Status>, Status>>
      `)
    ).toEqual([])
  })
})

describe('DeepReplace', () => {
  it('replaces exactly the required date-bearing leaves and leaves the ignored ones alone', () => {
    expect(
      typeProbeDiagnostics(`
        type JRequiredDate = Expect<Equal<DeepReplace<{ at: IDate }, Status, [string | Date, string]>, { at: string }>>
        type JOptionalDate = Expect<Equal<DeepReplace<{ at?: IDate }, Status, [string | Date, string]>, { at?: IDate }>>
        type JNested = Expect<
          Equal<
            DeepReplace<{ profile: { at: IDate; n: number } }, Status, [string | Date, string]>,
            { profile: { at: string; n: number } }
          >
        >
        type JIgnoreEnum = Expect<Equal<DeepReplace<{ status: Status }, Status, [string | Date, string]>, { status: Status }>>
        type JIgnoreUnion = Expect<
          Equal<
            DeepReplace<{ status: Status; colour: Colour }, Status | Colour, [string | Date, string]>,
            { status: Status; colour: Colour }
          >
        >
        type JListOfDates = Expect<Equal<DeepReplace<{ dates: IDate[] }, Status, [string | Date, string]>, { dates: string[] }>>
        type JNullableObject = Expect<
          Equal<DeepReplace<{ profile?: { at: IDate } }, Status, [string | Date, string]>, { profile?: { at: IDate } }>
        >
        type JUser = Expect<Equal<JsonOutput<User, Status>, DeepReplace<User, Status, [string | Date, string]>>>
      `)
    ).toEqual([])
  })
})
