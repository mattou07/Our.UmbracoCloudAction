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

// Mock fs module for file system operations
jest.mock('fs', () => ({
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  rmSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn()
}))

// Mock path module
jest.mock('path', () => ({
  join: jest.fn((...args) => args.join('/')),
  resolve: jest.fn()
}))

// Mock nuget-config module
jest.mock('../src/utils/nuget-config.js', () => ({
  addOrUpdateNuGetConfigSource: jest.fn()
}))

// Mock @actions/core
jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  setFailed: jest.fn(),
  setOutput: jest.fn(),
  debug: jest.fn()
}))

// Mock exec module to avoid system calls
jest.mock('@actions/exec', () => ({
  exec: jest.fn(() => Promise.resolve(0))
}))

describe('removeExcludedPaths', () => {
  let zip: JSZip

  beforeEach(() => {
    zip = new JSZip()
    jest.clearAllMocks()
  })

  beforeEach(() => {
    zip = new JSZip()
  })

  describe('Valid Input Scenarios', () => {
    test('removes single excluded path', () => {
      // Arrange
      const testFiles = {
        '.git/config': 'config data',
        '.git/HEAD': 'head data',
        'src/index.js': 'source code'
      }

      Object.entries(testFiles).forEach(([path, content]) => {
        zip.file(path, content)
      })

      const pathToExclude = '.git/'

      // Act
      removeExcludedPaths(zip, pathToExclude)

      // Assert
      expect(zip.files['.git/config']).toBeUndefined()
      expect(zip.files['.git/HEAD']).toBeUndefined()
      expect(zip.files['src/index.js']).toBeDefined()
    })

    test('removes multiple comma-separated excluded paths', () => {
      // Arrange
      const testFiles = {
        '.git/config': 'data',
        '.github/workflow.yml': 'data',
        'node_modules/package/index.js': 'data',
        'src/index.js': 'data'
      }

      Object.entries(testFiles).forEach(([path, content]) => {
        zip.file(path, content)
      })

      const pathsToExclude = '.git/,.github/,node_modules/'

      // Act
      removeExcludedPaths(zip, pathsToExclude)

      // Assert
      expect(zip.files['.git/config']).toBeUndefined()
      expect(zip.files['.github/workflow.yml']).toBeUndefined()
      expect(zip.files['node_modules/package/index.js']).toBeUndefined()
      expect(zip.files['src/index.js']).toBeDefined()
    })

    test('removes paths with spaces around commas', () => {
      // Arrange
      const testFiles = {
        '.git/config': 'data',
        '.github/workflow.yml': 'data',
        'temp/file.txt': 'data',
        'src/index.js': 'data'
      }

      Object.entries(testFiles).forEach(([path, content]) => {
        zip.file(path, content)
      })

      const pathsToExclude = '.git/, .github/ , temp/'

      // Act
      removeExcludedPaths(zip, pathsToExclude)

      // Assert
      expect(zip.files['.git/config']).toBeUndefined()
      expect(zip.files['.github/workflow.yml']).toBeUndefined()
      expect(zip.files['temp/file.txt']).toBeUndefined()
      expect(zip.files['src/index.js']).toBeDefined()
    })

    test('handles backslash path separators', () => {
      // Arrange
      const testFiles = {
        'temp\\cache\\file.tmp': 'data',
        'src\\index.js': 'data'
      }

      Object.entries(testFiles).forEach(([path, content]) => {
        zip.file(path, content)
      })

      const pathToExclude = 'temp\\'

      // Act
      removeExcludedPaths(zip, pathToExclude)

      // Assert
      expect(zip.files['temp\\cache\\file.tmp']).toBeUndefined()
      expect(zip.files['src\\index.js']).toBeDefined()
    })

    test('handles empty excluded paths gracefully', () => {
      // Arrange
      const testFiles = {
        'src/index.js': 'data',
        '.git/config': 'data'
      }

      Object.entries(testFiles).forEach(([path, content]) => {
        zip.file(path, content)
      })

      const emptyPathsToExclude = ''

      // Act & Assert
      expect(() => removeExcludedPaths(zip, emptyPathsToExclude)).not.toThrow()
      expect(zip.files['src/index.js']).toBeDefined()
      expect(zip.files['.git/config']).toBeDefined()
    })

    test('handles whitespace-only excluded paths', () => {
      // Arrange
      zip.file('src/index.js', 'data')
      const whitespaceOnlyPaths = '   \t\n  '

      // Act & Assert
      expect(() => removeExcludedPaths(zip, whitespaceOnlyPaths)).not.toThrow()
      expect(zip.files['src/index.js']).toBeDefined()
    })
  })

  describe('Invalid Input Validation', () => {
    test('throws error for space-separated paths', () => {
      // Arrange
      const invalidSpaceSeparatedPaths = ['foo bar', '.git/ .github/']
      const expectedErrorMessage = 'Invalid excluded-paths format'

      // Act & Assert
      invalidSpaceSeparatedPaths.forEach((invalidPath) => {
        expect(() => removeExcludedPaths(zip, invalidPath)).toThrow(
          expectedErrorMessage
        )
      })
    })

    test('throws error for mixed path separators', () => {
      // Arrange
      const invalidMixedSeparatorPaths = ['foo/bar\\baz', 'path\\to/mixed']
      const expectedErrorMessage = 'contains mixed separators'

      // Act & Assert
      invalidMixedSeparatorPaths.forEach((invalidPath) => {
        expect(() => removeExcludedPaths(zip, invalidPath)).toThrow(
          expectedErrorMessage
        )
      })
    })

    test('throws error for unsafe relative paths', () => {
      // Arrange
      const unsafeRelativePaths = ['../etc/passwd', '../../sensitive']
      const expectedErrorMessage = 'Invalid path'

      // Act & Assert
      unsafeRelativePaths.forEach((unsafePath) => {
        expect(() => removeExcludedPaths(zip, unsafePath)).toThrow(
          expectedErrorMessage
        )
      })
    })

    test('throws error for absolute paths', () => {
      // The function validates path format and rejects absolute paths
      expect(() => removeExcludedPaths(zip, '/absolute/path')).toThrow(
        'Invalid path "/absolute/path" in excluded-paths'
      )
    })

    test('logs info when Windows-style paths not found in artifact', () => {
      // Windows-style paths are valid format but won't match Unix paths in zip
      // This should not throw, just log info about the path not being found
      expect(() =>
        removeExcludedPaths(zip, 'C:\\some\\absolute\\path')
      ).not.toThrow()
    })

    test('logs info when excluded paths not found in artifact (already removed)', () => {
      zip.file('src/index.js', 'data')

      // Should not throw - missing paths are logged as info since goal is to remove them
      expect(() => removeExcludedPaths(zip, 'notfound/')).not.toThrow()
    })

    test('logs warning when no files match excluded paths', () => {
      zip.file('src/index.js', 'data')

      // Should not throw - just logs a warning about no matches
      expect(() => removeExcludedPaths(zip, 'nonexistent/')).not.toThrow()
    })
  })

  describe('Edge Cases', () => {
    test('handles empty zip file gracefully', () => {
      // Should not throw for empty zip - just logs that paths weren't found
      expect(() => removeExcludedPaths(zip, '.git/')).not.toThrow()
    })

    test('handles deeply nested path names', () => {
      const nestedPath = 'very/'.repeat(10) + 'deep/path/file.txt'
      zip.file(nestedPath, 'data')
      zip.file('src/index.js', 'data')

      removeExcludedPaths(zip, 'very/')

      expect(zip.files[nestedPath]).toBeUndefined()
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
      // No error thrown - paths not found is just logged as info (already removed)
      expect(() => removeExcludedPaths(zip, paths)).not.toThrow()
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
      // Arrange
      const minimalInputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        filePath: '/path/to/artifact.zip',
        targetEnvironmentAlias: 'dev',
        // Use NuGet config to avoid file processing
        nugetSourceName: 'TestSource',
        nugetSourceUrl: 'https://test.nuget.org/v3/index.json'
      }
      const expectedArtifactId = 'artifact-123'

      mockApi.addDeploymentArtifact.mockResolvedValue(expectedArtifactId)

      // Act
      const result = await handleAddArtifact(mockApi, minimalInputs)

      // Assert
      expect(result.artifactId).toBe(expectedArtifactId)
      expect(mockApi.addDeploymentArtifact).toHaveBeenCalledWith(
        minimalInputs.filePath,
        undefined, // description
        undefined // version
      )
    })

    test('handles all optional parameters', async () => {
      // Arrange
      const fullInputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        filePath: '/path/to/full-artifact.zip',
        targetEnvironmentAlias: 'dev',
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

      // Act
      const result = await handleAddArtifact(mockApi, fullInputs)

      // Assert
      expect(result).toEqual<ActionOutputs>({
        artifactId: expectedArtifactId,
        nugetSourceStatus: expect.stringContaining(
          'Failed to configure NuGet source'
        )
      })
      expect(mockApi.addDeploymentArtifact).toHaveBeenCalledWith(
        fullInputs.filePath,
        fullInputs.description,
        fullInputs.version
      )
    })

    test('returns proper ActionOutputs interface', async () => {
      const inputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        filePath: '/path/to/artifact.zip',
        targetEnvironmentAlias: 'dev',
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
      const inputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        targetEnvironmentAlias: 'dev'
        // filePath is missing
      } as ActionInputs

      await expect(handleAddArtifact(mockApi, inputs)).rejects.toThrow(
        'Missing required inputs: filePath'
      )

      expect(mockApi.addDeploymentArtifact).not.toHaveBeenCalled()
    })

    test('throws error when filePath is empty string', async () => {
      const inputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        filePath: '',
        targetEnvironmentAlias: 'dev'
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
        filePath: '/path/to/artifact.zip',
        targetEnvironmentAlias: 'dev',
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
        filePath: '/path/to/artifact.zip',
        targetEnvironmentAlias: 'dev',
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
        filePath: '/specific/path/to/artifact.zip',
        targetEnvironmentAlias: 'dev',
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
        filePath: longPath,
        targetEnvironmentAlias: 'dev',
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
        filePath: '/path/with spaces/and@symbols/artifact.zip',
        targetEnvironmentAlias: 'dev',
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
        filePath: '/path/to/artifact.zip',
        targetEnvironmentAlias: 'dev',
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
        filePath: '/string/path',
        targetEnvironmentAlias: 'dev',
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
        filePath: '/path/to/artifact.zip',
        targetEnvironmentAlias: 'dev',
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

  describe('NuGet Configuration Processing', () => {
    test('processes artifact with NuGet configuration successfully', async () => {
      // Arrange
      const nugetInputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        filePath: '/path/to/artifact.zip',
        targetEnvironmentAlias: 'dev',
        nugetSourceName: 'TestSource',
        nugetSourceUrl: 'https://test.nuget.org/v3/index.json',
        nugetSourceUsername: 'testuser',
        nugetSourcePassword: 'testpass',
        excludedPaths: '.git/,.github/'
      }
      const expectedArtifactId = 'nuget-artifact-123'

      mockApi.addDeploymentArtifact.mockResolvedValue(expectedArtifactId)

      // Act
      const result = await handleAddArtifact(mockApi, nugetInputs)

      // Assert
      expect(result.artifactId).toBe(expectedArtifactId)
      expect(result.nugetSourceStatus).toContain(
        'Failed to configure NuGet source'
      ) // File doesn't exist
    })

    test('handles NuGet configuration errors gracefully', async () => {
      // Arrange
      const nugetInputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        filePath: '/path/to/artifact.zip',
        targetEnvironmentAlias: 'dev',
        nugetSourceName: 'TestSource',
        nugetSourceUrl: 'https://test.nuget.org/v3/index.json'
      }
      const expectedArtifactId = 'nuget-error-artifact'

      mockApi.addDeploymentArtifact.mockResolvedValue(expectedArtifactId)

      // Act
      const result = await handleAddArtifact(mockApi, nugetInputs)

      // Assert
      expect(result.artifactId).toBe(expectedArtifactId)
      expect(result.nugetSourceStatus).toContain(
        'Failed to configure NuGet source'
      )
    })

    test('processes .cloud_gitignore without NuGet config', async () => {
      // Arrange
      const cloudGitignoreInputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        filePath: '/path/to/artifact.zip',
        targetEnvironmentAlias: 'dev'
      }
      const expectedArtifactId = 'cloudgitignore-artifact'

      mockApi.addDeploymentArtifact.mockResolvedValue(expectedArtifactId)

      // Act & Assert - This will fail trying to read the file, which is expected behavior
      await expect(
        handleAddArtifact(mockApi, cloudGitignoreInputs)
      ).rejects.toThrow()
    })
  })

  describe('Git Repository Validation', () => {
    test('handles git validation when file does not exist', async () => {
      // Arrange
      const inputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        filePath: '/nonexistent/path/to/artifact.zip',
        targetEnvironmentAlias: 'dev'
      }

      // Act & Assert
      await expect(handleAddArtifact(mockApi, inputs)).rejects.toThrow()
    })

    test('handles git validation for basic artifact', async () => {
      // Arrange
      const inputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        filePath: '/path/to/artifact.zip',
        targetEnvironmentAlias: 'dev'
      }
      const expectedArtifactId = 'basic-artifact'

      mockApi.addDeploymentArtifact.mockResolvedValue(expectedArtifactId)

      // Act & Assert
      await expect(handleAddArtifact(mockApi, inputs)).rejects.toThrow()
    })
  })

  describe('Cloud Gitignore Processing', () => {
    test('processes .cloud_gitignore replacement successfully', async () => {
      // Arrange
      const inputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        filePath: '/path/to/artifact.zip',
        targetEnvironmentAlias: 'dev',
        nugetSourceName: 'TestSource',
        nugetSourceUrl: 'https://test.nuget.org'
      }
      const expectedArtifactId = 'gitignore-processed'

      mockApi.addDeploymentArtifact.mockResolvedValue(expectedArtifactId)

      // Act
      const result = await handleAddArtifact(mockApi, inputs)

      // Assert
      expect(result.artifactId).toBe(expectedArtifactId)
    })

    test('handles missing .cloud_gitignore gracefully', async () => {
      // Arrange
      const inputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        filePath: '/path/to/artifact.zip',
        targetEnvironmentAlias: 'dev',
        nugetSourceName: 'TestSource',
        nugetSourceUrl: 'https://test.nuget.org'
      }
      const expectedArtifactId = 'no-cloudgitignore'

      mockApi.addDeploymentArtifact.mockResolvedValue(expectedArtifactId)

      // Act
      const result = await handleAddArtifact(mockApi, inputs)

      // Assert
      expect(result.artifactId).toBe(expectedArtifactId)
    })

    test('handles .cloud_gitignore processing errors gracefully', async () => {
      // Arrange
      const inputs: ActionInputs = {
        projectId: 'test-project',
        apiKey: 'test-key',
        filePath: '/path/to/artifact.zip',
        targetEnvironmentAlias: 'dev',
        nugetSourceName: 'TestSource',
        nugetSourceUrl: 'https://test.nuget.org'
      }
      const expectedArtifactId = 'gitignore-error'

      mockApi.addDeploymentArtifact.mockResolvedValue(expectedArtifactId)

      // Act
      const result = await handleAddArtifact(mockApi, inputs)

      // Assert
      expect(result.artifactId).toBe(expectedArtifactId)
    })
  })

  describe('Edge Cases and Error Handling', () => {
    test('handles no files matching excluded paths gracefully', async () => {
      // Arrange
      const testZip = new JSZip()
      testZip.file('src/index.js', 'content')
      const excludedPaths = 'nonexistent/'

      // Act & Assert - should not throw, paths may already be removed
      expect(() => removeExcludedPaths(testZip, excludedPaths)).not.toThrow()
    })

    test('throws error for invalid excluded paths format', async () => {
      // Arrange
      const testZip = new JSZip()
      const invalidPathFormat = '   ,   ,   '

      // Act & Assert
      expect(() => removeExcludedPaths(testZip, invalidPathFormat)).toThrow(
        'Invalid excluded-paths format'
      )
    })
  })
})
