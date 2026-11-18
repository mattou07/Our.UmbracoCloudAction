import { jest } from '@jest/globals'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  ERROR_BODIES,
  SIGNED_LOGS,
  STATUS_MESSAGES,
  failedDeployment
} from '../fixtures/umbraco-cloud-responses.js'

const sleepMock = jest.fn<(ms: number) => Promise<void>>()
const info = jest.fn()
const warning = jest.fn()

jest.unstable_mockModule('@actions/core', () => ({
  info,
  warning,
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
    info.mockReset()
    warning.mockReset()
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

    it('strips SAS signatures from status message links', async () => {
      fetchMock.mockResolvedValue(
        json({
          deploymentId: 'd1',
          deploymentState: 'Failed',
          deploymentStatusMessages: [
            {
              timestampUtc: 't1',
              message:
                'Error restoring packages. Restore log: https://logs.blob.core.windows.net/logs/d1/restore.txt?sv=2025-07-05&se=2027-02-04&sr=b&sp=r&sig=AbC%2Bsecret%3D'
            },
            {
              timestampUtc: 't2',
              message: 'See https://docs.umbraco.com/page?tab=cloud'
            }
          ]
        })
      )

      const data = await api().getDeploymentStatus('d1')

      expect(data.deploymentStatusMessages[0].message).toBe(
        'Error restoring packages. Restore log: https://logs.blob.core.windows.net/logs/d1/restore.txt?[redacted]'
      )
      expect(JSON.stringify(data)).not.toContain('sig=')
      // Unsigned links are left alone
      expect(data.deploymentStatusMessages[1].message).toBe(
        'See https://docs.umbraco.com/page?tab=cloud'
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
      ).rejects.toMatchObject({
        name: 'UploadTimeoutError',
        message:
          'Artifact upload timed out after 1 attempt(s) of 5ms each. Increase the upload-timeout input (milliseconds) or reduce the artifact size.',
        cause: expect.objectContaining({ name: 'AbortError' })
      })
    })

    it('explains the timeout after every attempt timed out', async () => {
      const abort = new Error('This operation was aborted')
      abort.name = 'AbortError'
      fetchMock.mockRejectedValue(abort)

      await expect(
        api({ uploadRetries: 2 }).addDeploymentArtifact(zipPath)
      ).rejects.toThrow(
        'Artifact upload timed out after 2 attempt(s) of 60000ms each. Increase the upload-timeout input'
      )
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('rejects artifacts over the Cloud size limit before uploading', async () => {
      const bigPath = path.join(tempDir, 'big.zip')
      const fd = fs.openSync(bigPath, 'w')
      try {
        // Sparse: no real disk space is used
        fs.ftruncateSync(fd, mod.MAX_ARTIFACT_SIZE_BYTES + 1024 * 1024)
      } finally {
        fs.closeSync(fd)
      }

      const err = await api()
        .addDeploymentArtifact(bigPath)
        .catch((e) => e)

      expect(err.message).toContain('is 257.0 MB (269484032 bytes)')
      expect(err.message).toContain(
        "exceeds Umbraco Cloud's upload limit of 256.0 MB (268435456 bytes)"
      )
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('accepts a file exactly at the size limit', async () => {
      expect(mod.MAX_ARTIFACT_SIZE_BYTES).toBe(268435456)
      fetchMock.mockResolvedValue(json({ artifactId: 'art-1' }))
      await expect(api().addDeploymentArtifact(zipPath)).resolves.toBe('art-1')
    })

    it('summarises the validation error Cloud returns for an oversized body', async () => {
      fetchMock.mockResolvedValue(json(ERROR_BODIES.artifactTooLarge400, 400))

      const err = await api()
        .addDeploymentArtifact(zipPath)
        .catch((e) => e)

      expect(err.message).toBe(
        'Failed to upload artifact: 400 - Failed to read the request form. Multipart body length limit 268435456 exceeded.'
      )
      expect(err.body).toBe(JSON.stringify(ERROR_BODIES.artifactTooLarge400))
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
      expect(warning).toHaveBeenCalledWith(
        'Changes endpoint not responding (attempt 1/3). Retrying in 0.05 seconds...'
      )
    })

    it('reports a 429 as rate limiting, not an unresponsive endpoint', async () => {
      fetchMock
        .mockResolvedValueOnce(json(ERROR_BODIES.rateLimited429, 429))
        .mockResolvedValueOnce(text('diff', 200))

      await expect(api().getChangesById('d1', 'live', 3, 50)).resolves.toEqual({
        changes: 'diff'
      })
      // Body hint "Try again in 2 seconds" + 1s buffer
      expect(sleepMock.mock.calls.map((c) => c[0])).toEqual([3000])
      expect(warning).toHaveBeenCalledWith(
        'Rate limited by Umbraco Cloud (attempt 1/3). Retrying in 3s...'
      )
      expect(String(warning.mock.calls[0][0])).not.toContain('not responding')
    })

    it('exposes CloudNullDeployment structurally and in the message', async () => {
      fetchMock.mockResolvedValue(
        json(ERROR_BODIES.cloudNullDeployment409, 409)
      )

      const err = await api()
        .getChangesById('d1', 'live')
        .catch((e) => e)

      expect(err).toBeInstanceOf(mod.UmbracoCloudApiError)
      expect(err.status).toBe(409)
      expect(err.problemType).toBe('CloudNullDeployment')
      expect(err.title).toBe('Deployment did not make any changes to cloud')
      expect(err.message).toBe(
        `Failed to get changes: 409 - CloudNullDeployment: ${ERROR_BODIES.cloudNullDeployment409.detail}`
      )
      expect(fetchMock).toHaveBeenCalledTimes(1)
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

      // No terminal message naming d1, so the trailing context includes t6
      await expect(api().getDeploymentErrorDetails('d1')).resolves.toEqual([
        '[t2] Build FAILED',
        '[t3] An error occurred',
        '[t4] NullReferenceException thrown',
        '[t5] Cannot apply update because the following packages would be downgraded: Package: Umbraco.Cms',
        '[t6] Deployment pending'
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

  describe('error messages', () => {
    const request = {
      targetEnvironmentAlias: 'live',
      artifactId: 'art-1',
      commitMessage: 'msg',
      noBuildAndRestore: false,
      skipVersionCheck: false
    }

    it('summarises the gateway {statusCode, message} format', async () => {
      fetchMock.mockResolvedValue(json(ERROR_BODIES.invalidApiKey401, 401))

      const err = await api()
        .startDeployment(request)
        .catch((e) => e)

      expect(err.message).toBe(
        `Failed to start deployment: 401 - ${ERROR_BODIES.invalidApiKey401.message}`
      )
      expect(err.status).toBe(401)
      expect(err.body).toBe(JSON.stringify(ERROR_BODIES.invalidApiKey401))
      expect(err.problemType).toBeUndefined()
    })

    it('flattens pretty-printed problem details to one line', async () => {
      fetchMock.mockResolvedValue(
        text(ERROR_BODIES.wrongProject401Text, 401, 'Unauthorized')
      )

      const err = await api()
        .startDeployment(request)
        .catch((e) => e)

      expect(err.message).toBe(
        'Failed to start deployment: 401 Unauthorized - Provided Umbraco-Cloud-Api-Key does not give access to manage specified projectId'
      )
      expect(err.message).not.toContain('\n')
      // URL types are not repeated in the message, but kept structurally
      expect(err.problemType).toBe(
        'https://tools.ietf.org/html/rfc7235#section-3.1'
      )
      expect(err.title).toBe('Unauthorized')
      expect(err.body).toBe(ERROR_BODIES.wrongProject401Text)
    })

    it('falls back to the title, then to the collapsed raw body', async () => {
      fetchMock
        .mockResolvedValueOnce(
          json({ title: 'Only a title', status: 400 }, 400)
        )
        .mockResolvedValueOnce(text('  line one\n\n  line two ', 400))
        .mockResolvedValueOnce(text('', 404))

      const messages: string[] = []
      for (let i = 0; i < 3; i++) {
        messages.push(
          await api()
            .getDeployments()
            .catch((e: Error) => e.message)
            .then(String)
        )
      }
      expect(messages).toEqual([
        'Failed to get deployments: 400 - Only a title',
        'Failed to get deployments: 400 - line one line two',
        'Failed to get deployments: 404 - (empty response body)'
      ])
    })

    it('truncates very long bodies', async () => {
      fetchMock.mockResolvedValue(text('x'.repeat(5000), 400))
      const err = await api()
        .getDeployments()
        .catch((e) => e)
      expect(err.message.length).toBeLessThan(600)
      expect(err.body).toHaveLength(5000)
    })

    it('sends a mixed-case alias as given and surfaces Cloud detail on a 400', async () => {
      fetchMock.mockResolvedValue(json(ERROR_BODIES.unknownAlias400, 400))

      await expect(
        api().startDeployment({ ...request, targetEnvironmentAlias: 'Live' })
      ).rejects.toThrow('No environments matches the provided alias nope')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(
        JSON.parse(calledInit(0).body as string).targetEnvironmentAlias
      ).toBe('Live')
    })

    it('does not retry getChangesById with a lowercase alias on a 400', async () => {
      fetchMock.mockResolvedValue(
        json({ title: 'Target not recognised', status: 400 }, 400)
      )

      await expect(api().getChangesById('d1', 'Live')).rejects.toMatchObject({
        status: 400
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(calledUrl(0)).toContain('targetEnvironmentAlias=Live')
    })

    it('keeps the alias wording in the message for a lowercase alias', async () => {
      fetchMock.mockResolvedValue(json(ERROR_BODIES.unknownAlias400, 400))

      await expect(api().startDeployment(request)).rejects.toThrow(
        'No environments matches the provided alias nope'
      )
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('startDeployment with a running deployment', () => {
    const request = {
      targetEnvironmentAlias: 'live',
      artifactId: 'art-1',
      commitMessage: 'msg',
      noBuildAndRestore: false,
      skipVersionCheck: false
    }
    const list = (...states: string[]) =>
      json({
        data: states.map((state, i) => ({ id: `d${i}`, state })),
        totalItems: states.length
      })

    it('waits and retries while a deployment is listed as running', async () => {
      fetchMock
        .mockResolvedValueOnce(json(ERROR_BODIES.deploymentInProgress409, 409))
        .mockResolvedValueOnce(list('InProgress', 'Completed'))
        .mockResolvedValueOnce(json(ERROR_BODIES.deploymentInProgress409, 409))
        .mockResolvedValueOnce(list('Queued'))
        .mockResolvedValueOnce(json({ deploymentId: 'dep-9' }, 201))

      await expect(
        api().startDeployment(request, {
          waitForRunningDeploymentMs: 600000,
          pollIntervalMs: 30000
        })
      ).resolves.toBe('dep-9')

      expect(sleepMock.mock.calls.map((c) => c[0])).toEqual([30000, 30000])
      expect(calledUrl(1)).toBe(
        `${BASE}/deployments?skip=0&take=5&includeNullDeployments=true&targetEnvironmentAlias=live`
      )
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining(
          'Another deployment is in progress on live; waiting 30s before retrying'
        )
      )
    })

    it('decides on the deployment list, not on the 409 wording', async () => {
      fetchMock
        .mockResolvedValueOnce(
          json({ title: 'Busy', status: 409, detail: 'Try later, friend' }, 409)
        )
        .mockResolvedValueOnce(list('Pending'))
        .mockResolvedValueOnce(json({ deploymentId: 'dep-1' }, 201))

      await expect(
        api().startDeployment(request, { waitForRunningDeploymentMs: 60000 })
      ).resolves.toBe('dep-1')
      expect(sleepMock.mock.calls.map((c) => c[0])).toEqual([30000])
    })

    it('throws a 409 at once when nothing is running', async () => {
      fetchMock
        .mockResolvedValueOnce(json(ERROR_BODIES.deploymentInProgress409, 409))
        .mockResolvedValueOnce(list('Completed', 'Failed'))

      const err = await api()
        .startDeployment(request, { waitForRunningDeploymentMs: 600000 })
        .catch((e) => e)

      expect(err.status).toBe(409)
      expect(err.message).toContain('existing deployment in progress')
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(sleepMock).not.toHaveBeenCalled()
    })

    it('throws a 409 at once when the running check itself fails', async () => {
      fetchMock
        .mockResolvedValueOnce(json(ERROR_BODIES.deploymentInProgress409, 409))
        .mockResolvedValueOnce(text('nope', 400))
        .mockResolvedValueOnce(text('nope', 400))

      await expect(
        api().startDeployment(request, { waitForRunningDeploymentMs: 600000 })
      ).rejects.toMatchObject({ status: 409 })
      // falls back to listing without the alias filter
      expect(calledUrl(2)).toBe(
        `${BASE}/deployments?skip=0&take=5&includeNullDeployments=true`
      )
      expect(sleepMock).not.toHaveBeenCalled()
    })

    it('does not wait by default', async () => {
      fetchMock.mockResolvedValue(
        json(ERROR_BODIES.deploymentInProgress409, 409)
      )

      await expect(api().startDeployment(request)).rejects.toMatchObject({
        status: 409
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('gives up with advice once the wait is used up', async () => {
      fetchMock.mockImplementation(async (_url, init) =>
        init?.method === 'POST'
          ? json(ERROR_BODIES.deploymentInProgress409, 409)
          : list('InProgress')
      )

      const err = await api()
        .startDeployment(request, {
          waitForRunningDeploymentMs: 120000,
          pollIntervalMs: 30000
        })
        .catch((e) => e)

      expect(sleepMock.mock.calls.map((c) => c[0])).toEqual([
        30000, 30000, 30000, 30000
      ])
      expect(err).toBeInstanceOf(mod.UmbracoCloudApiError)
      expect(err.status).toBe(409)
      expect(err.message).toMatch(
        /^Another deployment was still in progress after waiting 2 minutes\. Use a `concurrency:` group in your workflow to serialise deployments\./
      )
    })

    it('retries a 429 with neither Retry-After nor a body hint using back-off', async () => {
      fetchMock
        .mockResolvedValueOnce(text('busy', 429))
        .mockResolvedValueOnce(text('busy', 429))
        .mockResolvedValueOnce(json({ deploymentId: 'dep-1' }, 201))

      await expect(
        api({ rateLimitBaseDelayMs: 10 }).startDeployment(request)
      ).resolves.toBe('dep-1')
      expect(sleepMock.mock.calls.map((c) => c[0])).toEqual([10, 20])
    })
  })

  describe('getDeploymentErrorDetails with real Cloud messages', () => {
    const idOf = (messages: string[]) =>
      messages[messages.length - 1].split(' ')[1]

    it.each([
      [
        'missingUmbracoFile',
        ['Incoming package has no .umbraco file in its root']
      ],
      ['invalidUmbracoBase', ['in the .umbraco file does not exist.']],
      ['downgrade', ['packages would be downgraded']],
      [
        'buildError',
        [
          'Error building project. Build log: https://',
          'DotnetBuild.txt?[redacted]'
        ]
      ],
      [
        'restoreError',
        [
          'Error restoring packages. Restore log: https://',
          'NugetRestore.txt?[redacted]'
        ]
      ],
      [
        'kuduBuildFailedAfterPush',
        [
          "Broken.cs(2,26): error CS1519: Invalid token 'this' in a member declaration",
          'Unable to verify Deployment has finished'
        ]
      ]
    ] as const)('surfaces the real cause for %s', async (name, expected) => {
      const messages = STATUS_MESSAGES[name]
      const id = idOf(messages)
      fetchMock.mockResolvedValue(json(failedDeployment(id, messages)))

      const details = await api().getDeploymentErrorDetails(id)
      const joined = details.join('\n')

      for (const fragment of expected) {
        expect(joined).toContain(fragment)
      }
      expect(joined).not.toContain(`Deployment ${id} failed`)
      expect(joined).not.toContain('No changes to deploy')
      expect(joined).not.toContain('Git Commit')
      expect(joined).not.toContain('sig=')
      expect(new Set(details).size).toBe(details.length)
    })

    it('keeps only the error lines of a multi-line Kudu message', async () => {
      const messages = STATUS_MESSAGES.kuduBuildFailedAfterPush
      const id = idOf(messages)
      fetchMock.mockResolvedValue(json(failedDeployment(id, messages, true)))

      const details = await api().getDeploymentErrorDetails(id)

      expect(details.join('\n')).not.toContain('Restored C:')
      expect(details).toEqual([
        "[2026-11-06T17:00:05.000Z] C:\\home\\site\\repository\\src\\Contoso.Core\\Broken.cs(2,26): error CS1519: Invalid token 'this' in a member declaration [C:\\home\\site\\repository\\src\\Contoso.Core\\Contoso.Core.csproj]",
        '[2026-11-06T17:00:06.000Z] Notifying kudu deployment script failed',
        '[2026-11-06T17:00:08.000Z] KUDU: Deployment Failed',
        '[2026-11-06T17:00:10.000Z] Unable to verify Deployment has finished'
      ])
    })

    it('surfaces reworded failures with no error keywords', async () => {
      const id = 'abc-123'
      fetchMock.mockResolvedValue(
        json(
          failedDeployment(id, [
            'Git Commit',
            'Package root lacks a project descriptor',
            `Rollout ${id} ended unsuccessfully`
          ])
        )
      )

      await expect(api().getDeploymentErrorDetails(id)).resolves.toEqual([
        '[2026-11-06T17:00:01.000Z] Package root lacks a project descriptor'
      ])
    })
  })

  describe('getFailureLogExcerpts', () => {
    const buildId = 'aaaaaaaa-0000-4000-8000-000000000001'
    const restoreId = 'aaaaaaaa-0000-4000-8000-000000000002'

    it('captures the signed build log but returns a redacted status', async () => {
      fetchMock
        .mockResolvedValueOnce(
          json(failedDeployment(buildId, STATUS_MESSAGES.buildError))
        )
        .mockResolvedValueOnce(text(SIGNED_LOGS.build, 200))

      const client = api()
      const status = await client.getDeploymentStatus(buildId)
      const serialised = JSON.stringify(status)
      expect(serialised).toContain('DotnetBuild.txt?[redacted]')
      expect(serialised).not.toContain('sig=')

      const excerpts = await client.getFailureLogExcerpts(buildId)

      expect(excerpts).toEqual([
        {
          name: 'DotnetBuild.txt',
          lines: [
            "/app/work/repository/src/Contoso.Core/Broken.cs(2,26): error CS1519: Invalid token 'this' in a member declaration [/app/work/repository/src/Contoso.Core/Contoso.Core.csproj]",
            'Build FAILED.',
            '1 Error(s)'
          ]
        }
      ])
      // Fetched the signed link directly, without the Cloud API key
      expect(calledUrl(1)).toContain('sig=SYNTHETICbuild')
      expect(JSON.stringify(calledInit(1)?.headers ?? {})).not.toContain(
        'key-1'
      )
    })

    it('captures the signed restore log and finds the NuGet error', async () => {
      fetchMock
        .mockResolvedValueOnce(
          json(failedDeployment(restoreId, STATUS_MESSAGES.restoreError))
        )
        .mockResolvedValueOnce(text(SIGNED_LOGS.restore, 200))

      const client = api()
      await client.getDeploymentStatus(restoreId)
      const excerpts = await client.getFailureLogExcerpts(restoreId, 1)

      expect(excerpts).toHaveLength(1)
      expect(excerpts[0].name).toBe('NugetRestore.txt')
      expect(excerpts[0].lines).toEqual([
        expect.stringContaining(
          'error NU1101: Unable to find package Contoso.DoesNotExist'
        )
      ])
    })

    it('returns [] when fetching the log fails', async () => {
      fetchMock
        .mockResolvedValueOnce(
          json(failedDeployment(restoreId, STATUS_MESSAGES.restoreError))
        )
        .mockRejectedValueOnce(new TypeError('fetch failed'))

      const client = api()
      await client.getDeploymentStatus(restoreId)
      await expect(client.getFailureLogExcerpts(restoreId)).resolves.toEqual([])
    })

    it('returns [] when the log host answers with an error', async () => {
      fetchMock
        .mockResolvedValueOnce(
          json(failedDeployment(restoreId, STATUS_MESSAGES.restoreError))
        )
        .mockResolvedValueOnce(text('AuthenticationFailed', 403))

      const client = api()
      await client.getDeploymentStatus(restoreId)
      await expect(client.getFailureLogExcerpts(restoreId)).resolves.toEqual([])
    })

    it('ignores non-blob and unsigned URLs', async () => {
      fetchMock.mockResolvedValueOnce(
        json(
          failedDeployment('d1', [
            'Log: https://logs.example.com/log.txt?sig=abc',
            'Log: https://acct.blob.core.windows.net/logs/x.txt?sv=1',
            'Deployment d1 failed'
          ])
        )
      )

      const client = api()
      await client.getDeploymentStatus('d1')
      await expect(client.getFailureLogExcerpts('d1')).resolves.toEqual([])
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('gives up on a log host that never answers', async () => {
      fetchMock.mockResolvedValueOnce(
        json(failedDeployment('d1', STATUS_MESSAGES.buildError))
      )
      const client = api()
      await client.getDeploymentStatus('d1')
      fetchMock.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () =>
              reject(new Error('aborted'))
            )
          })
      )

      jest.useFakeTimers()
      try {
        const pending = client.getFailureLogExcerpts('d1')
        await jest.advanceTimersByTimeAsync(15000)
        await expect(pending).resolves.toEqual([])
      } finally {
        jest.useRealTimers()
      }
      expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(true)
    })

    it('returns [] for a deployment it has not seen', async () => {
      await expect(api().getFailureLogExcerpts('unknown')).resolves.toEqual([])
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('parseErrorBody', () => {
    it('treats a missing body as empty', () => {
      expect(mod.parseErrorBody(undefined as unknown as string).summary).toBe(
        '(empty response body)'
      )
    })

    it('falls back to the title when errors hold no messages', () => {
      const parsed = mod.parseErrorBody(
        JSON.stringify({ title: 'Bad thing', errors: { name: ['  '] } })
      )
      expect(parsed.summary).toBe('Bad thing')
      expect(parsed.title).toBe('Bad thing')
    })

    it('flattens validation errors when there is no detail', () => {
      expect(
        mod.parseErrorBody(
          JSON.stringify({ errors: { name: ['too short'], other: 'bad' } })
        ).summary
      ).toBe('too short; bad')
    })
  })

  describe('formatDuration', () => {
    it.each([
      [0, '0s'],
      [-5000, '0s'],
      [45000, '45s'],
      [65000, '1m 05s'],
      [3723000, '1h 02m 03s']
    ])('formats %ims as %s', (ms, expected) => {
      expect(mod.formatDuration(ms)).toBe(expected)
    })
  })

  describe('defaults and edge cases', () => {
    it('can be constructed without options', async () => {
      fetchMock.mockResolvedValue(json({ deploymentId: 'dep-1' }, 201))
      const client = new mod.UmbracoCloudAPI('proj-1', 'key-1')
      await expect(
        client.startDeployment({
          targetEnvironmentAlias: 'live',
          artifactId: 'a',
          commitMessage: 'm',
          noBuildAndRestore: false,
          skipVersionCheck: false
        })
      ).resolves.toBe('dep-1')
    })

    it('does not wait on a 409 when the deployment list has no data', async () => {
      fetchMock
        .mockResolvedValueOnce(json(ERROR_BODIES.deploymentInProgress409, 409))
        .mockResolvedValueOnce(json({}))

      await expect(
        api().startDeployment(
          {
            targetEnvironmentAlias: 'live',
            artifactId: 'a',
            commitMessage: 'm',
            noBuildAndRestore: false,
            skipVersionCheck: false
          },
          { waitForRunningDeploymentMs: 60000 }
        )
      ).rejects.toMatchObject({ status: 409 })
      expect(sleepMock).not.toHaveBeenCalled()
    })

    it('uses the singular "minute" and omits a missing title while waiting', async () => {
      fetchMock.mockImplementation(async (_url, init) =>
        init?.method === 'POST'
          ? json({ message: 'Another deployment is running' }, 409)
          : json({ data: [{ id: 'd0', state: 'InProgress' }], totalItems: 1 })
      )

      const err = await api()
        .startDeployment(
          {
            targetEnvironmentAlias: 'live',
            artifactId: 'a',
            commitMessage: 'm',
            noBuildAndRestore: false,
            skipVersionCheck: false
          },
          { waitForRunningDeploymentMs: 60000, pollIntervalMs: 60000 }
        )
        .catch((e) => e)

      expect(err.message).toContain('after waiting 1 minute. ')
      expect(info).toHaveBeenCalledWith(
        'Another deployment is in progress on live; waiting 60s before retrying…'
      )
    })

    it('tolerates status messages without text', async () => {
      fetchMock.mockResolvedValue(
        json({
          deploymentState: 'InProgress',
          deploymentStatusMessages: [{ timestampUtc: 't1' }]
        })
      )

      const status = await api().getDeploymentStatus('d1')

      expect(status.deploymentStatusMessages).toEqual([
        { timestampUtc: 't1', message: '' }
      ])
    })

    it('names the upload after the file, falling back for a path without one', async () => {
      fetchMock.mockResolvedValue(json({ artifactId: 'art-1' }))
      const root = path.parse(os.tmpdir()).root
      await api().addDeploymentArtifact(root)
      const form = calledInit().body as FormData
      expect((form.get('file') as File).name).toBe('artifact.zip')
    })

    it('reports each distinct error message once', async () => {
      fetchMock.mockResolvedValue(
        json({
          deploymentStatusMessages: [
            { timestampUtc: 't1', message: 'Package A could not be found' },
            { timestampUtc: 't2', message: 'Package A could not be found' },
            { timestampUtc: 't3', message: 'Deployment d1 failed' }
          ]
        })
      )

      await expect(api().getDeploymentErrorDetails('d1')).resolves.toEqual([
        '[t1] Package A could not be found'
      ])
    })

    it('keeps every line of a multi-line message that has no error line', async () => {
      fetchMock.mockResolvedValue(
        json({
          deploymentStatusMessages: [
            { timestampUtc: 't1', message: 'Step one\nStep two' },
            { timestampUtc: 't2', message: 'Deployment d1 failed' }
          ]
        })
      )

      await expect(api().getDeploymentErrorDetails('d1')).resolves.toEqual([
        '[t1] Step one\nStep two'
      ])
    })

    it('names a log without a path "log" and keeps a bare id as the name', async () => {
      const uuid = 'aaaaaaaa-0000-4000-8000-000000000001'
      fetchMock
        .mockResolvedValueOnce(
          json(
            failedDeployment('d1', [
              'Log: https://acct.blob.core.windows.net/?sig=a',
              `Log: https://acct.blob.core.windows.net/logs/${uuid}-?sig=b`,
              'Deployment d1 failed'
            ])
          )
        )
        .mockImplementation(async () => text('error CS0001: broken', 200))

      const client = api()
      await client.getDeploymentStatus('d1')
      const excerpts = await client.getFailureLogExcerpts('d1')

      expect(excerpts.map((e) => e.name)).toEqual(['log', `${uuid}-`])
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
