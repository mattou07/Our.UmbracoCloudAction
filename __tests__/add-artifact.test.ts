import { jest } from '@jest/globals'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import JSZip from 'jszip'
import type { UmbracoCloudAPI } from '../src/api/umbraco-cloud-api.js'
import type { ActionInputs } from '../src/types/index.js'
import { STATUS_MESSAGES } from './fixtures/umbraco-cloud-responses.js'

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

  const UMBRACO_FILE = '{"project":"src/Web/Web.csproj"}'

  /**
   * Builds a test artifact. A root .umbraco file is added unless
   * `withUmbraco` is false, since Umbraco Cloud requires one.
   */
  async function writeZip(
    files: Record<string, string>,
    { withUmbraco = true }: { withUmbraco?: boolean } = {}
  ): Promise<string> {
    const zip = new JSZip()
    if (withUmbraco) {
      zip.file('.umbraco', UMBRACO_FILE)
    }
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
      expect(fileNames(await readZip(zipPath))).toEqual([
        '.umbraco',
        'src/Program.cs'
      ])
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

      expect(fileNames(await readZip(zipPath))).toEqual([
        '.umbraco',
        'site/web.config'
      ])
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
        '.umbraco',
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
        '.umbraco',
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

    test('.cloud_gitignore without any .gitignore leaves the zip untouched', async () => {
      const zipPath = await writeZip({
        '.cloud_gitignore': 'cloud-rules',
        'src/Program.cs': 'class P {}'
      })
      const originalBytes = fs.readFileSync(zipPath)

      await handleAddArtifact(api, inputs({ filePath: zipPath }))

      expect(core.info).toHaveBeenCalledWith(
        'No .gitignore files found in artifact to replace'
      )
      expect(fs.readFileSync(zipPath).equals(originalBytes)).toBe(true)
      expect(mockAddDeploymentArtifact).toHaveBeenCalledTimes(1)
    })

    test('reports the NuGet failure when something other than an Error is thrown', async () => {
      const zipPath = await writeZip({ 'src/Program.cs': 'class P {}' })
      const originalFile = JSZip.prototype.file
      const fileSpy = jest
        .spyOn(JSZip.prototype, 'file')
        .mockImplementation(function (this: JSZip, ...args: unknown[]) {
          if (args[0] === 'NuGet.config') {
            throw 'disk on fire'
          }
          return (originalFile as (...a: unknown[]) => unknown).apply(
            this,
            args
          )
        } as never)

      try {
        await expect(
          handleAddArtifact(
            api,
            inputs({
              filePath: zipPath,
              nugetSourceName: 'MyFeed',
              nugetSourceUrl: 'https://nuget.example.com/v3/index.json'
            })
          )
        ).rejects.toThrow('Failed to configure NuGet source: disk on fire')
      } finally {
        fileSpy.mockRestore()
      }
      expect(core.setOutput).toHaveBeenCalledWith(
        'nuget-source-status',
        'Failed to configure NuGet source: disk on fire'
      )
      expect(mockAddDeploymentArtifact).not.toHaveBeenCalled()
    })

    test('reports a friendly error when filePath is a directory', async () => {
      await expect(
        handleAddArtifact(api, inputs({ filePath: tempDir }))
      ).rejects.toThrow(
        `filePath "${tempDir}" is not a file (resolved to ${path.resolve(tempDir)})`
      )
      expect(mockAddDeploymentArtifact).not.toHaveBeenCalled()
    })

    test('reports a friendly error when the zip reader rejects with a non-Error', async () => {
      const zipPath = await writeZip({ 'src/Program.cs': 'class P {}' })
      const loadSpy = jest
        .spyOn(JSZip, 'loadAsync')
        .mockRejectedValueOnce('corrupt' as never)

      try {
        await expect(
          handleAddArtifact(api, inputs({ filePath: zipPath }))
        ).rejects.toThrow(
          `filePath "${zipPath}" is not a valid zip file: corrupt`
        )
      } finally {
        loadSpy.mockRestore()
      }
    })

    test('rejects excluded-paths that normalise to nothing', async () => {
      const zipPath = await writeZip({ 'src/Program.cs': 'class P {}' })

      await expect(
        handleAddArtifact(
          api,
          inputs({ filePath: zipPath, excludedPaths: './' })
        )
      ).rejects.toThrow('No valid paths found after validation.')
      expect(mockAddDeploymentArtifact).not.toHaveBeenCalled()
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
      expect(fileNames(zip)).toEqual([
        '.umbraco',
        'NuGet.config',
        'src/Web/Program.cs'
      ])
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
      // The failure is still reported through the nuget-source-status output
      expect(core.setOutput).toHaveBeenCalledWith(
        'nuget-source-status',
        expect.stringContaining('Failed to configure NuGet source')
      )
    })

    test('throws when the zip has no files after exclusions', async () => {
      const zipPath = await writeZip(
        {
          '.git/HEAD': 'ref',
          '.github/workflows/ci.yml': 'on: push'
        },
        { withUmbraco: false }
      )

      await expect(
        handleAddArtifact(api, inputs({ filePath: zipPath }))
      ).rejects.toThrow('Artifact contains no files')
      expect(mockAddDeploymentArtifact).not.toHaveBeenCalled()
    })

    test('throws before NuGet injection when exclusions remove every file', async () => {
      // Real run A4: every top-level entry was excluded, NuGet injection then
      // re-created NuGet.config and a zip holding only that file was deployed.
      const zipPath = await writeZip({
        'src/Program.cs': 'class P {}',
        'NuGet.config': '<configuration/>'
      })

      await expect(
        handleAddArtifact(
          api,
          inputs({
            filePath: zipPath,
            excludedPaths: '.umbraco,src/,NuGet.config',
            nugetSourceName: 'MyFeed',
            nugetSourceUrl: 'https://nuget.example.com/v3/index.json'
          })
        )
      ).rejects.toThrow('Artifact contains no files')
      expect(mockAddDeploymentArtifact).not.toHaveBeenCalled()
    })

    test('throws when the artifact has no root .umbraco file', async () => {
      const zipPath = await writeZip(
        {
          'src/Web/.umbraco': 'nested does not count',
          'src/Web/Program.cs': 'class P {}'
        },
        { withUmbraco: false }
      )

      const error = await handleAddArtifact(
        api,
        inputs({ filePath: zipPath })
      ).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(Error)
      const message = (error as Error).message
      expect(message).toContain('no .umbraco file at the root of the zip')
      expect(message).toContain('Umbraco Cloud requires this file')
      expect(message).toContain('project file (.csproj)')
      expect(message).not.toContain('excluded-paths')
      expect(mockAddDeploymentArtifact).not.toHaveBeenCalled()
      // Without this check Umbraco Cloud fails the deployment with:
      expect(STATUS_MESSAGES.missingUmbracoFile).toContain(
        'Incoming package has no .umbraco file in its root. It names the project folder and project file the build uses.'
      )
    })

    test('says excluded-paths removed .umbraco when it did', async () => {
      const zipPath = await writeZip({ 'src/Web/Program.cs': 'class P {}' })

      await expect(
        handleAddArtifact(
          api,
          inputs({ filePath: zipPath, excludedPaths: '.git/,.umbraco' })
        )
      ).rejects.toThrow(/removed by the excluded-paths input/)
      expect(mockAddDeploymentArtifact).not.toHaveBeenCalled()
    })

    test('does not upload an artifact without .umbraco even when NuGet would add a file', async () => {
      const zipPath = await writeZip(
        { 'src/Web/Program.cs': 'class P {}' },
        { withUmbraco: false }
      )

      await expect(
        handleAddArtifact(
          api,
          inputs({
            filePath: zipPath,
            nugetSourceName: 'MyFeed',
            nugetSourceUrl: 'https://nuget.example.com/v3/index.json'
          })
        )
      ).rejects.toThrow('.umbraco')
      expect(mockAddDeploymentArtifact).not.toHaveBeenCalled()
    })

    test('a freshly generated NuGet.config also lists nuget.org', async () => {
      const zipPath = await writeZip({ 'src/Web/Program.cs': 'class P {}' })

      await handleAddArtifact(
        api,
        inputs({
          filePath: zipPath,
          nugetSourceName: 'MyFeed',
          nugetSourceUrl: 'https://nuget.example.com/v3/index.json'
        })
      )

      const xml = await (await readZip(zipPath))
        .file('NuGet.config')!
        .async('string')
      expect(xml).toContain(
        '<add key="nuget.org" value="https://api.nuget.org/v3/index.json"/>'
      )
      expect(xml).toContain('key="MyFeed"')
      expect(core.warning).not.toHaveBeenCalled()
    })

    test('does not duplicate nuget.org when it is the configured source', async () => {
      const zipPath = await writeZip({ 'src/Web/Program.cs': 'class P {}' })

      await handleAddArtifact(
        api,
        inputs({
          filePath: zipPath,
          nugetSourceName: 'public',
          nugetSourceUrl: 'https://api.nuget.org/v3/index.json/'
        })
      )

      const xml = await (await readZip(zipPath))
        .file('NuGet.config')!
        .async('string')
      expect(xml.match(/api\.nuget\.org/g)).toHaveLength(1)
    })

    test('warns when excluded-paths removed the root NuGet.config but a source is configured', async () => {
      const zipPath = await writeZip({
        'NuGet.config':
          '<configuration><packageSources><add key="other" value="https://other.example.com/v3/index.json"/></packageSources></configuration>',
        'src/Web/Program.cs': 'class P {}'
      })

      await handleAddArtifact(
        api,
        inputs({
          filePath: zipPath,
          excludedPaths: '.git/,NuGet.config',
          nugetSourceName: 'MyFeed',
          nugetSourceUrl: 'https://nuget.example.com/v3/index.json'
        })
      )

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining(
          'excluded-paths removed the existing root NuGet.config'
        )
      )
      const xml = await (await readZip(zipPath))
        .file('NuGet.config')!
        .async('string')
      expect(xml).toContain('key="MyFeed"')
      expect(xml).toContain('key="nuget.org"')
      expect(xml).not.toContain('key="other"')
    })

    test('reports a friendly error when filePath does not exist', async () => {
      const missing = path.join(tempDir, 'does-not-exist.zip')

      await expect(
        handleAddArtifact(api, inputs({ filePath: missing }))
      ).rejects.toThrow(
        `filePath "${missing}" does not exist (resolved to ${path.resolve(missing)})`
      )
      expect(mockAddDeploymentArtifact).not.toHaveBeenCalled()
    })

    test('reports a friendly error when filePath is not a zip', async () => {
      const notZip = path.join(tempDir, 'not-a-zip.zip')
      fs.writeFileSync(notZip, 'plain text, not a zip')

      const error = await handleAddArtifact(
        api,
        inputs({ filePath: notZip })
      ).catch((e: unknown) => e)

      expect((error as Error).message).toBe(
        `filePath "${notZip}" is not a valid zip file: Can't find end of central directory : is this a zip file ? If it is, see https://stuk.github.io/jszip/documentation/howto/read_zip.html`
      )
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
