import cloneDeep from 'lodash/cloneDeep.js'
import fromEntries from 'lodash/fromPairs.js'
import entries from 'lodash/toPairs.js'

const VAR_PREFIX = '@@VAR@@'
const VAR_PREFIX_LENGTH = VAR_PREFIX.length

type ExtractedVariables = Record<string, (Variable & { name: string; update: (index?: number) => string })[]>
type Variable = { type: any; value: any }

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
  const variablesData = {} as ExtractedVariables
  const newJsonQuery = cloneDeep(jsonQuery)

  extractVariables({
    jsonQuery: { [queryName]: newJsonQuery },
    variables: variablesData,
    parentType: kind === 'query' ? typesTree.Query : typesTree.Mutation,
  })

  const variableItems = Object.values(variablesData).reduce((variablesObj, variables) => {
    variables.forEach((variable, index) => {
      const name = variable.update(variables.length > 1 ? index : undefined)
      variablesObj[name] = { type: variable.type, value: variable.value }
    })

    return variablesObj
  }, {} as Record<string, Variable>)

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

function extractVariables({
  jsonQuery,
  variables,
  parentType,
}: {
  jsonQuery: any
  variables: ExtractedVariables
  parentType: any
}) {
  if (!parentType) return

  if (jsonQuery.__args) {
    Object.keys(jsonQuery.__args).forEach(argName => {
      if (typeof jsonQuery.__args[argName] === 'string' && jsonQuery.__args[argName].startsWith(VAR_PREFIX)) return
      if (jsonQuery.__args[argName] === undefined) return

      const variableName = argName

      if (!variables[variableName]) {
        variables[variableName] = []
      }

      variables[variableName].push({
        name: variableName,
        type: parentType.__args[argName],
        value: jsonQuery.__args[argName],
        update: (index?: number) => {
          const name = `${variableName}${index !== undefined ? `_${index}` : ''}`
          jsonQuery.__args[argName] = `${VAR_PREFIX}$${name}`

          return name
        },
      })

      jsonQuery.__args[argName] = VAR_PREFIX
    })
  }

  Object.keys(jsonQuery)
    .filter(fieldName => fieldName !== '__args' && typeof jsonQuery[fieldName] === 'object')
    .forEach(fieldName =>
      extractVariables({
        jsonQuery: jsonQuery[fieldName],
        variables,
        parentType: parentType.hasOwnProperty(fieldName)
          ? parentType[fieldName]
          : parentType.__fields
          ? parentType.__fields[fieldName]
          : undefined,
      })
    )
}

function toGraphql(jsonQuery: any) {
  const fields = entries(jsonQuery)
    .filter(([fieldName, fieldValue]) => fieldName !== '__args' && fieldValue !== false && fieldValue !== undefined)
    .map(([fieldName, fieldValue]) => (typeof fieldValue === 'object' ? `${fieldName}${toGraphql(fieldValue)}` : fieldName))
    .join(' ') as any

  const validArgs = jsonQuery.__args ? entries(jsonQuery.__args).filter(([, argValue]) => argValue !== undefined) : []
  const argsQuery = validArgs.length
    ? `(${validArgs.map(([argName, argValue]) => `${argName}:${(argValue as string).slice(VAR_PREFIX_LENGTH)}`).join(',')})`
    : ''

  return `${argsQuery} ${fields ? `{ ${fields} }` : ''}`
}
