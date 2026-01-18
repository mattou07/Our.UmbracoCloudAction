import { jest } from '@jest/globals'

// ESM mock setup
jest.unstable_mockModule('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn()
}))

// Helper to create a mock Response object
function createMockResponse({
  ok,
  status,
  statusText,
  json
}: {
  ok: boolean
  status: number
  statusText: string
  json: () => Promise<any>
}): Response {
  return {
    ok,
    status,
    statusText,
    json,
    headers: new Headers(),
    redirected: false,
    type: 'basic',
    url: '',
    clone: () => ({}) as Response,
    body: null,
    bodyUsed: false,
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob([]),
    formData: async () => new FormData(),
    text: async () => ''
  } as Response
}

const mockFetch = jest.fn() as any
global.fetch = mockFetch

describe('pollDeploymentStatus', () => {
  let core: any
  let pollDeploymentStatus: any
  const validResponse = {
    deploymentId: 'dep-123',
    deploymentState: 'Completed',
    modifiedUtc: '2025-09-03T12:00:00Z',
    deploymentStatusMessages: [
      { timestampUtc: '2025-09-03T12:00:00Z', message: 'Deployment started' },
      { timestampUtc: '2025-09-03T12:01:00Z', message: 'Deployment completed' }
    ]
  }

  beforeAll(async () => {
    core = await import('@actions/core')
    pollDeploymentStatus = (
      await import('../../src/utils/deployment-polling.js')
    ).pollDeploymentStatus
  })
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  test('returns deployment response when completed', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => validResponse
      })
    )
    const promise = pollDeploymentStatus('key', 'proj', 'dep', 1000, 10)
    jest.advanceTimersByTime(10)
    const result = await promise
    expect(result.deploymentState).toBe('Completed')
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('Deployment status: Completed')
    )
  })

  test('retries on 401 Unauthorized', async () => {
    jest.setTimeout(10000)
    mockFetch
      .mockResolvedValueOnce(
        createMockResponse({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: async () => ({})
        })
      )
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => validResponse
        })
      )
    const promise = pollDeploymentStatus('key', 'proj', 'dep', 1000, 10)
    await jest.advanceTimersByTimeAsync(20) // enough for one retry
    await Promise.resolve()
    const result = await promise
    expect(core.warning).toHaveBeenCalledWith(
      'Unauthorized: The API key may have expired or lost permissions. Will retry.'
    )
    expect(result.deploymentState).toBe('Completed')
  })

  test('retries on 404 Not Found', async () => {
    jest.setTimeout(10000)
    mockFetch
      .mockResolvedValueOnce(
        createMockResponse({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: async () => ({})
        })
      )
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => validResponse
        })
      )
    const promise = pollDeploymentStatus('key', 'proj', 'dep', 1000, 10)
    await jest.advanceTimersByTimeAsync(20) // enough for one retry
    await Promise.resolve()
    const result = await promise
    expect(core.warning).toHaveBeenCalledWith(
      'Not Found: The project or deployment ID could not be found. Will retry.'
    )
    expect(result.deploymentState).toBe('Completed')
  })

  test('retries on network error', async () => {
    jest.setTimeout(10000)
    mockFetch
      .mockRejectedValueOnce(new Error('Network down'))
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => validResponse
        })
      )
    const promise = pollDeploymentStatus('key', 'proj', 'dep', 1000, 10)
    await jest.advanceTimersByTimeAsync(20) // enough for one retry
    await Promise.resolve()
    const result = await promise
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Network error while polling deployment status:')
    )
    expect(result.deploymentState).toBe('Completed')
  })

  test('warns if deployment is blocked by updating marker', async () => {
    jest.setTimeout(10000)
    const blockedResponse = {
      ...validResponse,
      deploymentState: 'InProgress',
      deploymentStatusMessages: [
        {
          timestampUtc: '2025-09-03T12:00:00Z',
          message:
            "The site can't be upgraded as it's blocked with the following markers: updating"
        }
      ]
    }
    mockFetch
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => blockedResponse
        })
      )
      .mockResolvedValueOnce(
        createMockResponse({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => validResponse
        })
      )
    const promise = pollDeploymentStatus('key', 'proj', 'dep', 1000, 10)
    await jest.advanceTimersByTimeAsync(20) // enough for one poll and one retry
    await Promise.resolve()
    const result = await promise
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'Deployment is blocked by leftover upgrade markers!'
      )
    )
    expect(result.deploymentState).toBe('Completed')
  })

  test('throws error if deployment does not complete in time', async () => {
    jest.setTimeout(10000)
    // Use real timers for this test since it relies on Date.now()
    jest.useRealTimers()

    mockFetch.mockResolvedValue(
      createMockResponse({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ ...validResponse, deploymentState: 'InProgress' })
      })
    )

    // Act & Assert - use very short timeout and interval to quickly trigger timeout
    await expect(
      pollDeploymentStatus('key', 'proj', 'dep', 10, 5) // 10ms max, 5ms interval
    ).rejects.toThrow('Deployment did not complete within the expected time.')

    // Restore fake timers for other tests
    jest.useFakeTimers()
  })

  test('returns DeploymentResponse type', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => validResponse
      })
    )
    const result = await pollDeploymentStatus('key', 'proj', 'dep', 1000, 10)
    expect(result).toHaveProperty('deploymentId')
    expect(result).toHaveProperty('deploymentState')
    expect(result).toHaveProperty('deploymentStatusMessages')
  })
})
