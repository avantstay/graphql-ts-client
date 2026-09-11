import cloneDeep from 'lodash/cloneDeep.js'
import fromEntries from 'lodash/fromPairs.js'
import entries from 'lodash/toPairs.js'

const VAR_PREFIX = '@@VAR@@'
const VAR_PREFIX_LENGTH = VAR_PREFIX.length

type Variable = { type: any; value: any }

/** One `__args` entry to hoist, carrying the `__args` object the final variable reference is written back into. */
type VariableOccurrence = Variable & { argName: string; args: Record<string, unknown> }

/** Renders a JSON selection into a GraphQL document, hoisting every `__args` value into an operation variable. */
export function jsonToGraphQLQuery({
  kind,
  queryName,
  alias,
  jsonQuery = {},
  typesTree,
}: {
  kind: 'query' | 'mutation'
  queryName: string
  alias?: string
  jsonQuery: any
  typesTree: any
}) {
  const newJsonQuery = cloneDeep(jsonQuery)

  const occurrences = extractVariables({
    jsonQuery: { [queryName]: newJsonQuery },
    parentType: kind === 'query' ? typesTree.Query : typesTree.Mutation,
  })

  const variableItems = nameVariables(occurrences)

  const variablesQuery = Object.keys(variableItems).length
    ? `(${entries(variableItems)
        .map(([variableName, { type }]: any) => `$${variableName}: ${type}`)
        .join(', ')})`
    : ''

  const query = `${kind} ${alias || queryName}${variablesQuery} { ${alias ? `${alias}:` : ''}${queryName}${toGraphql(
    newJsonQuery
  )} }`
  const variables = fromEntries(entries(variableItems).map(([variableName, variable]: any) => [variableName, variable.value]))

  return {
    query,
    variables,
  }
}

/** Names every occurrence, suffixing `_0`, `_1`… when one argument name repeats, and points its `__args` entry at it. */
function nameVariables(occurrences: VariableOccurrence[]): Record<string, Variable> {
  const groupsByArgName = new Map<string, VariableOccurrence[]>()
  occurrences.forEach(occurrence => {
    const group = groupsByArgName.get(occurrence.argName)
    if (group) group.push(occurrence)
    else groupsByArgName.set(occurrence.argName, [occurrence])
  })

  const variableItems: Record<string, Variable> = {}
  groupsByArgName.forEach(group =>
    group.forEach((occurrence, index) => {
      const name = `${occurrence.argName}${group.length > 1 ? `_${index}` : ''}`
      occurrence.args[occurrence.argName] = `${VAR_PREFIX}$${name}`
      variableItems[name] = { type: occurrence.type, value: occurrence.value }
    })
  )

  return variableItems
}

/** The resolution-tree node for `fieldName`, whether it hangs off the parent directly or off its `__fields`. */
function childType(parentType: any, fieldName: string) {
  if (parentType.hasOwnProperty(fieldName)) return parentType[fieldName]
  return parentType.__fields ? parentType.__fields[fieldName] : undefined
}

/** Lists every `__args` value in the selection that must be hoisted into an operation variable, in document order. */
function extractVariables({ jsonQuery, parentType }: { jsonQuery: any; parentType: any }): VariableOccurrence[] {
  if (!parentType) return []

  const occurrences: VariableOccurrence[] = []

  if (jsonQuery.__args) {
    Object.keys(jsonQuery.__args).forEach(argName => {
      const value = jsonQuery.__args[argName]
      if (typeof value === 'string' && value.startsWith(VAR_PREFIX)) return
      if (value === undefined) return

      occurrences.push({ argName, args: jsonQuery.__args, type: parentType.__args[argName], value })
    })
  }

  Object.keys(jsonQuery)
    .filter(fieldName => fieldName !== '__args' && typeof jsonQuery[fieldName] === 'object')
    .forEach(fieldName =>
      occurrences.push(...extractVariables({ jsonQuery: jsonQuery[fieldName], parentType: childType(parentType, fieldName) }))
    )

  return occurrences
}

function toGraphql(jsonQuery: any): string {
  const fields = entries(jsonQuery)
    .filter(([fieldName, fieldValue]) => fieldName !== '__args' && fieldValue !== false && fieldValue !== undefined)
    .map(([fieldName, fieldValue]) => (typeof fieldValue === 'object' ? `${fieldName}${toGraphql(fieldValue)}` : fieldName))
    .join(' ')

  const validArgs = jsonQuery.__args ? entries(jsonQuery.__args).filter(([, argValue]) => argValue !== undefined) : []
  const argsQuery = validArgs.length
    ? `(${validArgs.map(([argName, argValue]) => `${argName}:${(argValue as string).slice(VAR_PREFIX_LENGTH)}`).join(',')})`
    : ''

  return `${argsQuery} ${fields ? `{ ${fields} }` : ''}`
}
