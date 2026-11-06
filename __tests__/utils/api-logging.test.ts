import { jest } from '@jest/globals'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const uploadArtifact = jest.fn<(...args: unknown[]) => Promise<unknown>>()

jest.unstable_mockModule('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn()
}))

jest.unstable_mockModule('@actions/artifact', () => ({
  DefaultArtifactClient: jest.fn().mockImplementation(() => ({
    uploadArtifact
  }))
}))

type ApiLoggingModule = typeof import('../../src/utils/api-logging.js')

describe('api-logging', () => {
  let apiLogging: ApiLoggingModule
  let fetchMock: jest.Mock<typeof fetch>
  const originalFetch = globalThis.fetch
  const originalRunnerTemp = process.env.RUNNER_TEMP
  let tempDir: string

  beforeAll(async () => {
    apiLogging = await import('../../src/utils/api-logging.js')
  })

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-logging-test-'))
    process.env.RUNNER_TEMP = tempDir
    fetchMock = jest.fn<typeof fetch>()
    globalThis.fetch = fetchMock
    uploadArtifact.mockReset()
    uploadArtifact.mockResolvedValue({})
  })

  afterEach(() => {
    apiLogging.initializeApiLogging(false)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
    if (originalRunnerTemp === undefined) {
      delete process.env.RUNNER_TEMP
    } else {
      process.env.RUNNER_TEMP = originalRunnerTemp
    }
  })

  function readEntries(): Record<string, unknown>[] {
    return fs
      .readFileSync(apiLogging.getApiLogPath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }

  describe('when disabled', () => {
    it('passes straight through to fetch without cloning or writing', async () => {
      apiLogging.initializeApiLogging(false)
      const clone = jest.fn()
      const fakeResponse = {
        ok: true,
        status: 200,
        clone
      } as unknown as Response
      fetchMock.mockResolvedValue(fakeResponse)

      const init = { method: 'POST', body: '{"a":1}' }
      const result = await apiLogging.fetchWithApiLogging(
        'https://example.test/x',
        init,
        { operation: 'op' }
      )

      expect(result).toBe(fakeResponse)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledWith('https://example.test/x', init)
      expect(clone).not.toHaveBeenCalled()
      expect(apiLogging.isApiLoggingEnabled()).toBe(false)
      expect(apiLogging.getApiLogPath()).toBe('')
      expect(fs.readdirSync(tempDir)).toHaveLength(0)
    })

    it('skips artifact upload', async () => {
      apiLogging.initializeApiLogging(false)
      await apiLogging.uploadApiLogArtifactIfAvailable()
      expect(uploadArtifact).not.toHaveBeenCalled()
    })
  })

  describe('when enabled', () => {
    beforeEach(() => {
      apiLogging.initializeApiLogging(true, 'my-artifact')
    })

    it('creates the log file under RUNNER_TEMP', () => {
      expect(apiLogging.isApiLoggingEnabled()).toBe(true)
      const logPath = apiLogging.getApiLogPath()
      expect(path.dirname(logPath)).toBe(tempDir)
      expect(fs.existsSync(logPath)).toBe(true)
    })

    it('writes one NDJSON line per request and leaves the body readable', async () => {
      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ deploymentId: 'd1' }), {
            status: 201,
            statusText: 'Created'
          })
        )
        .mockResolvedValueOnce(new Response('plain text', { status: 500 }))

      const res = await apiLogging.fetchWithApiLogging(
        'https://api.test/deployments',
        {
          method: 'POST',
          headers: { 'Umbraco-Cloud-Api-Key': 'secret-key' },
          body: JSON.stringify({ targetEnvironmentAlias: 'live' })
        },
        { operation: 'startDeployment', metadata: { alias: 'live' } }
      )
      expect(await res.json()).toEqual({ deploymentId: 'd1' })

      await apiLogging.fetchWithApiLogging('https://api.test/status', {})

      const entries = readEntries()
      expect(entries).toHaveLength(2)
      expect(entries[0]).toMatchObject({
        operation: 'startDeployment',
        method: 'POST',
        url: 'https://api.test/deployments',
        ok: true,
        status: 201,
        statusText: 'Created',
        requestBody: { targetEnvironmentAlias: 'live' },
        responseBody: { deploymentId: 'd1' },
        metadata: { alias: 'live' }
      })
      expect(entries[1]).toMatchObject({
        method: 'GET',
        status: 500,
        ok: false,
        responseBody: 'plain text'
      })
      // Headers (API key) are never logged
      expect(fs.readFileSync(apiLogging.getApiLogPath(), 'utf8')).not.toContain(
        'secret-key'
      )
    })

    it('redacts diff response bodies', async () => {
      const patch = 'diff --git a/x b/x\n+secret source'
      fetchMock.mockResolvedValue(new Response(patch, { status: 200 }))

      const res = await apiLogging.fetchWithApiLogging(
        'https://api.test/diff',
        { method: 'GET' },
        { operation: 'getChangesById' }
      )

      expect(await res.text()).toBe(patch)
      const [entry] = readEntries()
      expect(entry.responseBody).toBe(`[redacted diff: ${patch.length} chars]`)
      expect(JSON.stringify(entry)).not.toContain('secret source')
    })

    it('redacts blobUrl keys at any depth, case-insensitively', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            artifactId: 'a1',
            blobUrl: 'https://blob.test/a.zip',
            nested: [{ BlobURL: 'x', keep: 'y' }]
          }),
          { status: 200 }
        )
      )

      await apiLogging.fetchWithApiLogging(
        'https://api.test/artifacts',
        { method: 'POST', body: JSON.stringify({ blobUrl: 'req' }) },
        { operation: 'addDeploymentArtifact' }
      )

      const [entry] = readEntries()
      expect(entry.responseBody).toEqual({
        artifactId: 'a1',
        blobUrl: '[redacted]',
        nested: [{ BlobURL: '[redacted]', keep: 'y' }]
      })
      expect(entry.requestBody).toEqual({ blobUrl: '[redacted]' })
    })

    it('redacts blobUrl in unparseable (truncated) JSON text', async () => {
      const big = `{"blobUrl":"https://blob.test/a","pad":"${'x'.repeat(100_001)}"}`
      fetchMock.mockResolvedValue(new Response(big, { status: 200 }))

      await apiLogging.fetchWithApiLogging('https://api.test/a', {})

      const [entry] = readEntries()
      expect(typeof entry.responseBody).toBe('string')
      expect(entry.responseBody as string).toContain('"blobUrl":"[redacted]"')
      expect(entry.responseBody as string).toMatch(/\.\.\.\[truncated\]$/)
    })

    it('strips SAS signature query strings from url and bodies', async () => {
      const signed =
        'https://store.blob.core.windows.net/c/file.zip?sv=2020&se=x&sig=abc%3D'
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            link: signed,
            message: `Download from ${signed} now`,
            unsigned: 'https://example.test/page?x=1'
          }),
          { status: 200 }
        )
      )

      await apiLogging.fetchWithApiLogging(
        signed,
        {},
        { operation: 'download' }
      )

      const [entry] = readEntries()
      const expected =
        'https://store.blob.core.windows.net/c/file.zip?[redacted]'
      expect(entry.url).toBe(expected)
      expect(entry.responseBody).toEqual({
        link: expected,
        message: `Download from ${expected} now`,
        unsigned: 'https://example.test/page?x=1'
      })
      expect(JSON.stringify(entry)).not.toContain('sig=')
    })

    it('describes non-string request bodies without dumping them', async () => {
      fetchMock.mockImplementation(
        async () => new Response('', { status: 200 })
      )

      const form = new FormData()
      form.append('file', new Blob(['zip']), 'a.zip')
      await apiLogging.fetchWithApiLogging('https://api.test/1', {
        method: 'POST',
        body: form
      })
      await apiLogging.fetchWithApiLogging('https://api.test/2', {
        method: 'POST',
        body: new Blob(['abc'])
      })
      await apiLogging.fetchWithApiLogging('https://api.test/3', {
        method: 'POST',
        body: new URLSearchParams({ a: 'b' })
      })
      await apiLogging.fetchWithApiLogging('https://api.test/4', {
        method: 'POST',
        body: new ArrayBuffer(4)
      })
      await apiLogging.fetchWithApiLogging('https://api.test/5', {
        method: 'POST',
        body: new Uint8Array(2)
      })

      expect(readEntries().map((e) => e.requestBody)).toEqual([
        '[form-data]',
        '[blob size=3]',
        'a=b',
        '[array-buffer byteLength=4]',
        '[request-body type=[object Uint8Array]]'
      ])
    })

    it('logs and rethrows fetch rejections', async () => {
      const failure = new TypeError('fetch failed')
      fetchMock.mockRejectedValue(failure)

      await expect(
        apiLogging.fetchWithApiLogging(
          'https://api.test/x',
          { method: 'DELETE' },
          { operation: 'boom' }
        )
      ).rejects.toBe(failure)

      const [entry] = readEntries()
      expect(entry).toMatchObject({
        operation: 'boom',
        method: 'DELETE',
        url: 'https://api.test/x',
        error: 'fetch failed'
      })
      expect(entry.status).toBeUndefined()
    })

    it('logs non-Error rejections as strings', async () => {
      fetchMock.mockRejectedValue('weird')
      await expect(
        apiLogging.fetchWithApiLogging('https://api.test/x', {})
      ).rejects.toBe('weird')
      expect(readEntries()[0].error).toBe('weird')
    })

    it('records a placeholder when the response body cannot be read', async () => {
      const fakeResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        clone: () => ({
          text: () => Promise.reject(new Error('stream broken'))
        })
      } as unknown as Response
      fetchMock.mockResolvedValue(fakeResponse)

      await expect(
        apiLogging.fetchWithApiLogging('https://api.test/x', {})
      ).resolves.toBe(fakeResponse)
      expect(readEntries()[0].responseBody).toBe(
        '[response-body read failed: Error: stream broken]'
      )
    })

    it('skips upload when the log file is empty', async () => {
      await apiLogging.uploadApiLogArtifactIfAvailable()
      expect(uploadArtifact).not.toHaveBeenCalled()
    })

    it('uploads the log file as an artifact when it has content', async () => {
      fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
      await apiLogging.fetchWithApiLogging('https://api.test/x', {})

      await apiLogging.uploadApiLogArtifactIfAvailable()

      const logPath = apiLogging.getApiLogPath()
      expect(uploadArtifact).toHaveBeenCalledWith(
        'my-artifact',
        [logPath],
        tempDir,
        { retentionDays: 30 }
      )
    })
  })
})
