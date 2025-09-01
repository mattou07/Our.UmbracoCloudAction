import { jest } from '@jest/globals'
import JSZip from 'jszip'

// Import the functions
import {
  removeExcludedPaths,
  handleAddArtifact
} from '../src/actions/add-artifact.js'
import { UmbracoCloudAPI } from '../src/api/umbraco-cloud-api.js'
import { ActionInputs, ActionOutputs } from '../src/types/index.js'

// Mock the validateRequiredInputs function directly
jest.mock('../src/utils/helpers.js', () => ({
  validateRequiredInputs: jest.fn(
    (inputs: Record<string, unknown>, required: string[]) => {
      const missing = required.filter((key) => !inputs[key])
      if (missing.length > 0) {
        throw new Error(`Missing required inputs: ${missing.join(', ')}`)
      }
    }
  )
}))

// Mock exec module to avoid system calls
jest.mock('@actions/exec', () => ({
  exec: jest.fn(() => Promise.resolve(0))
}))

describe('removeExcludedPaths', () => {
  let zip: JSZip

  beforeEach(() => {
    zip = new JSZip()
  })

  describe('Valid Input Scenarios', () => {
    test('removes single excluded path', () => {
      zip.file('.git/config', 'config data')
      zip.file('.git/HEAD', 'head data')
      zip.file('src/index.js', 'source code')

      removeExcludedPaths(zip, '.git/')

      expect(zip.files['.git/config']).toBeUndefined()
      expect(zip.files['.git/HEAD']).toBeUndefined()
      expect(zip.files['src/index.js']).toBeDefined()
    })

    test('removes multiple comma-separated excluded paths', () => {
      zip.file('.git/config', 'data')
      zip.file('.github/workflow.yml', 'data')
      zip.file('node_modules/package/index.js', 'data')
      zip.file('src/index.js', 'data')

      removeExcludedPaths(zip, '.git/,.github/,node_modules/')

      expect(zip.files['.git/config']).toBeUndefined()
      expect(zip.files['.github/workflow.yml']).toBeUndefined()
      expect(zip.files['node_modules/package/index.js']).toBeUndefined()
      expect(zip.files['src/index.js']).toBeDefined()
    })

    test('removes paths with spaces around commas', () => {
      zip.file('.git/config', 'data')
      zip.file('.github/workflow.yml', 'data')
      zip.file('temp/file.txt', 'data')
      zip.file('src/index.js', 'data')

      removeExcludedPaths(zip, '.git/, .github/ , temp/')

      expect(zip.files['.git/config']).toBeUndefined()
      expect(zip.files['.github/workflow.yml']).toBeUndefined()
      expect(zip.files['temp/file.txt']).toBeUndefined()
      expect(zip.files['src/index.js']).toBeDefined()
    })

    test('handles backslash path separators', () => {
      zip.file('temp\\cache\\file.tmp', 'data')
      zip.file('src\\index.js', 'data')

      removeExcludedPaths(zip, 'temp\\')

      expect(zip.files['temp\\cache\\file.tmp']).toBeUndefined()
      expect(zip.files['src\\index.js']).toBeDefined()
    })

    test('handles empty excluded paths gracefully', () => {
      zip.file('src/index.js', 'data')
      zip.file('.git/config', 'data')

      // Should not throw and not remove anything
      expect(() => removeExcludedPaths(zip, '')).not.toThrow()
      expect(zip.files['src/index.js']).toBeDefined()
      expect(zip.files['.git/config']).toBeDefined()
    })

    test('handles whitespace-only excluded paths', () => {
      zip.file('src/index.js', 'data')

      expect(() => removeExcludedPaths(zip, '   \t\n  ')).not.toThrow()
      expect(zip.files['src/index.js']).toBeDefined()
    })
  })

  describe('Invalid Input Validation', () => {
    test('throws error for space-separated paths', () => {
      expect(() => removeExcludedPaths(zip, 'foo bar')).toThrow(
        'Invalid excluded-paths format'
      )
      expect(() => removeExcludedPaths(zip, '.git/ .github/')).toThrow(
        'Invalid excluded-paths format'
      )
    })

    test('throws error for mixed path separators', () => {
      expect(() => removeExcludedPaths(zip, 'foo/bar\\baz')).toThrow(
        'contains mixed separators'
      )
      expect(() => removeExcludedPaths(zip, 'path\\to/mixed')).toThrow(
        'contains mixed separators'
      )
    })

    test('throws error for unsafe relative paths', () => {
      expect(() => removeExcludedPaths(zip, '../etc/passwd')).toThrow(
        'Invalid path'
      )
      expect(() => removeExcludedPaths(zip, '../../sensitive')).toThrow(
        'Invalid path'
      )
    })

    test('throws error for absolute paths', () => {
      // The function validates path format and rejects absolute paths and unsafe relative paths
      expect(() => removeExcludedPaths(zip, '/absolute/path')).toThrow(
        'Invalid path "/absolute/path" in excluded-paths'
      )
      expect(() =>
        removeExcludedPaths(zip, 'C:\\some\\absolute\\path')
      ).toThrow('The following excluded paths were not found in the artifact')
    })

    test('throws error when excluded paths not found in artifact', () => {
      zip.file('src/index.js', 'data')

      expect(() => removeExcludedPaths(zip, 'notfound/')).toThrow(
        'The following excluded paths were not found in the artifact: notfound/'
      )
    })

    test('throws error when no files match excluded paths', () => {
      zip.file('src/index.js', 'data')

      expect(() => removeExcludedPaths(zip, 'nonexistent/')).toThrow(
        'The following excluded paths were not found in the artifact'
      )
    })
  })

  describe('Edge Cases', () => {
    test('handles empty zip file', () => {
      expect(() => removeExcludedPaths(zip, '.git/')).toThrow(
        'The following excluded paths were not found in the artifact'
      )
    })

    test('handles very long path names', () => {
      const longPath = 'very/'.repeat(50) + 'long/path/file.txt'
      zip.file(longPath, 'data')
      zip.file('src/index.js', 'data')

      removeExcludedPaths(zip, 'very/')

      expect(zip.files[longPath]).toBeUndefined()
      expect(zip.files['src/index.js']).toBeDefined()
    })

    test('handles special characters in paths', () => {
      zip.file('special@#$%/file.txt', 'data')
      zip.file('normal/file.txt', 'data')

      removeExcludedPaths(zip, 'special@#$%/')

      expect(zip.files['special@#$%/file.txt']).toBeUndefined()
      expect(zip.files['normal/file.txt']).toBeDefined()
    })

    test('handles partial path matches correctly', () => {
      zip.file('.gitignore', 'data')
      zip.file('.git/config', 'data')
      zip.file('src/index.js', 'data')

      removeExcludedPaths(zip, '.git/')

      // .gitignore should remain (partial match)
      expect(zip.files['.gitignore']).toBeDefined()
      expect(zip.files['.git/config']).toBeUndefined()
      expect(zip.files['src/index.js']).toBeDefined()
    })
  })

  describe('TypeScript Type Safety', () => {
    test('accepts JSZip instance and string parameters', () => {
      const zip: JSZip = new JSZip()
      const paths: string = '.git/,.github/'

      zip.file('test.txt', 'data')

      // This should compile without TypeScript errors
      expect(() => removeExcludedPaths(zip, paths)).toThrow()
    })
  })
})

