import { jest } from '@jest/globals'

// Mock modules before importing them
jest.unstable_mockModule('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn()
}))

jest.unstable_mockModule('path', () => ({
  join: jest.fn(),
  dirname: jest.fn()
}))

jest.unstable_mockModule('glob', () => ({
  glob: jest.fn()
}))

jest.unstable_mockModule('xml2js', () => ({
  parseStringPromise: jest.fn(),
  Builder: jest.fn().mockImplementation(() => ({
    buildObject: jest.fn().mockReturnValue('<xml>test</xml>')
  }))
}))

// Import mocked modules
const fs = await import('fs')
const path = await import('path')
const { glob } = await import('glob')
const xml2js = await import('xml2js')

// Import the function to test
const { addOrUpdateNuGetConfigSource } = await import(
  '../../src/utils/nuget-config.js'
)

interface NuGetSourceConfig {
  name: string
  source: string
  username?: string
  password?: string
}

// Get the mock functions
const mockGlob = glob as jest.MockedFunction<typeof glob>
const mockExistsSync = fs.existsSync as jest.MockedFunction<
  typeof fs.existsSync
>
const mockReadFileSync = fs.readFileSync as jest.MockedFunction<
  typeof fs.readFileSync
>
const mockWriteFileSync = fs.writeFileSync as jest.MockedFunction<
  typeof fs.writeFileSync
>
const mockPathJoin = path.join as jest.MockedFunction<typeof path.join>
const mockPathDirname = path.dirname as jest.MockedFunction<typeof path.dirname>
const mockParseStringPromise = xml2js.parseStringPromise as jest.MockedFunction<
  typeof xml2js.parseStringPromise
>

