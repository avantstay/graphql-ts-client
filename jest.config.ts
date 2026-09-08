/*
 * For a detailed explanation regarding each configuration property and type check, visit:
 * https://jestjs.io/docs/configuration
 */

export default {
  clearMocks: true,
  roots: ['<rootDir>/src'],
  coverageProvider: 'v8',
  watchPathIgnorePatterns: ['<rootDir>/src/__testClient.d.ts', '<rootDir>/src/__testClient.js'],
}
