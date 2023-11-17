import omit from 'lodash/omit'

const VAR_PREFIX = '@@VAR@@'
const VAR_PREFIX_LENGTH = VAR_PREFIX.length

const fromEntries: (arr: [string, any][]) => { [key: string]: any } = require('lodash/fromPairs')
const entries: (obj: { [key: string]: any }) => [string, any][] = require('lodash/toPairs')
const cloneDeep = require('lodash/cloneDeep')

type ExtractedVariables = Record<string, (Variable & { name: string })[]>
type Variable = { type: any; value: any }

export function jsonToGraphQLQuery({
  kind,
  queryName,
  jsonQuery = {},
  typesTree,
}: {
  kind: 'query' | 'mutation'
  queryName: string
  jsonQuery: any
  typesTree: any
}) {
  const variablesData = {} as ExtractedVariables
  const alias = jsonQuery.__alias
  const newJsonQuery = cloneDeep(omit(jsonQuery, ['__alias', '__headers']))

  extractVariables({
    jsonQuery: { [queryName]: newJsonQuery },
    variables: variablesData,
    parentType: kind === 'query' ? typesTree.Query : typesTree.Mutation,
  })

  const variableItems = Object.values(variablesData).reduce((variablesObj, variables) => {
    variables.forEach(variable => {
      variablesObj[variable.name] = { type: variable.type, value: variable.value }
    })

    return variablesObj
  }, {} as Record<string, Variable>)

  const variablesQuery = Object.keys(variableItems).length
    ? `(${entries(variableItems)
        .map(([queryName, { type }]: any) => `$${queryName}: ${type}`)
        .join(', ')})`
    : ''

  const query = `${kind} ${alias || queryName}${variablesQuery} { ${alias ? `${alias}:` : ''}${queryName}${toGraphql(
    newJsonQuery
  )} }`
  const variables = fromEntries(entries(variableItems).map(([k, v]: any) => [k, v.value]))

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
    Object.keys(jsonQuery.__args).forEach(k => {
      if (typeof jsonQuery.__args[k] === 'string' && jsonQuery.__args[k].startsWith(VAR_PREFIX)) return
      if (jsonQuery.__args[k] === undefined) return

      const baseVariableName = k

      if (!variables[baseVariableName]) {
        variables[baseVariableName] = []
      }

      const variableName = `${k}_${variables[baseVariableName].length}`
      variables[baseVariableName].push({
        name: variableName,
        type: parentType.__args[k],
        value: jsonQuery.__args[k],
      })

      jsonQuery.__args[k] = `${VAR_PREFIX}$${variableName}`
    })
  }

  Object.keys(jsonQuery)
    .filter(k => k !== '__args' && typeof jsonQuery[k] === 'object')
    .forEach(k =>
      extractVariables({
        jsonQuery: jsonQuery[k],
        variables,
        parentType: parentType.hasOwnProperty(k) ? parentType[k] : parentType.__fields ? parentType.__fields[k] : undefined,
      })
    )
}

function toGraphql(jsonQuery: any) {
  const fields = entries(jsonQuery)
    .filter(([k, v]) => k !== '__args' && v !== false && v !== undefined)
    .map(([k, v]) => (typeof v === 'object' ? `${k}${toGraphql(v)}` : k))
    .join(' ') as any

  const validArgs = jsonQuery.__args ? entries(jsonQuery.__args).filter(([_, v]) => v !== undefined) : []
  const argsQuery = validArgs.length ? `(${validArgs.map(([k, v]: any) => `${k}:${v.substr(VAR_PREFIX_LENGTH)}`).join(',')})` : ''

  return `${argsQuery} ${fields ? `{ ${fields} }` : ''}`
}