describe('addOrUpdateNuGetConfigSource', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks()

    // Reset all mock implementations to prevent test interference
    mockGlob.mockReset()
    mockExistsSync.mockReset()
    mockReadFileSync.mockReset()
    mockWriteFileSync.mockReset()
    mockPathJoin.mockReset()
    mockPathDirname.mockReset()
    mockParseStringPromise.mockReset()

    // Setup default mock implementations
    mockPathJoin.mockImplementation((...args) => args.join('/'))
    mockPathDirname.mockImplementation((p) =>
      p.substring(0, p.lastIndexOf('/'))
    )
  })

  describe('Valid Input Scenarios', () => {
    test('creates new NuGet.config file when none exists', async () => {
      // Arrange
      const config: NuGetSourceConfig = {
        name: 'nuget.org',
        source: 'https://api.nuget.org/v3/index.json'
      }

      // Setup working directory to simulate current directory
      const mockCwd = jest
        .spyOn(process, 'cwd')
        .mockReturnValue('/test/project')
      mockGlob.mockResolvedValue([])
      mockPathJoin.mockReturnValue('/test/project/NuGet.config')
      mockPathDirname.mockReturnValue('/test/project')

      // Act
      const result = await addOrUpdateNuGetConfigSource(config)

      // Assert
      expect(result.success).toBe(true)
      expect(result.nugetConfigPath).toBe('/test/project/NuGet.config')
      expect(result.message).toContain('Created new NuGet.config')
      expect(mockWriteFileSync).toHaveBeenCalled()

      // Clean up
      mockCwd.mockRestore()
    })

    test('updates existing NuGet.config file with new source', async () => {
      // Arrange
      const config: NuGetSourceConfig = {
        name: 'custom-feed',
        source: 'https://custom.nuget.feed/v3/index.json'
      }

      const existingConfig = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" protocolVersion="3" />
  </packageSources>
</configuration>`

      const mockCwd = jest
        .spyOn(process, 'cwd')
        .mockReturnValue('/test/project')
      mockGlob.mockResolvedValue(['/test/project/NuGet.config'])
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(existingConfig)
      mockPathJoin.mockReturnValue('/test/project/NuGet.config') // Fix the path join
      mockParseStringPromise.mockResolvedValue({
        configuration: {
          packageSources: [
            {
              add: [
                {
                  $: {
                    key: 'nuget.org',
                    value: 'https://api.nuget.org/v3/index.json',
                    protocolVersion: '3'
                  }
                }
              ]
            }
          ]
        }
      })

      // Act
      const result = await addOrUpdateNuGetConfigSource(config)

      // Assert
      expect(result.success).toBe(true)
      expect(result.nugetConfigPath).toBe('/test/project/NuGet.config')
      expect(result.message).toContain('Updated NuGet.config')
      expect(mockReadFileSync).toHaveBeenCalledWith(
        '/test/project/NuGet.config',
        'utf8'
      )
      expect(mockWriteFileSync).toHaveBeenCalled()

      mockCwd.mockRestore()
    })

    test('adds source with username and password credentials', async () => {
      // Arrange
      const config: NuGetSourceConfig = {
        name: 'private-feed',
        source: 'https://private.nuget.feed/v3/index.json',
        username: 'testuser',
        password: 'testpass'
      }

      const mockCwd = jest
        .spyOn(process, 'cwd')
        .mockReturnValue('/test/project')
      mockGlob.mockResolvedValue([])
      mockPathJoin.mockReturnValue('/test/project/NuGet.config')
      mockPathDirname.mockReturnValue('/test/project')

      // Act
      const result = await addOrUpdateNuGetConfigSource(config)

      // Assert
      expect(result.success).toBe(true)
      expect(result.nugetConfigPath).toBe('/test/project/NuGet.config')
      expect(mockWriteFileSync).toHaveBeenCalled()

      mockCwd.mockRestore()
    })

    test('finds existing NuGet.config in current directory', async () => {
      // Arrange
      const config: NuGetSourceConfig = {
        name: 'nuget.org',
        source: 'https://api.nuget.org/v3/index.json'
      }

      const mockCwd = jest
        .spyOn(process, 'cwd')
        .mockReturnValue('/test/project')
      mockGlob.mockResolvedValue(['/test/project/NuGet.config'])
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(`<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
  </packageSources>
</configuration>`)
      mockPathJoin.mockReturnValue('/test/project/NuGet.config') // Fix the path join
      mockParseStringPromise.mockResolvedValue({
        configuration: {
          packageSources: [
            {
              add: [] // Empty add array for empty packageSources
            }
          ]
        }
      })

      // Act
      const result = await addOrUpdateNuGetConfigSource(config)

      // Assert
      expect(result.success).toBe(true)
      expect(result.nugetConfigPath).toBe('/test/project/NuGet.config')
      expect(mockGlob).toHaveBeenCalledWith('**/NuGet.config', {
        cwd: '/test/project',
        nodir: true
      })

      mockCwd.mockRestore()
    })
  })

  describe('Invalid Input Validation', () => {
    test('handles empty name in config', async () => {
      // Arrange
      const config = {
        name: '', // Invalid: empty name
        source: 'https://api.nuget.org/v3/index.json'
      } as NuGetSourceConfig

      const mockCwd = jest
        .spyOn(process, 'cwd')
        .mockReturnValue('/test/project')
      mockGlob.mockResolvedValue([])
      mockPathJoin.mockReturnValue('/test/project/NuGet.config')

      // Don't setup parseStringPromise since no existing file to parse

      // Act
      const result = await addOrUpdateNuGetConfigSource(config)

      // Assert
      expect(result.success).toBe(true) // The function still processes it
      expect(mockWriteFileSync).toHaveBeenCalled()

      mockCwd.mockRestore()
    })

    test('handles empty source URL in config', async () => {
      // Arrange
      const config: NuGetSourceConfig = {
        name: 'test-source',
        source: '' // Invalid: empty URL
      }

      const mockCwd = jest
        .spyOn(process, 'cwd')
        .mockReturnValue('/test/project')
      mockGlob.mockResolvedValue([])
      mockPathJoin.mockReturnValue('/test/project/NuGet.config')

      // Don't setup parseStringPromise since no existing file to parse

      // Act
      const result = await addOrUpdateNuGetConfigSource(config)

      // Assert
      expect(result.success).toBe(true) // The function still processes it
      expect(mockWriteFileSync).toHaveBeenCalled()

      mockCwd.mockRestore()
    })
  })

  describe('Edge Cases', () => {
    test('handles malformed existing NuGet.config', async () => {
      // Arrange
      const config: NuGetSourceConfig = {
        name: 'nuget.org',
        source: 'https://api.nuget.org/v3/index.json'
      }

      const mockCwd = jest
        .spyOn(process, 'cwd')
        .mockReturnValue('/test/project')
      mockGlob.mockResolvedValue(['/test/project/NuGet.config'])
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue('<invalid>xml</content>') // Malformed XML
      mockParseStringPromise.mockRejectedValue(new Error('Invalid XML'))

      // Act & Assert
      await expect(addOrUpdateNuGetConfigSource(config)).rejects.toThrow(
        'Invalid XML'
      )

      mockCwd.mockRestore()
    })

    test('handles file system errors when writing NuGet.config', async () => {
      // Arrange
      const config: NuGetSourceConfig = {
        name: 'nuget.org',
        source: 'https://api.nuget.org/v3/index.json'
      }

      const mockCwd = jest
        .spyOn(process, 'cwd')
        .mockReturnValue('/test/project')
      mockGlob.mockResolvedValue([])
      mockPathJoin.mockReturnValue('/test/project/NuGet.config')
      mockWriteFileSync.mockImplementation(() => {
        throw new Error('Permission denied')
      })

      // Act & Assert
      await expect(addOrUpdateNuGetConfigSource(config)).rejects.toThrow(
        'Permission denied'
      )

      mockCwd.mockRestore()
    })
  })

  describe('TypeScript Type Safety', () => {
    test('accepts valid NuGetSourceConfig interface', async () => {
      // Arrange
      const config: NuGetSourceConfig = {
        name: 'nuget.org',
        source: 'https://api.nuget.org/v3/index.json',
        username: 'optional-user',
        password: 'optional-pass'
      }

      const mockCwd = jest
        .spyOn(process, 'cwd')
        .mockReturnValue('/test/project')
      mockGlob.mockResolvedValue([])
      mockPathJoin.mockReturnValue('/test/project/NuGet.config')

      // Don't setup parseStringPromise since no existing file

      // Act
      const result = await addOrUpdateNuGetConfigSource(config)

      // Assert - TypeScript compilation validates interface compliance
      expect(result.success).toBe(true)
      expect(typeof result.nugetConfigPath).toBe('string')

      mockCwd.mockRestore()
    })

    test('returns proper NuGetConfigModificationResult interface', async () => {
      // Arrange
      const config: NuGetSourceConfig = {
        name: 'nuget.org',
        source: 'https://api.nuget.org/v3/index.json'
      }

      const mockCwd = jest
        .spyOn(process, 'cwd')
        .mockReturnValue('/test/project')
      mockGlob.mockResolvedValue([])
      mockPathJoin.mockReturnValue('/test/project/NuGet.config')

      // Don't setup parseStringPromise since no existing file

      // Act
      const result = await addOrUpdateNuGetConfigSource(config)

      // Assert - TypeScript compilation validates return type
      expect(result).toHaveProperty('success')
      expect(result).toHaveProperty('message')
      expect(result).toHaveProperty('nugetConfigPath')
      expect(typeof result.success).toBe('boolean')
      expect(typeof result.message).toBe('string')
      expect(typeof result.nugetConfigPath).toBe('string')

      mockCwd.mockRestore()
    })
  })
})