describe('handleAddArtifact', () => {
  let mockApi: jest.Mocked<UmbracoCloudAPI>

  beforeEach(() => {
    jest.clearAllMocks()

    mockApi = {
      addDeploymentArtifact: jest.fn()
    } as Partial<jest.Mocked<UmbracoCloudAPI>> as jest.Mocked<UmbracoCloudAPI>
  })

  describe('Valid Input Scenarios', () => {
    test('handles minimal required inputs', async () => {
      const inputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        action: 'add-artifact',
        filePath: '/path/to/artifact.zip',
        // Use NuGet config to avoid file processing
        nugetSourceName: 'TestSource',
        nugetSourceUrl: 'https://test.nuget.org/v3/index.json'
      }

      const expectedArtifactId = 'artifact-123'
      mockApi.addDeploymentArtifact.mockResolvedValue(expectedArtifactId)

      const result = await handleAddArtifact(mockApi, inputs)

      expect(result.artifactId).toBe(expectedArtifactId)
      expect(mockApi.addDeploymentArtifact).toHaveBeenCalledWith(
        inputs.filePath,
        undefined, // description
        undefined // version
      )
    })

    test('handles all optional parameters', async () => {
      const inputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        action: 'add-artifact',
        filePath: '/path/to/full-artifact.zip',
        description: 'Full test artifact with all options',
        version: '2.1.0',
        nugetSourceName: 'ProductionSource',
        nugetSourceUrl: 'https://prod.nuget.org/v3/index.json',
        nugetSourceUsername: 'prod-user',
        nugetSourcePassword: 'prod-pass',
        excludedPaths: '.git/,.github/,.vscode/,temp/'
      }

      const expectedArtifactId = 'full-artifact-456'
      mockApi.addDeploymentArtifact.mockResolvedValue(expectedArtifactId)

      const result = await handleAddArtifact(mockApi, inputs)

      expect(result).toEqual<ActionOutputs>({
        artifactId: expectedArtifactId,
        nugetSourceStatus: expect.stringContaining(
          'Failed to configure NuGet source'
        )
      })

      expect(mockApi.addDeploymentArtifact).toHaveBeenCalledWith(
        inputs.filePath,
        inputs.description,
        inputs.version
      )
    })

    test('returns proper ActionOutputs interface', async () => {
      const inputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        action: 'add-artifact',
        filePath: '/path/to/artifact.zip',
        nugetSourceName: 'TestSource',
        nugetSourceUrl: 'https://test.nuget.org'
      }

      const expectedArtifactId = 'typed-artifact-789'
      mockApi.addDeploymentArtifact.mockResolvedValue(expectedArtifactId)

      const result = await handleAddArtifact(mockApi, inputs)

      // Verify result matches ActionOutputs interface
      const typedResult: ActionOutputs = result
      expect(typedResult).toBeDefined()
      expect(typeof result.artifactId).toBe('string')
      expect(typeof result.nugetSourceStatus).toBe('string')
    })
  })

  describe('Input Validation', () => {
    test('throws error when filePath is missing', async () => {
      const inputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        action: 'add-artifact'
        // filePath is missing
      }

      await expect(handleAddArtifact(mockApi, inputs)).rejects.toThrow(
        'Missing required inputs: filePath'
      )

      expect(mockApi.addDeploymentArtifact).not.toHaveBeenCalled()
    })

    test('throws error when filePath is empty string', async () => {
      const inputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        action: 'add-artifact',
        filePath: ''
      }

      await expect(handleAddArtifact(mockApi, inputs)).rejects.toThrow(
        'Missing required inputs: filePath'
      )
    })

    test('throws error when all required fields are missing', async () => {
      const inputs = {} as ActionInputs

      await expect(handleAddArtifact(mockApi, inputs)).rejects.toThrow(
        'Missing required inputs: filePath'
      )
    })
  })

  describe('API Integration', () => {
    test('handles API success response correctly', async () => {
      const inputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        action: 'add-artifact',
        filePath: '/path/to/artifact.zip',
        nugetSourceName: 'TestSource',
        nugetSourceUrl: 'https://test.nuget.org'
      }

      const expectedArtifactId = 'success-artifact-123'
      mockApi.addDeploymentArtifact.mockResolvedValue(expectedArtifactId)

      const result = await handleAddArtifact(mockApi, inputs)

      expect(result.artifactId).toBe(expectedArtifactId)
      expect(mockApi.addDeploymentArtifact).toHaveBeenCalledTimes(1)
    })

    test('propagates API errors correctly', async () => {
      const inputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        action: 'add-artifact',
        filePath: '/path/to/artifact.zip',
        nugetSourceName: 'TestSource',
        nugetSourceUrl: 'https://test.nuget.org'
      }

      const apiError = new Error('API connection failed')
      mockApi.addDeploymentArtifact.mockRejectedValue(apiError)

      await expect(handleAddArtifact(mockApi, inputs)).rejects.toThrow(
        'API connection failed'
      )
    })

    test('calls API with correct parameters', async () => {
      const inputs: ActionInputs = {
        projectId: 'param-test-project',
        apiKey: 'param-test-key',
        action: 'add-artifact',
        filePath: '/specific/path/to/artifact.zip',
        description: 'Parameter validation artifact',
        version: '1.2.3',
        nugetSourceName: 'ParamSource',
        nugetSourceUrl: 'https://param.nuget.org'
      }

      mockApi.addDeploymentArtifact.mockResolvedValue('param-artifact-id')

      await handleAddArtifact(mockApi, inputs)

      expect(mockApi.addDeploymentArtifact).toHaveBeenCalledWith(
        '/specific/path/to/artifact.zip',
        'Parameter validation artifact',
        '1.2.3'
      )
    })
  })

  describe('Edge Cases', () => {
    test('handles very long file paths', async () => {
      const longPath = '/very/'.repeat(50) + 'long/path/to/artifact.zip'
      const inputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        action: 'add-artifact',
        filePath: longPath,
        nugetSourceName: 'TestSource',
        nugetSourceUrl: 'https://test.nuget.org'
      }

      mockApi.addDeploymentArtifact.mockResolvedValue('long-path-artifact')

      const result = await handleAddArtifact(mockApi, inputs)

      expect(result.artifactId).toBe('long-path-artifact')
      expect(mockApi.addDeploymentArtifact).toHaveBeenCalledWith(
        longPath,
        undefined,
        undefined
      )
    })

    test('handles special characters in parameters', async () => {
      const inputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        action: 'add-artifact',
        filePath: '/path/with spaces/and@symbols/artifact.zip',
        description: 'Artifact with special chars: @#$%^&*()',
        version: '1.0.0-alpha+build.123',
        nugetSourceName: 'Special-Source_123',
        nugetSourceUrl: 'https://special.nuget.org/v3/index.json'
      }

      mockApi.addDeploymentArtifact.mockResolvedValue('special-artifact')

      const result = await handleAddArtifact(mockApi, inputs)

      expect(result.artifactId).toBe('special-artifact')
    })

    test('handles undefined optional parameters correctly', async () => {
      const inputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        action: 'add-artifact',
        filePath: '/path/to/artifact.zip',
        description: undefined,
        version: undefined,
        nugetSourceName: 'TestSource',
        nugetSourceUrl: 'https://test.nuget.org'
      }

      mockApi.addDeploymentArtifact.mockResolvedValue(
        'undefined-params-artifact'
      )

      const result = await handleAddArtifact(mockApi, inputs)

      expect(result.artifactId).toBe('undefined-params-artifact')
      expect(mockApi.addDeploymentArtifact).toHaveBeenCalledWith(
        inputs.filePath,
        undefined,
        undefined
      )
    })
  })

  describe('TypeScript Type Safety', () => {
    test('enforces ActionInputs interface constraints', async () => {
      // This test validates TypeScript compilation
      const validInputs: ActionInputs = {
        projectId: 'string-project',
        apiKey: 'string-key',
        action: 'add-artifact',
        filePath: '/string/path',
        timeoutSeconds: 1200, // number
        noBuildAndRestore: true, // boolean
        nugetSourceName: 'TestSource',
        nugetSourceUrl: 'https://test.nuget.org'
      }

      mockApi.addDeploymentArtifact.mockResolvedValue('type-safe-artifact')

      const result = await handleAddArtifact(mockApi, validInputs)

      // Verify return type is ActionOutputs
      const typedResult: ActionOutputs = result
      expect(typedResult.artifactId).toBe('type-safe-artifact')
    })

    test('handles optional properties in ActionInputs correctly', async () => {
      const inputsWithOptionals: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        action: 'add-artifact',
        filePath: '/path/to/artifact.zip',
        // These are all optional in ActionInputs interface
        description: 'optional description',
        version: '1.0.0',
        timeoutSeconds: 3600,
        uploadRetries: 5,
        nugetSourceName: 'TestSource',
        nugetSourceUrl: 'https://test.nuget.org'
      }

      mockApi.addDeploymentArtifact.mockResolvedValue(
        'optional-fields-artifact'
      )

      const result = await handleAddArtifact(mockApi, inputsWithOptionals)
      expect(result.artifactId).toBe('optional-fields-artifact')
    })
  })
})
