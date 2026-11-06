import { jest } from '@jest/globals'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const sleepMock = jest.fn<(ms: number) => Promise<void>>()

jest.unstable_mockModule('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
  error: jest.fn()
}))

jest.unstable_mockModule('../../src/utils/helpers.js', () => ({
  sleep: sleepMock
}))

type ApiModule = typeof import('../../src/api/umbraco-cloud-api.js')

const BASE = 'https://api.cloud.umbraco.com/v2/projects/proj-1'

function json(
  body: unknown,
  status = 200,
  headers?: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

function text(body: string, status: number, statusText = ''): Response {
  return new Response(body, { status, statusText })
}

describe('UmbracoCloudAPI', () => {
  let mod: ApiModule
  let fetchMock: jest.Mock<typeof fetch>
  const originalFetch = globalThis.fetch

  beforeAll(async () => {
    mod = await import('../../src/api/umbraco-cloud-api.js')
  })

  beforeEach(() => {
    fetchMock = jest.fn<typeof fetch>()
    globalThis.fetch = fetchMock
    sleepMock.mockReset()
    sleepMock.mockResolvedValue(undefined)
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  function api(options = {}) {
    return new mod.UmbracoCloudAPI('proj-1', 'key-1', options)
  }

  function calledUrl(i = 0): string {
    return fetchMock.mock.calls[i][0] as string
  }

  function calledInit(i = 0): RequestInit {
    return fetchMock.mock.calls[i][1] as RequestInit
  }

  describe('constructor', () => {
    it('uses the default base URL', async () => {
      fetchMock.mockResolvedValue(json({ deploymentState: 'Completed' }))
      await api().getDeploymentStatus('d1')
      expect(calledUrl()).toBe(`${BASE}/deployments/d1`)
      expect(calledInit().headers).toEqual({
        'Umbraco-Cloud-Api-Key': 'key-1',
        'Content-Type': 'application/json'
      })
    })

    it('uses a custom base URL and strips trailing slashes', async () => {
      fetchMock.mockResolvedValue(json({ deploymentState: 'Completed' }))
      await api({ baseUrl: 'https://custom.test//' }).getDeploymentStatus('d1')
      expect(calledUrl()).toBe(
        'https://custom.test/v2/projects/proj-1/deployments/d1'
      )
    })
  })

  describe('startDeployment', () => {
    const request = {
      targetEnvironmentAlias: 'Live',
      artifactId: 'art-1',
      commitMessage: 'msg',
      noBuildAndRestore: false,
      skipVersionCheck: false
    }

    it('posts the request body and returns the deployment id', async () => {
      fetchMock.mockResolvedValue(json({ deploymentId: 'dep-1' }, 201))

      await expect(api().startDeployment(request)).resolves.toBe('dep-1')

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(calledUrl()).toBe(`${BASE}/deployments`)
      expect(calledInit().method).toBe('POST')
      expect(JSON.parse(calledInit().body as string)).toEqual(request)
    })

    it('retries with a lowercase alias on an alias error', async () => {
      fetchMock
        .mockResolvedValueOnce(
          text('No environments matches the provided alias', 400)
        )
        .mockResolvedValueOnce(json({ deploymentId: 'dep-2' }))

      await expect(api().startDeployment(request)).resolves.toBe('dep-2')

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(
        JSON.parse(calledInit(1).body as string).targetEnvironmentAlias
      ).toBe('live')
    })

    it('does not retry when the alias is already lowercase', async () => {
      fetchMock.mockResolvedValue(
        text('Unable to resolve target environment by Alias', 400)
      )

      await expect(
        api().startDeployment({ ...request, targetEnvironmentAlias: 'live' })
      ).rejects.toThrow('Unable to resolve target environment by Alias')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('retries 429 honouring the Retry-After header', async () => {
      fetchMock
        .mockResolvedValueOnce(
          new Response('slow down', {
            status: 429,
            headers: { 'Retry-After': '2' }
          })
        )
        .mockResolvedValueOnce(json({ deploymentId: 'dep-3' }))

      await expect(api().startDeployment(request)).resolves.toBe('dep-3')
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(sleepMock).toHaveBeenCalledWith(3000)
    })

    it('parses the retry hint from the body and falls back to back-off', async () => {
      fetchMock
        .mockResolvedValueOnce(text('Try again in 5 seconds', 429))
        .mockResolvedValueOnce(text('nope', 429))
        .mockResolvedValueOnce(text('nope', 429))

      const err = await api({ rateLimitBaseDelayMs: 10 })
        .startDeployment(request)
        .catch((e) => e)

      expect(err).toBeInstanceOf(mod.UmbracoCloudApiError)
      expect(err.status).toBe(429)
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(sleepMock.mock.calls.map((c) => c[0])).toEqual([6000, 20])
    })

    it('throws UmbracoCloudApiError with status for other 4xx', async () => {
      fetchMock.mockResolvedValue(text('bad', 403, 'Forbidden'))

      const err = await api()
        .startDeployment(request)
        .catch((e) => e)

      expect(err).toBeInstanceOf(mod.UmbracoCloudApiError)
      expect(err.status).toBe(403)
      expect(err.body).toBe('bad')
      expect(err.message).toBe(
        'Failed to start deployment: 403 Forbidden - bad'
      )
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('getDeploymentStatus', () => {
    it('encodes lastModifiedUtc as a query parameter', async () => {
      const status = { deploymentId: 'd 1', deploymentState: 'InProgress' }
      fetchMock.mockResolvedValue(json(status))

      await expect(
        api().getDeploymentStatus('d 1', '2024-01-01T00:00:00+00:00')
      ).resolves.toEqual(status)

      expect(calledUrl()).toBe(
        `${BASE}/deployments/d%201?lastModifiedUtc=2024-01-01T00%3A00%3A00%2B00%3A00`
      )
    })
  })

  describe('addDeploymentArtifact', () => {
    let tempDir: string
    let zipPath: string

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbraco-api-test-'))
      zipPath = path.join(tempDir, 'site.zip')
      fs.writeFileSync(zipPath, 'PK fake zip contents')
    })

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true })
    })

    it('uploads the file as multipart and returns the artifact id', async () => {
      fetchMock.mockResolvedValue(json({ artifactId: 'art-1' }))

      await expect(
        api().addDeploymentArtifact(zipPath, 'desc', '1.0.0')
      ).resolves.toBe('art-1')

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(calledUrl()).toBe(`${BASE}/deployments/artifacts`)
      const init = calledInit()
      expect(init.method).toBe('POST')
      expect(init.headers).toEqual({ 'Umbraco-Cloud-Api-Key': 'key-1' })
      expect(init.signal).toBeInstanceOf(AbortSignal)
      const form = init.body as FormData
      expect(form.get('description')).toBe('desc')
      expect(form.get('version')).toBe('1.0.0')
      const file = form.get('file') as File
      expect(file.name).toBe('site.zip')
      expect(await file.text()).toBe('PK fake zip contents')
    })

    it('omits optional form fields', async () => {
      fetchMock.mockResolvedValue(json({ artifactId: 'art-1' }))
      await api().addDeploymentArtifact(zipPath)
      const form = calledInit().body as FormData
      expect(form.has('description')).toBe(false)
      expect(form.has('version')).toBe(false)
    })

    it('retries on 500 then succeeds with exponential delay', async () => {
      fetchMock
        .mockResolvedValueOnce(text('oops', 500))
        .mockResolvedValueOnce(text('oops', 502))
        .mockResolvedValueOnce(json({ artifactId: 'art-2' }))

      await expect(
        api({ uploadRetryDelayMs: 100 }).addDeploymentArtifact(zipPath)
      ).resolves.toBe('art-2')

      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(sleepMock.mock.calls.map((c) => c[0])).toEqual([100, 200])
    })

    it('honours Retry-After on 429', async () => {
      fetchMock
        .mockResolvedValueOnce(
          new Response('slow down', {
            status: 429,
            headers: { 'Retry-After': '7' }
          })
        )
        .mockResolvedValueOnce(json({ artifactId: 'art-3' }))

      await expect(
        api({ uploadRetryDelayMs: 100 }).addDeploymentArtifact(zipPath)
      ).resolves.toBe('art-3')
      expect(sleepMock.mock.calls.map((c) => c[0])).toEqual([8000])
    })

    it.each([400, 401])('does not retry on %i', async (status) => {
      fetchMock.mockResolvedValue(text('no', status))

      await expect(api().addDeploymentArtifact(zipPath)).rejects.toMatchObject({
        status
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(sleepMock).not.toHaveBeenCalled()
    })

    it('honours the uploadRetries option', async () => {
      fetchMock.mockImplementation(async () => text('down', 503))

      await expect(
        api({ uploadRetries: 2 }).addDeploymentArtifact(zipPath)
      ).rejects.toMatchObject({ status: 503 })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('retries when the upload times out (AbortError)', async () => {
      const abort = new Error('This operation was aborted')
      abort.name = 'AbortError'
      fetchMock
        .mockRejectedValueOnce(abort)
        .mockResolvedValueOnce(json({ artifactId: 'art-3' }))

      await expect(api().addDeploymentArtifact(zipPath)).resolves.toBe('art-3')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('aborts the request when the timeout elapses', async () => {
      fetchMock.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => {
              const e = new Error('aborted')
              e.name = 'AbortError'
              reject(e)
            })
          })
      )

      await expect(
        api({ uploadRetries: 1, uploadTimeoutMs: 5 }).addDeploymentArtifact(
          zipPath
        )
      ).rejects.toMatchObject({ name: 'AbortError' })
    })

    it('throws when the file does not exist', async () => {
      await expect(
        api().addDeploymentArtifact(path.join(tempDir, 'missing.zip'))
      ).rejects.toThrow('File does not exist')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('throws when no file path is given', async () => {
      await expect(api().addDeploymentArtifact('')).rejects.toThrow(
        'File path is required'
      )
    })
  })

  describe('getChangesById', () => {
    it('returns empty changes on 204', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

      await expect(api().getChangesById('d1', 'live')).resolves.toEqual({
        changes: ''
      })
      expect(calledUrl()).toBe(
        `${BASE}/deployments/d1/diff?targetEnvironmentAlias=live`
      )
    })

    it('returns the patch text on 200', async () => {
      fetchMock.mockResolvedValue(text('diff --git a b', 200))
      await expect(api().getChangesById('d1', 'live')).resolves.toEqual({
        changes: 'diff --git a b'
      })
    })

    it('retries 5xx up to maxRetries', async () => {
      fetchMock.mockImplementation(async () => text('down', 503))

      await expect(
        api().getChangesById('d1', 'live', 3, 50)
      ).rejects.toMatchObject({ status: 503 })
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(sleepMock.mock.calls.map((c) => c[0])).toEqual([50, 50])
    })

    it('honours Retry-After on 429 instead of the fixed delay', async () => {
      fetchMock
        .mockResolvedValueOnce(
          new Response('slow down', {
            status: 429,
            headers: { 'Retry-After': '4' }
          })
        )
        .mockResolvedValueOnce(text('diff', 200))

      await expect(api().getChangesById('d1', 'live', 3, 50)).resolves.toEqual({
        changes: 'diff'
      })
      expect(sleepMock.mock.calls.map((c) => c[0])).toEqual([5000])
    })

    it('recovers after a transient failure', async () => {
      fetchMock
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(text('patch', 200))
      await expect(api().getChangesById('d1', 'live')).resolves.toEqual({
        changes: 'patch'
      })
    })

    it('throws 409 immediately', async () => {
      fetchMock.mockResolvedValue(text('conflict', 409))
      await expect(api().getChangesById('d1', 'live')).rejects.toMatchObject({
        status: 409
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('retries with a lowercase alias', async () => {
      fetchMock
        .mockResolvedValueOnce(
          text('No environments matches the provided alias', 400)
        )
        .mockResolvedValueOnce(text('patch', 200))

      await expect(api().getChangesById('d1', 'Live')).resolves.toEqual({
        changes: 'patch'
      })
      expect(calledUrl(1)).toContain('targetEnvironmentAlias=live')
    })
  })

  describe('getLatestCompletedDeployment', () => {
    const page = (states: string[], totalItems: number, offset = 0) =>
      json({
        data: states.map((state, i) => ({ id: `d${offset + i}`, state })),
        totalItems
      })

    it('pages until a completed deployment is found', async () => {
      fetchMock
        .mockResolvedValueOnce(page(Array(10).fill('Failed'), 25))
        .mockResolvedValueOnce(
          page(['Failed', 'Completed', ...Array(8).fill('Failed')], 25, 10)
        )

      await expect(api().getLatestCompletedDeployment('live')).resolves.toBe(
        'd11'
      )

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(calledUrl(0)).toBe(
        `${BASE}/deployments?skip=0&take=10&includeNullDeployments=false&targetEnvironmentAlias=live`
      )
      expect(calledUrl(1)).toContain('skip=10&take=10')
    })

    it('returns null when the last page has no completed deployment', async () => {
      fetchMock
        .mockResolvedValueOnce(page(Array(10).fill('Failed'), 13))
        .mockResolvedValueOnce(page(['Failed', 'Failed', 'Failed'], 13, 10))

      await expect(
        api().getLatestCompletedDeployment('live')
      ).resolves.toBeNull()
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('stops when totalItems is reached on a full page', async () => {
      fetchMock.mockResolvedValueOnce(page(Array(10).fill('Failed'), 10))
      await expect(
        api().getLatestCompletedDeployment('live')
      ).resolves.toBeNull()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('getDeployments', () => {
    it('omits the alias when not given', async () => {
      fetchMock.mockResolvedValue(json({ data: [], totalItems: 0 }))
      await api().getDeployments()
      expect(calledUrl()).toBe(
        `${BASE}/deployments?skip=0&take=100&includeNullDeployments=true`
      )
    })
  })

  describe('getDeploymentErrorDetails', () => {
    it('returns messages that look like errors', async () => {
      fetchMock.mockResolvedValue(
        json({
          deploymentStatusMessages: [
            { timestampUtc: 't1', message: 'Build started' },
            { timestampUtc: 't2', message: 'Build FAILED' },
            { timestampUtc: 't3', message: 'An error occurred' },
            { timestampUtc: 't4', message: 'NullReferenceException thrown' },
            {
              timestampUtc: 't5',
              message:
                'Cannot apply update because the following packages would be downgraded: Package: Umbraco.Cms'
            },
            { timestampUtc: 't6', message: 'Deployment pending' }
          ]
        })
      )

      await expect(api().getDeploymentErrorDetails('d1')).resolves.toEqual([
        '[t2] Build FAILED',
        '[t3] An error occurred',
        '[t4] NullReferenceException thrown',
        '[t5] Cannot apply update because the following packages would be downgraded: Package: Umbraco.Cms'
      ])
      expect(calledUrl()).toBe(`${BASE}/deployments/d1`)
    })

    it('handles missing messages', async () => {
      fetchMock.mockResolvedValue(json({}))
      await expect(api().getDeploymentErrorDetails('d1')).resolves.toEqual([])
    })

    it('returns [] on API error', async () => {
      fetchMock.mockResolvedValue(text('nope', 404))
      await expect(api().getDeploymentErrorDetails('d1')).resolves.toEqual([])
    })
  })

  describe('isRetryableError', () => {
    const apiError = (status: number) =>
      new mod.UmbracoCloudApiError('x', status, '')

    it.each([429, 500, 503])('treats %i as retryable', (status) => {
      expect(mod.isRetryableError(apiError(status))).toBe(true)
    })

    it.each([400, 401, 404])('treats %i as not retryable', (status) => {
      expect(mod.isRetryableError(apiError(status))).toBe(false)
    })

    it('treats network and timeout errors as retryable', () => {
      const abort = new Error('aborted')
      abort.name = 'AbortError'
      expect(mod.isRetryableError(new TypeError('fetch failed'))).toBe(true)
      expect(mod.isRetryableError(abort)).toBe(true)
    })

    it('treats other values as not retryable', () => {
      expect(mod.isRetryableError(new Error('generic'))).toBe(false)
      expect(mod.isRetryableError('string')).toBe(false)
    })
  })
})
