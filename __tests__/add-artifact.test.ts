import { jest } from '@jest/globals'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import JSZip from 'jszip'
import type { UmbracoCloudAPI } from '../src/api/umbraco-cloud-api.js'
import type { ActionInputs } from '../src/types/index.js'

jest.unstable_mockModule('@actions/core', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  startGroup: jest.fn(),
  endGroup: jest.fn()
}))

describe('add-artifact', () => {
  let core: typeof import('@actions/core')
  let handleAddArtifact: typeof import('../src/actions/add-artifact.js').handleAddArtifact
  let removeExcludedPaths: typeof import('../src/actions/add-artifact.js').removeExcludedPaths

  let tempDir: string
  let mockAddDeploymentArtifact: jest.Mock<
    (
      filePath: string,
      description?: string,
      version?: string
    ) => Promise<string>
  >
  let api: UmbracoCloudAPI

  beforeAll(async () => {
    core = await import('@actions/core')
    const mod = await import('../src/actions/add-artifact.js')
    handleAddArtifact = mod.handleAddArtifact
    removeExcludedPaths = mod.removeExcludedPaths
  })

  beforeEach(() => {
    jest.clearAllMocks()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'add-artifact-test-'))
    mockAddDeploymentArtifact = jest.fn(async () => 'artifact-123')
    api = {
      addDeploymentArtifact: mockAddDeploymentArtifact
    } as unknown as UmbracoCloudAPI
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  async function writeZip(files: Record<string, string>): Promise<string> {
    const zip = new JSZip()
    for (const [name, content] of Object.entries(files)) {
      zip.file(name, content)
    }
    const buffer = await zip.generateAsync({ type: 'nodebuffer' })
    const zipPath = path.join(tempDir, 'artifact.zip')
    fs.writeFileSync(zipPath, buffer)
    return zipPath
  }

  async function readZip(zipPath: string): Promise<JSZip> {
    return JSZip.loadAsync(fs.readFileSync(zipPath))
  }

  function fileNames(zip: JSZip): string[] {
    return Object.keys(zip.files)
      .filter((n) => !zip.files[n].dir)
      .sort()
  }

  function inputs(overrides: Partial<ActionInputs>): ActionInputs {
    return {
      projectId: 'project',
      apiKey: 'key',
      action: 'add-artifact',
      ...overrides
    } as ActionInputs
  }

  describe('handleAddArtifact', () => {
    test('removes excluded paths and writes zip back without NuGet or .cloud_gitignore', async () => {
      const zipPath = await writeZip({
        '.git/HEAD': 'ref: refs/heads/main',
        '.git/config': '[core]',
        '.github/workflows/ci.yml': 'on: push',
        'src/Program.cs': 'class P {}',
        'node_modules/pkg/index.js': 'x'
      })

      const result = await handleAddArtifact(
        api,
        inputs({
          filePath: zipPath,
          excludedPaths: '.git/,.github/,node_modules'
        })
      )

      expect(result.artifactId).toBe('artifact-123')
      expect(result.nugetSourceStatus).toBe('')
      expect(fileNames(await readZip(zipPath))).toEqual(['src/Program.cs'])
      expect(mockAddDeploymentArtifact).toHaveBeenCalledWith(
        zipPath,
        undefined,
        undefined
      )
      expect(core.setOutput).toHaveBeenCalledWith('artifactId', 'artifact-123')
      expect(core.setOutput).not.toHaveBeenCalledWith(
        'nuget-source-status',
        expect.anything()
      )
    })

    test('applies default exclusions when excluded-paths is not provided', async () => {
      const zipPath = await writeZip({
        '.git/HEAD': 'ref',
        '.github/workflows/ci.yml': 'on: push',
        'site/web.config': '<configuration/>'
      })

      await handleAddArtifact(api, inputs({ filePath: zipPath }))

      expect(fileNames(await readZip(zipPath))).toEqual(['site/web.config'])
    })

    test('.git exclusion does not remove .gitignore or .github/', async () => {
      const zipPath = await writeZip({
        '.git/HEAD': 'ref',
        '.gitignore': 'bin/',
        '.github/workflows/ci.yml': 'on: push',
        'src/.gitignore': 'obj/',
        'src/Program.cs': 'class P {}'
      })

      await handleAddArtifact(
        api,
        inputs({ filePath: zipPath, excludedPaths: '.git' })
      )

      expect(fileNames(await readZip(zipPath))).toEqual([
        '.github/workflows/ci.yml',
        '.gitignore',
        'src/.gitignore',
        'src/Program.cs'
      ])
    })

    test('directory exclusion without trailing slash removes the directory only', async () => {
      const zipPath = await writeZip({
        'src/Client.RCLProject/bin/Debug/a.dll': 'x',
        'src/Client.RCLProject/bin/Release/b.dll': 'x',
        'src/Client.RCLProject/binary.txt': 'keep',
        'src/Client.RCLProject/Client.csproj': '<Project/>'
      })

      await handleAddArtifact(
        api,
        inputs({
          filePath: zipPath,
          excludedPaths: 'src/Client.RCLProject/bin'
        })
      )

      expect(fileNames(await readZip(zipPath))).toEqual([
        'src/Client.RCLProject/Client.csproj',
        'src/Client.RCLProject/binary.txt'
      ])
    })

    test('.cloud_gitignore replaces root and nested .gitignore files', async () => {
      const zipPath = await writeZip({
        '.cloud_gitignore': 'cloud-rules',
        '.gitignore': 'local-rules',
        'src/Web/.gitignore': 'nested-local-rules',
        'src/Web/foo.gitignore': 'not a gitignore',
        'src/Web/Program.cs': 'class P {}'
      })

      await handleAddArtifact(api, inputs({ filePath: zipPath }))

      const zip = await readZip(zipPath)
      expect(await zip.file('.gitignore')!.async('string')).toBe('cloud-rules')
      expect(await zip.file('src/Web/.gitignore')!.async('string')).toBe(
        'cloud-rules'
      )
      expect(await zip.file('src/Web/foo.gitignore')!.async('string')).toBe(
        'not a gitignore'
      )
    })

    test('injects a new NuGet.config at the zip root', async () => {
      const zipPath = await writeZip({
        'src/Web/Program.cs': 'class P {}'
      })

      const result = await handleAddArtifact(
        api,
        inputs({
          filePath: zipPath,
          nugetSourceName: 'MyFeed',
          nugetSourceUrl: 'https://nuget.example.com/v3/index.json',
          nugetSourceUsername: 'user',
          nugetSourcePassword: '%NUGET_PASSWORD%'
        })
      )

      const zip = await readZip(zipPath)
      expect(fileNames(zip)).toEqual(['NuGet.config', 'src/Web/Program.cs'])
      const xml = await zip.file('NuGet.config')!.async('string')
      expect(xml).toContain(
        '<add key="MyFeed" value="https://nuget.example.com/v3/index.json"/>'
      )
      expect(xml).toContain('<add key="Username" value="user"/>')
      expect(xml).toContain(
        '<add key="ClearTextPassword" value="%NUGET_PASSWORD%"/>'
      )
      expect(result.nugetSourceStatus).toBe(
        'NuGet.config successfully injected into artifact'
      )
      expect(core.setOutput).toHaveBeenCalledWith(
        'nuget-source-status',
        'NuGet.config successfully injected into artifact'
      )
      expect(mockAddDeploymentArtifact).toHaveBeenCalledTimes(1)
    })

    test('updates an existing lowercase nuget.config in place without creating a second file', async () => {
      const existing = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>`
      const zipPath = await writeZip({
        'nuget.config': existing,
        'src/nested/NuGet.config': '<configuration/>',
        'src/Program.cs': 'class P {}'
      })

      await handleAddArtifact(
        api,
        inputs({
          filePath: zipPath,
          nugetSourceName: 'MyFeed',
          nugetSourceUrl: 'https://nuget.example.com/v3/index.json'
        })
      )

      const zip = await readZip(zipPath)
      const rootConfigs = fileNames(zip).filter(
        (n) => n.toLowerCase() === 'nuget.config'
      )
      expect(rootConfigs).toEqual(['nuget.config'])
      const xml = await zip.file('nuget.config')!.async('string')
      expect(xml).toContain('key="nuget.org"')
      expect(xml).toContain('key="MyFeed"')
      // Nested config untouched
      expect(await zip.file('src/nested/NuGet.config')!.async('string')).toBe(
        '<configuration/>'
      )
    })

    test('throws and does not upload when NuGet injection fails', async () => {
      const zipPath = await writeZip({
        'NuGet.config': '<configuration><packageSources>',
        'src/Program.cs': 'class P {}'
      })
      const originalBytes = fs.readFileSync(zipPath)

      await expect(
        handleAddArtifact(
          api,
          inputs({
            filePath: zipPath,
            nugetSourceName: 'MyFeed',
            nugetSourceUrl: 'https://nuget.example.com/v3/index.json'
          })
        )
      ).rejects.toThrow('Failed to configure NuGet source')

      expect(mockAddDeploymentArtifact).not.toHaveBeenCalled()
      expect(fs.readFileSync(zipPath).equals(originalBytes)).toBe(true)
    })

    test('throws when the zip has no files after exclusions', async () => {
      const zipPath = await writeZip({
        '.git/HEAD': 'ref',
        '.github/workflows/ci.yml': 'on: push'
      })

      await expect(
        handleAddArtifact(api, inputs({ filePath: zipPath }))
      ).rejects.toThrow('Artifact contains no files')
      expect(mockAddDeploymentArtifact).not.toHaveBeenCalled()
    })

    test('does not rewrite the zip when nothing changed', async () => {
      const zipPath = await writeZip({ 'src/Program.cs': 'class P {}' })
      const originalBytes = fs.readFileSync(zipPath)

      await handleAddArtifact(api, inputs({ filePath: zipPath }))

      expect(fs.readFileSync(zipPath).equals(originalBytes)).toBe(true)
      expect(mockAddDeploymentArtifact).toHaveBeenCalledTimes(1)
    })

    test('throws when filePath is missing', async () => {
      await expect(handleAddArtifact(api, inputs({}))).rejects.toThrow()
      expect(mockAddDeploymentArtifact).not.toHaveBeenCalled()
    })
  })

  describe('removeExcludedPaths', () => {
    function zipWith(names: string[]): JSZip {
      const zip = new JSZip()
      for (const n of names) zip.file(n, 'x')
      return zip
    }

    test('normalises backslashes and leading ./', () => {
      const zip = zipWith(['node_modules/a.js', 'obj/b.dll', 'keep.txt'])
      const removed = removeExcludedPaths(zip, 'node_modules\\,./obj')
      expect(removed).toBe(true)
      expect(fileNames(zip)).toEqual(['keep.txt'])
    })

    test('matches an exact file path', () => {
      const zip = zipWith(['appsettings.Local.json', 'appsettings.json'])
      removeExcludedPaths(zip, 'appsettings.Local.json')
      expect(fileNames(zip)).toEqual(['appsettings.json'])
    })

    test('returns false and logs info (not a warning) when nothing matched', () => {
      const zip = zipWith(['keep.txt'])
      expect(removeExcludedPaths(zip, '.git/')).toBe(false)
      expect(core.warning).not.toHaveBeenCalled()
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('No excluded paths were found')
      )
    })

    test('returns false for empty input', () => {
      const zip = zipWith(['keep.txt'])
      expect(removeExcludedPaths(zip, '   ')).toBe(false)
      expect(fileNames(zip)).toEqual(['keep.txt'])
    })

    test.each([
      ['path1 path2', 'Invalid excluded-paths format'],
      ['../secret', 'Invalid path'],
      ['/abs', 'Invalid path'],
      ['mixed/sep\\path', 'mixed separators']
    ])('rejects invalid input %p', (value, message) => {
      expect(() => removeExcludedPaths(zipWith(['a']), value)).toThrow(message)
    })
  })
})
