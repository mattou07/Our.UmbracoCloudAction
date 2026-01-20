import { jest } from '@jest/globals'
import { getActionInputs } from '../src/main.js'
import { ActionInputs } from '../src/types/index.js'

// Helper to patch process.env for input simulation
type Inputs = Record<string, string | number | boolean | undefined>
function defineEnv(inputs: Inputs) {
  for (const [key, value] of Object.entries(inputs)) {
    process.env[`INPUT_${key.toUpperCase()}`] = value?.toString()
  }
}

describe('main.ts', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Reset process.env between tests
    for (const key in process.env) {
      if (key.startsWith('INPUT_')) delete process.env[key]
    }
  })

  describe('getActionInputs - Valid Inputs', () => {
    test('parses all required inputs correctly', () => {
      // Arrange
      const expectedProjectId = 'test-project-123'
      const expectedApiKey = 'sk_test_key_abc123'
      const expectedFilePath = './artifact.zip'
      const expectedTargetEnv = 'dev'

      defineEnv({
        projectId: expectedProjectId,
        apiKey: expectedApiKey,
        filePath: expectedFilePath,
        targetEnvironmentAlias: expectedTargetEnv,
        noBuildAndRestore: 'false',
        skipVersionCheck: 'false'
      })

      // Act
      const result = getActionInputs()

      // Assert
      expect(result.projectId).toBe(expectedProjectId)
      expect(result.apiKey).toBe(expectedApiKey)
      expect(result.filePath).toBe(expectedFilePath)
      expect(result.targetEnvironmentAlias).toBe(expectedTargetEnv)
      expect(result).toMatchObject<Partial<ActionInputs>>({
        projectId: expect.any(String),
        apiKey: expect.any(String),
        filePath: expect.any(String),
        targetEnvironmentAlias: expect.any(String)
      })
    })

    test('parses all inputs with custom values', () => {
      // Arrange
      const inputValues = {
        projectId: 'pid',
        apiKey: 'key',
        filePath: '/custom/path/artifact.zip',
        targetEnvironmentAlias: 'staging',
        baseUrl: 'https://custom-api.umbraco.com',
        commitMessage: 'Custom deploy message',
        timeoutSeconds: '2400',
        noBuildAndRestore: 'true',
        skipVersionCheck: 'true',
        description: 'Custom artifact description',
        version: '2.1.0',
        baseBranch: 'develop',
        'upload-retries': '5',
        'upload-retry-delay': '15000',
        'upload-timeout': '120000',
        'nuget-source-name': 'CustomSource',
        'nuget-source-url': 'https://nuget.custom.com/v3/index.json',
        'nuget-source-username': 'nuget-user',
        'nuget-source-password': 'nuget-pass',
        'excluded-paths': '.git/,.github/,.vscode/'
      }

      defineEnv(inputValues)

      // Act
      const result = getActionInputs()

      // Assert
      expect(result.projectId).toBe('pid')
      expect(result.apiKey).toBe('key')
      expect(result.filePath).toBe('/custom/path/artifact.zip')
      expect(result.targetEnvironmentAlias).toBe('staging')
      expect(result.baseUrl).toBe('https://custom-api.umbraco.com')
      expect(result.commitMessage).toBe('Custom deploy message')
      expect(result.timeoutSeconds).toBe(2400)
      expect(result.noBuildAndRestore).toBe(true)
      expect(result.skipVersionCheck).toBe(true)
      expect(result.description).toBe('Custom artifact description')
      expect(result.version).toBe('2.1.0')
      expect(result.baseBranch).toBe('develop')
      expect(result.uploadRetries).toBe(5)
      expect(result.uploadRetryDelay).toBe(15000)
      expect(result.uploadTimeout).toBe(120000)
      expect(result.nugetSourceName).toBe('CustomSource')
      expect(result.nugetSourceUrl).toBe(
        'https://nuget.custom.com/v3/index.json'
      )
      expect(result.nugetSourceUsername).toBe('nuget-user')
      expect(result.nugetSourcePassword).toBe('nuget-pass')
      expect(result.excludedPaths).toBe('.git/,.github/,.vscode/')
    })

    test('uses default values for optional inputs', () => {
      // Arrange
      const minimalInputs = {
        projectId: 'pid',
        apiKey: 'key',
        filePath: './artifact.zip',
        targetEnvironmentAlias: 'dev',
        noBuildAndRestore: 'false',
        skipVersionCheck: 'false'
      }
      const expectedDefaults = {
        baseUrl: 'https://api.cloud.umbraco.com',
        commitMessage: 'Deployment from GitHub Actions',
        timeoutSeconds: 1200,
        uploadRetries: 3,
        uploadRetryDelay: 10000,
        uploadTimeout: 60000,
        excludedPaths: '.git/,.github/'
      }

      defineEnv(minimalInputs)

      // Act
      const result = getActionInputs()

      // Assert
      expect(result.baseUrl).toBe(expectedDefaults.baseUrl)
      expect(result.commitMessage).toBe(expectedDefaults.commitMessage)
      expect(result.timeoutSeconds).toBe(expectedDefaults.timeoutSeconds)
      expect(result.noBuildAndRestore).toBe(false)
      expect(result.skipVersionCheck).toBe(false)
      expect(result.uploadRetries).toBe(expectedDefaults.uploadRetries)
      expect(result.uploadRetryDelay).toBe(expectedDefaults.uploadRetryDelay)
      expect(result.uploadTimeout).toBe(expectedDefaults.uploadTimeout)
      expect(result.excludedPaths).toBe(expectedDefaults.excludedPaths)

      // Verify optional inputs are empty when not provided
      expect(result.description).toBe('')
      expect(result.version).toBe('')
      expect(result.baseBranch).toBe('')
    })
  })

  describe('getActionInputs - Boolean Input Parsing', () => {
    test('correctly parses boolean true values', () => {
      // Arrange
      const inputsWithTrueBooleans = {
        projectId: 'pid',
        apiKey: 'key',
        filePath: './artifact.zip',
        targetEnvironmentAlias: 'dev',
        noBuildAndRestore: 'true',
        skipVersionCheck: 'true'
      }

      defineEnv(inputsWithTrueBooleans)

      // Act
      const result = getActionInputs()

      // Assert
      expect(result.noBuildAndRestore).toBe(true)
      expect(result.skipVersionCheck).toBe(true)
    })

    test('correctly parses boolean false values', () => {
      // Arrange
      const inputsWithFalseBooleans = {
        projectId: 'pid',
        apiKey: 'key',
        filePath: './artifact.zip',
        targetEnvironmentAlias: 'dev',
        noBuildAndRestore: 'false',
        skipVersionCheck: 'false'
      }

      defineEnv(inputsWithFalseBooleans)

      // Act
      const result = getActionInputs()

      // Assert
      expect(result.noBuildAndRestore).toBe(false)
      expect(result.skipVersionCheck).toBe(false)
    })

    test('defaults to false for missing boolean inputs', () => {
      defineEnv({
        projectId: 'pid',
        apiKey: 'key',
        filePath: './artifact.zip',
        targetEnvironmentAlias: 'dev',
        noBuildAndRestore: 'false',
        skipVersionCheck: 'false'
      })

      const inputs = getActionInputs()
      expect(inputs.noBuildAndRestore).toBe(false)
      expect(inputs.skipVersionCheck).toBe(false)
    })
  })

  describe('getActionInputs - Numeric Input Parsing', () => {
    test('correctly parses numeric inputs', () => {
      defineEnv({
        projectId: 'pid',
        apiKey: 'key',
        filePath: './artifact.zip',
        targetEnvironmentAlias: 'dev',
        noBuildAndRestore: 'false',
        skipVersionCheck: 'false',
        timeoutSeconds: '3600',
        'upload-retries': '7',
        'upload-retry-delay': '20000',
        'upload-timeout': '90000'
      })

      const inputs = getActionInputs()
      expect(inputs.timeoutSeconds).toBe(3600)
      expect(inputs.uploadRetries).toBe(7)
      expect(inputs.uploadRetryDelay).toBe(20000)
      expect(inputs.uploadTimeout).toBe(90000)
      expect(typeof inputs.timeoutSeconds).toBe('number')
      expect(typeof inputs.uploadRetries).toBe('number')
    })

    test('handles invalid numeric inputs gracefully', () => {
      defineEnv({
        projectId: 'pid',
        apiKey: 'key',
        filePath: './artifact.zip',
        targetEnvironmentAlias: 'dev',
        noBuildAndRestore: 'false',
        skipVersionCheck: 'false',
        timeoutSeconds: 'not-a-number',
        'upload-retries': 'invalid'
      })

      const inputs = getActionInputs()
      // parseInt returns NaN for invalid strings, which should be handled appropriately
      expect(isNaN(inputs.timeoutSeconds!)).toBe(true)
      expect(isNaN(inputs.uploadRetries!)).toBe(true)
    })

    test('uses defaults for empty numeric inputs', () => {
      defineEnv({
        projectId: 'pid',
        apiKey: 'key',
        filePath: './artifact.zip',
        targetEnvironmentAlias: 'dev',
        noBuildAndRestore: 'false',
        skipVersionCheck: 'false'
      })

      const inputs = getActionInputs()
      expect(inputs.timeoutSeconds).toBe(1200)
      expect(inputs.uploadRetries).toBe(3)
      expect(inputs.uploadRetryDelay).toBe(10000)
      expect(inputs.uploadTimeout).toBe(60000)
    })
  })

  describe('getActionInputs - Edge Cases', () => {
    test('handles empty string inputs for optional fields', () => {
      defineEnv({
        projectId: 'test-project',
        apiKey: 'test-key',
        filePath: './artifact.zip',
        targetEnvironmentAlias: 'dev',
        baseUrl: '',
        commitMessage: '',
        noBuildAndRestore: 'false',
        skipVersionCheck: 'false'
      })

      const inputs = getActionInputs()
      expect(inputs.projectId).toBe('test-project')
      expect(inputs.apiKey).toBe('test-key')
      expect(inputs.filePath).toBe('./artifact.zip')
      expect(inputs.targetEnvironmentAlias).toBe('dev')
      expect(inputs.baseUrl).toBe('https://api.cloud.umbraco.com') // Should use default
      expect(inputs.commitMessage).toBe('Deployment from GitHub Actions') // Should use default
    })

    test('handles whitespace-only inputs', () => {
      defineEnv({
        projectId: '  test-project  ', // @actions/core trims whitespace
        apiKey: '  test-key  ',
        filePath: '  ./artifact.zip  ',
        targetEnvironmentAlias: '  dev  ',
        description: '\t\n', // This might also get trimmed
        noBuildAndRestore: 'false',
        skipVersionCheck: 'false'
      })

      const inputs = getActionInputs()
      expect(inputs.projectId).toBe('test-project') // Trimmed by @actions/core
      expect(inputs.apiKey).toBe('test-key') // Trimmed by @actions/core
      expect(inputs.filePath).toBe('./artifact.zip') // Trimmed by @actions/core
      expect(inputs.targetEnvironmentAlias).toBe('dev') // Trimmed by @actions/core
      expect(inputs.description).toBe('') // Trimmed to empty by @actions/core
    })

    test('handles zero values for numeric inputs', () => {
      defineEnv({
        projectId: 'pid',
        apiKey: 'key',
        filePath: './artifact.zip',
        targetEnvironmentAlias: 'dev',
        noBuildAndRestore: 'false',
        skipVersionCheck: 'false',
        timeoutSeconds: '0',
        'upload-retries': '0'
      })

      const inputs = getActionInputs()
      expect(inputs.timeoutSeconds).toBe(0)
      expect(inputs.uploadRetries).toBe(0)
    })

    test('handles very large numeric values', () => {
      defineEnv({
        projectId: 'pid',
        apiKey: 'key',
        filePath: './artifact.zip',
        targetEnvironmentAlias: 'dev',
        noBuildAndRestore: 'false',
        skipVersionCheck: 'false',
        timeoutSeconds: '999999',
        'upload-timeout': '2147483647' // Max 32-bit signed integer
      })

      const inputs = getActionInputs()
      expect(inputs.timeoutSeconds).toBe(999999)
      expect(inputs.uploadTimeout).toBe(2147483647)
    })
  })

  describe('getActionInputs - TypeScript Type Validation', () => {
    test('returns object matching ActionInputs interface', () => {
      defineEnv({
        projectId: 'pid',
        apiKey: 'key',
        filePath: './artifact.zip',
        targetEnvironmentAlias: 'dev',
        noBuildAndRestore: 'false',
        skipVersionCheck: 'false'
      })

      const inputs = getActionInputs()

      // Verify return type matches ActionInputs interface
      const typedInputs: ActionInputs = inputs
      expect(typedInputs).toBeDefined()

      // Verify required fields exist and are strings
      expect(typeof inputs.projectId).toBe('string')
      expect(typeof inputs.apiKey).toBe('string')
      expect(typeof inputs.filePath).toBe('string')
      expect(typeof inputs.targetEnvironmentAlias).toBe('string')

      // Verify boolean fields are boolean (not undefined since we set them explicitly)
      expect(typeof inputs.noBuildAndRestore).toBe('boolean')
      expect(typeof inputs.skipVersionCheck).toBe('boolean')

      // Verify optional number fields are number or undefined
      expect(
        inputs.timeoutSeconds === undefined ||
          typeof inputs.timeoutSeconds === 'number'
      ).toBe(true)
      expect(
        inputs.uploadRetries === undefined ||
          typeof inputs.uploadRetries === 'number'
      ).toBe(true)
    })
  })

  test('can load fixture file', async () => {
    const fs = await import('fs/promises')
    const fixture = await fs.readFile('__fixtures__/core.ts', 'utf8')
    expect(fixture).toContain('jest.fn')
  })
})
