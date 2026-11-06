import { jest } from '@jest/globals'
import type { DeploymentResponse } from '../../src/types/index.js'

const sleepMock = jest.fn<(ms: number) => Promise<void>>()
const warning = jest.fn()
const info = jest.fn()

jest.unstable_mockModule('@actions/core', () => ({
  info,
  warning,
  debug: jest.fn(),
  error: jest.fn()
}))

jest.unstable_mockModule('../../src/utils/helpers.js', () => ({
  sleep: sleepMock
}))

type PollingModule = typeof import('../../src/utils/deployment-polling.js')
type ApiModule = typeof import('../../src/api/umbraco-cloud-api.js')

function status(
  deploymentState: string,
  modifiedUtc = '',
  messages: string[] = []
): DeploymentResponse {
  return {
    deploymentId: 'dep-1',
    deploymentState,
    modifiedUtc,
    deploymentStatusMessages: messages.map((message, i) => ({
      timestampUtc: `t${i}`,
      message
    }))
  }
}

describe('pollDeploymentStatus', () => {
  let polling: PollingModule
  let apiModule: ApiModule
  let getDeploymentStatus: jest.Mock<
    (id: string, lastModifiedUtc?: string) => Promise<DeploymentResponse>
  >

  beforeAll(async () => {
    polling = await import('../../src/utils/deployment-polling.js')
    apiModule = await import('../../src/api/umbraco-cloud-api.js')
  })

  beforeEach(() => {
    getDeploymentStatus = jest.fn()
    sleepMock.mockReset()
    sleepMock.mockResolvedValue(undefined)
    warning.mockReset()
    info.mockReset()
  })

  function poll(maxDurationMs = 60_000, intervalMs = 1000) {
    return polling.pollDeploymentStatus(
      { getDeploymentStatus },
      'dep-1',
      maxDurationMs,
      intervalMs
    )
  }

  it('prints each status message once even when Cloud repeats the boundary message', async () => {
    // Cloud returns messages at-or-after lastModifiedUtc, so the last message
    // of one poll comes back as the first message of the next.
    const boundary = { timestampUtc: 't1', message: 'NuGet Restore' }
    getDeploymentStatus
      .mockResolvedValueOnce({
        ...status('InProgress', 't1'),
        deploymentStatusMessages: [
          { timestampUtc: 't0', message: 'Git Commit' },
          boundary
        ]
      })
      .mockResolvedValueOnce({
        ...status('InProgress', 't2'),
        deploymentStatusMessages: [
          boundary,
          { timestampUtc: 't2', message: 'Dotnet Build' }
        ]
      })
      .mockResolvedValueOnce({
        ...status('Completed', 't2'),
        deploymentStatusMessages: [
          { timestampUtc: 't2', message: 'Dotnet Build' }
        ]
      })

    await poll()

    const printed = info.mock.calls
      .map((c) => c[0] as string)
      .filter((line) => line.startsWith('[t'))
    expect(printed).toEqual([
      '[t0] Git Commit',
      '[t1] NuGet Restore',
      '[t2] Dotnet Build'
    ])
  })

  it('returns when the deployment completes', async () => {
    const done = status('Completed')
    getDeploymentStatus
      .mockResolvedValueOnce(status('InProgress'))
      .mockResolvedValueOnce(done)

    await expect(poll()).resolves.toBe(done)
    expect(getDeploymentStatus).toHaveBeenCalledTimes(2)
    expect(sleepMock).toHaveBeenCalledTimes(1)
    expect(sleepMock).toHaveBeenCalledWith(1000)
  })

  it('returns when the deployment fails', async () => {
    const failed = status('Failed')
    getDeploymentStatus.mockResolvedValue(failed)
    await expect(poll()).resolves.toBe(failed)
    expect(sleepMock).not.toHaveBeenCalled()
  })

  it.each(['Cancelled', 'SomethingNew'])(
    'treats %s as a terminal state',
    async (state) => {
      getDeploymentStatus
        .mockResolvedValueOnce(status('Pending'))
        .mockResolvedValueOnce(status('Queued'))
        .mockResolvedValueOnce(status(state))

      await expect(poll()).resolves.toMatchObject({ deploymentState: state })
      expect(getDeploymentStatus).toHaveBeenCalledTimes(3)
    }
  )

  it('passes modifiedUtc from the previous response as lastModifiedUtc', async () => {
    getDeploymentStatus
      .mockResolvedValueOnce(status('InProgress', '2024-01-01T00:00:01Z'))
      .mockResolvedValueOnce(status('InProgress', ''))
      .mockResolvedValueOnce(status('InProgress', '2024-01-01T00:00:03Z'))
      .mockResolvedValueOnce(status('Completed'))

    await poll()

    expect(getDeploymentStatus.mock.calls).toEqual([
      ['dep-1', undefined],
      ['dep-1', '2024-01-01T00:00:01Z'],
      // empty modifiedUtc keeps the previous value
      ['dep-1', '2024-01-01T00:00:01Z'],
      ['dep-1', '2024-01-01T00:00:03Z']
    ])
  })

  it('retries transient errors', async () => {
    getDeploymentStatus
      .mockRejectedValueOnce(
        new apiModule.UmbracoCloudApiError('unavailable', 503, '')
      )
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(status('Completed'))

    await expect(poll()).resolves.toMatchObject({
      deploymentState: 'Completed'
    })
    expect(getDeploymentStatus).toHaveBeenCalledTimes(3)
    expect(warning).toHaveBeenCalledTimes(2)
  })

  it('throws immediately on 401 with a helpful message', async () => {
    getDeploymentStatus.mockRejectedValue(
      new apiModule.UmbracoCloudApiError('bad key', 401, '')
    )

    await expect(poll()).rejects.toThrow(
      /Unauthorized while polling deployment dep-1.*bad key/
    )
    expect(getDeploymentStatus).toHaveBeenCalledTimes(1)
    expect(sleepMock).not.toHaveBeenCalled()
  })

  it('throws immediately on 404', async () => {
    const notFound = new apiModule.UmbracoCloudApiError('not found', 404, '')
    getDeploymentStatus.mockRejectedValue(notFound)

    await expect(poll()).rejects.toBe(notFound)
    expect(getDeploymentStatus).toHaveBeenCalledTimes(1)
  })

  it('shows the updating-marker warning only once', async () => {
    const marker = 'blocked with the following markers: updating'
    getDeploymentStatus
      .mockResolvedValueOnce(status('InProgress', '', [marker]))
      .mockResolvedValueOnce(status('InProgress', '', [marker]))
      .mockResolvedValueOnce(status('Failed', '', ['CheckBlockingMarkers']))

    await poll()

    const markerWarnings = warning.mock.calls.filter((c) =>
      String(c[0]).includes('leftover upgrade markers')
    )
    expect(markerWarnings).toHaveLength(1)
  })

  it('times out when the deployment never finishes', async () => {
    getDeploymentStatus.mockResolvedValue(status('InProgress'))
    // Real time must pass for the deadline to be reached
    sleepMock.mockImplementation(
      (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    )

    await expect(poll(30, 5)).rejects.toThrow(
      'Deployment did not complete within the expected time'
    )
    expect(getDeploymentStatus.mock.calls.length).toBeGreaterThan(1)
    // Never sleeps longer than the interval
    for (const [ms] of sleepMock.mock.calls) {
      expect(ms).toBeLessThanOrEqual(5)
    }
  })
})

describe('hasUpdatingMarkerError', () => {
  let polling: PollingModule

  beforeAll(async () => {
    polling = await import('../../src/utils/deployment-polling.js')
  })

  it('detects marker messages', () => {
    expect(
      polling.hasUpdatingMarkerError([
        {
          timestampUtc: 't',
          message:
            "The site can't be upgraded as it's blocked with the following markers: updating"
        }
      ])
    ).toBe(true)
  })

  it('returns false for no or unrelated messages', () => {
    expect(polling.hasUpdatingMarkerError(undefined)).toBe(false)
    expect(
      polling.hasUpdatingMarkerError([{ timestampUtc: 't', message: 'ok' }])
    ).toBe(false)
  })
})
