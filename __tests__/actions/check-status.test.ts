import { jest } from '@jest/globals'
import type {
  ActionInputs,
  ChangesResponse,
  DeploymentResponse,
  PullRequestInfo
} from '../../src/types/index.js'
import {
  SIGNED_LOGS,
  STATUS_MESSAGES,
  failedDeployment
} from '../fixtures/umbraco-cloud-responses.js'

// ESM mock setup
const mockPollDeploymentStatus =
  jest.fn<(...args: unknown[]) => Promise<DeploymentResponse>>()
jest.unstable_mockModule('../../src/utils/deployment-polling.js', () => ({
  pollDeploymentStatus: mockPollDeploymentStatus,
  hasUpdatingMarkerError: (
    messages: DeploymentResponse['deploymentStatusMessages'] | undefined
  ) =>
    (messages || []).some((m) =>
      m.message.includes('blocked with the following markers: updating')
    )
}))

const mockCreatePullRequestWithPatch =
  jest.fn<(...args: unknown[]) => Promise<PullRequestInfo>>()
jest.unstable_mockModule('../../src/github/pull-request.js', () => ({
  createPullRequestWithPatch: mockCreatePullRequestWithPatch
}))

const core = {
  info: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  setSecret: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  startGroup: jest.fn(),
  endGroup: jest.fn()
}
jest.unstable_mockModule('@actions/core', () => core)

const mockExec = jest.fn<(...args: unknown[]) => Promise<number>>()
jest.unstable_mockModule('@actions/exec', () => ({
  exec: mockExec,
  getExecOutput: jest.fn()
}))

const context: {
  repo: { owner: string; repo: string }
  ref: string
  serverUrl: string
  payload: { repository?: { default_branch?: string } }
} = {
  repo: { owner: 'test-owner', repo: 'test-repo' },
  ref: 'refs/heads/main',
  serverUrl: 'https://github.com',
  payload: {}
}
jest.unstable_mockModule('@actions/github', () => ({
  context,
  getOctokit: jest.fn()
}))

const fsMock = {
  existsSync: jest.fn(() => true),
  mkdirSync: jest.fn(),
  rmSync: jest.fn()
}
jest.unstable_mockModule('fs', () => fsMock)

function deployment(
  state: string,
  messages: string[] = []
): DeploymentResponse {
  return {
    deploymentId: 'dep-1',
    deploymentState: state,
    modifiedUtc: '2025-01-01T00:00:00Z',
    deploymentStatusMessages: messages.map((message) => ({
      timestampUtc: '2025-01-01T00:00:00Z',
      message
    }))
  }
}

const inputs = (overrides: Partial<ActionInputs> = {}): ActionInputs => ({
  projectId: 'pid',
  apiKey: 'key',
  filePath: './a.zip',
  targetEnvironmentAlias: 'live',
  deploymentId: 'dep-1',
  timeoutSeconds: 600,
  githubToken: 'gh-token',
  ...overrides
})

const PATCH = 'diff --git a/x b/x\n+new'

describe('handleCheckStatus', () => {
  let handleCheckStatus: typeof import('../../src/actions/check-status.js').handleCheckStatus
  let resolveBaseBranch: typeof import('../../src/actions/check-status.js').resolveBaseBranch

  const api = {
    getDeploymentStatus: jest.fn<() => Promise<DeploymentResponse>>(),
    getChangesById:
      jest.fn<(id: string, alias: string) => Promise<ChangesResponse>>(),
    getLatestCompletedDeployment:
      jest.fn<(alias: string) => Promise<string | null>>(),
    getDeploymentErrorDetails: jest.fn<(id: string) => Promise<string[]>>(),
    getFailureLogExcerpts:
      jest.fn<
        (
          id: string,
          maxLines?: number
        ) => Promise<Array<{ name: string; lines: string[] }>>
      >()
  }

  let UmbracoCloudApiError: typeof import('../../src/api/umbraco-cloud-api.js').UmbracoCloudApiError
  const cloudNull = () =>
    new UmbracoCloudApiError(
      'Failed to get changes: 409 Conflict',
      409,
      '{"type":"CloudNullDeployment","title":"Deployment did not make any changes to cloud","status":409}'
    )

  /** A version failure whose own diff is empty, so the fallback PR is used. */
  const versionFailure = () => {
    api.getDeploymentErrorDetails.mockResolvedValue([
      'NU1605: Detected package downgrade'
    ])
    api.getChangesById.mockImplementation(async (id: string) => {
      if (id === 'dep-1') throw cloudNull()
      return { changes: PATCH }
    })
  }

  let chdirSpy: ReturnType<typeof jest.spyOn>
  let cwdSpy: ReturnType<typeof jest.spyOn>
  const savedEnv = { ...process.env }

  const outputs = () =>
    Object.fromEntries(
      core.setOutput.mock.calls.map((c) => [c[0] as string, c[1]])
    )

  beforeAll(async () => {
    const mod = await import('../../src/actions/check-status.js')
    handleCheckStatus = mod.handleCheckStatus
    resolveBaseBranch = mod.resolveBaseBranch
    UmbracoCloudApiError = (await import('../../src/api/umbraco-cloud-api.js'))
      .UmbracoCloudApiError
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockPollDeploymentStatus.mockReset()
    mockCreatePullRequestWithPatch.mockReset()
    mockExec.mockReset().mockResolvedValue(0)
    api.getChangesById.mockReset().mockResolvedValue({ changes: PATCH })
    api.getLatestCompletedDeployment.mockReset().mockResolvedValue('dep-0')
    api.getDeploymentErrorDetails.mockReset().mockResolvedValue([])
    api.getFailureLogExcerpts.mockReset().mockResolvedValue([])
    mockCreatePullRequestWithPatch.mockResolvedValue({
      url: 'https://github.com/test-owner/test-repo/pull/7',
      number: 7
    })
    context.ref = 'refs/heads/main'
    context.serverUrl = 'https://github.com'
    context.payload = {}
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN
    process.env.GITHUB_WORKSPACE = '/work'
    process.env.GITHUB_RUN_ID = '42'
    chdirSpy = jest.spyOn(process, 'chdir').mockImplementation(() => {})
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/original')
  })

  afterEach(() => {
    chdirSpy.mockRestore()
    cwdSpy.mockRestore()
    process.env = { ...savedEnv }
  })

  test('passes api, deployment id and timeout in ms to pollDeploymentStatus', async () => {
    mockPollDeploymentStatus.mockResolvedValue(deployment('Completed'))
    await handleCheckStatus(api, inputs({ timeoutSeconds: 2400 }))
    expect(mockPollDeploymentStatus).toHaveBeenCalledWith(api, 'dep-1', 2400000)
  })

  test('defaults timeout to 1200 seconds', async () => {
    mockPollDeploymentStatus.mockResolvedValue(deployment('Completed'))
    await handleCheckStatus(api, inputs({ timeoutSeconds: undefined }))
    expect(mockPollDeploymentStatus).toHaveBeenCalledWith(api, 'dep-1', 1200000)
  })

  test('throws when required inputs are missing', async () => {
    await expect(
      handleCheckStatus(api, inputs({ deploymentId: undefined }))
    ).rejects.toThrow('Missing required inputs: deploymentId')
  })

  test('propagates polling errors (e.g. timeout)', async () => {
    mockPollDeploymentStatus.mockRejectedValue(new Error('timed out'))
    await expect(handleCheckStatus(api, inputs())).rejects.toThrow('timed out')
  })

  describe('Completed', () => {
    test('sets outputs and returns', async () => {
      const status = deployment('Completed')
      mockPollDeploymentStatus.mockResolvedValue(status)

      const result = await handleCheckStatus(api, inputs())

      expect(result).toEqual({
        deploymentState: 'Completed',
        deploymentStatus: JSON.stringify(status),
        changes: JSON.stringify({ changes: PATCH })
      })
      expect(outputs()).toMatchObject({
        deploymentState: 'Completed',
        deploymentStatus: JSON.stringify(status),
        changes: JSON.stringify({ changes: PATCH })
      })
      expect(api.getChangesById).toHaveBeenCalledWith('dep-1', 'live')
      expect(core.info).toHaveBeenCalledWith(PATCH)
      expect(mockCreatePullRequestWithPatch).not.toHaveBeenCalled()
      expect(core.setFailed).not.toHaveBeenCalled()
    })

    test('logs when there is no diff', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Completed'))
      api.getChangesById.mockResolvedValue({ changes: '' })
      await handleCheckStatus(api, inputs())
      expect(core.info).toHaveBeenCalledWith(
        'Deployment completed. No changes/diff available.'
      )
    })

    test('succeeds when diff returns 409 CloudNullDeployment', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Completed'))
      api.getChangesById.mockRejectedValue(cloudNull())

      const result = await handleCheckStatus(api, inputs())

      expect(result.deploymentState).toBe('Completed')
      expect(result.changes).toBeUndefined()
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('no changes to apply')
      )
      expect(core.warning).not.toHaveBeenCalled()
    })

    test('succeeds when a 409 carries CloudNullDeployment only in a non-JSON body', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Completed'))
      api.getChangesById.mockRejectedValue(
        new UmbracoCloudApiError(
          'Failed to get changes: 409 Conflict',
          409,
          'Error: CloudNullDeployment'
        )
      )

      const result = await handleCheckStatus(api, inputs())

      expect(result.changes).toBeUndefined()
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('no changes to apply')
      )
      expect(core.warning).not.toHaveBeenCalled()
    })

    test('warns for a 409 that is not CloudNullDeployment', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Completed'))
      api.getChangesById.mockRejectedValue(
        new UmbracoCloudApiError(
          'Failed to get changes: 409 Conflict',
          409,
          '{"type":"SomethingElse","status":409}'
        )
      )

      const result = await handleCheckStatus(api, inputs())

      expect(result.changes).toBeUndefined()
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Could not retrieve changes')
      )
    })

    test('warns but succeeds when diff fails for another reason', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Completed'))
      api.getChangesById.mockRejectedValue(new Error('500 boom'))
      const result = await handleCheckStatus(api, inputs())
      expect(result.deploymentState).toBe('Completed')
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Could not retrieve changes')
      )
    })
  })

  describe('Failed', () => {
    test('throws after creating a PR from the latest completed deployment', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      versionFailure()

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        'Deployment dep-1 failed. A pull request with the Umbraco Cloud changes was opened: https://github.com/test-owner/test-repo/pull/7'
      )

      expect(api.getDeploymentErrorDetails).toHaveBeenCalledWith('dep-1')
      expect(api.getLatestCompletedDeployment).toHaveBeenCalledWith('live')
      expect(api.getChangesById).toHaveBeenCalledWith('dep-0', 'live')
      expect(mockCreatePullRequestWithPatch).toHaveBeenCalledWith(
        PATCH,
        'main',
        'Fix: Apply changes from failed deployment dep-1',
        expect.stringContaining('dep-0'),
        'dep-0',
        'gh-token'
      )
      expect(outputs()).toMatchObject({
        deploymentState: 'Failed',
        'latest-completed-deployment-id': 'dep-0',
        'pr-url': 'https://github.com/test-owner/test-repo/pull/7',
        'pr-number': '7'
      })
      expect(core.setSecret).toHaveBeenCalledWith('gh-token')
      expect(core.setFailed).not.toHaveBeenCalled()
    })

    test('clones the base branch using the server host and token', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      versionFailure()
      context.serverUrl = 'https://ghe.example.com'

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow()

      expect(mockExec).toHaveBeenCalledWith('git', [
        'clone',
        '--branch',
        'main',
        'https://x-access-token:gh-token@ghe.example.com/test-owner/test-repo.git',
        expect.stringContaining('pr-workspace-42')
      ])
      // Only the clone: no reset/clean of the fresh checkout
      expect(mockExec).toHaveBeenCalledTimes(1)
      expect(chdirSpy).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('pr-workspace-42')
      )
      expect(chdirSpy).toHaveBeenLastCalledWith('/original')
      expect(fsMock.rmSync).toHaveBeenCalledWith(
        expect.stringContaining('pr-workspace-42'),
        { recursive: true, force: true }
      )
    })

    test('uses the failed deployment patch for version failures', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      api.getDeploymentErrorDetails.mockResolvedValue([
        'Detected package downgrade: Umbraco.Cms from 16.2.0 to 16.1.1'
      ])

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(/pull\/7/)

      expect(api.getChangesById).toHaveBeenCalledWith('dep-1', 'live')
      expect(api.getLatestCompletedDeployment).not.toHaveBeenCalled()
      expect(mockCreatePullRequestWithPatch).toHaveBeenCalledWith(
        PATCH,
        'main',
        'Fix: Update package versions for deployment dep-1',
        expect.stringContaining('Detected package downgrade'),
        'dep-1',
        'gh-token'
      )
      expect(outputs()['pr-number']).toBe('7')
    })

    test('falls back to latest completed deployment when version patch cannot be fetched', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      api.getDeploymentErrorDetails.mockResolvedValue(['NU1605: downgrade'])
      api.getChangesById
        .mockRejectedValueOnce(new Error('404'))
        .mockResolvedValueOnce({ changes: PATCH })

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow()

      expect(api.getLatestCompletedDeployment).toHaveBeenCalled()
      expect(mockCreatePullRequestWithPatch).toHaveBeenCalledWith(
        PATCH,
        'main',
        expect.any(String),
        expect.any(String),
        'dep-0',
        'gh-token'
      )
    })

    test('generic build errors mentioning "package" are not treated as version failures', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      api.getDeploymentErrorDetails.mockResolvedValue([
        'error CS0246: The type or namespace from package Foo version 1.0 could not be found'
      ])

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /^Deployment dep-1 failed$/
      )

      expect(api.getChangesById).not.toHaveBeenCalled()
      expect(api.getLatestCompletedDeployment).not.toHaveBeenCalled()
      expect(mockCreatePullRequestWithPatch).not.toHaveBeenCalled()
    })

    test('NuGet failure throws without attempting a PR', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      api.getDeploymentErrorDetails.mockResolvedValue([
        'error NU1301: Unable to load the service index for source'
      ])

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /^Deployment dep-1 failed$/
      )

      expect(api.getLatestCompletedDeployment).not.toHaveBeenCalled()
      expect(mockCreatePullRequestWithPatch).not.toHaveBeenCalled()
      expect(outputs()['pr-url']).toBeUndefined()
    })

    test('still throws when error details cannot be retrieved', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      api.getDeploymentErrorDetails.mockRejectedValue(new Error('nope'))
      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /Deployment dep-1 failed/
      )
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Could not retrieve detailed error information')
      )
    })

    test('no token: skips PR but still throws', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      versionFailure()

      await expect(
        handleCheckStatus(api, inputs({ githubToken: '' }))
      ).rejects.toThrow(/^Deployment dep-1 failed/)

      expect(mockCreatePullRequestWithPatch).not.toHaveBeenCalled()
      expect(mockExec).not.toHaveBeenCalled()
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('No GitHub token available')
      )
    })

    test('falls back to GITHUB_TOKEN env when input is empty', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      versionFailure()
      process.env.GITHUB_TOKEN = 'env-token'

      await expect(
        handleCheckStatus(api, inputs({ githubToken: '' }))
      ).rejects.toThrow()

      expect(mockCreatePullRequestWithPatch).toHaveBeenCalledWith(
        expect.any(String),
        'main',
        expect.any(String),
        expect.any(String),
        'dep-0',
        'env-token'
      )
    })

    test('empty diff: skips PR creation', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      versionFailure()
      api.getChangesById.mockResolvedValue({ changes: '  \n' })

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /^Deployment dep-1 failed/
      )

      expect(mockCreatePullRequestWithPatch).not.toHaveBeenCalled()
      expect(mockExec).not.toHaveBeenCalled()
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('skipping PR creation')
      )
    })

    test('no completed deployment: skips PR', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      versionFailure()
      api.getLatestCompletedDeployment.mockResolvedValue(null)
      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /^Deployment dep-1 failed/
      )
      expect(mockCreatePullRequestWithPatch).not.toHaveBeenCalled()
    })

    test('warns and still throws when the latest completed deployment cannot be fetched', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      versionFailure()
      api.getLatestCompletedDeployment.mockRejectedValue(new Error('api down'))

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /^Deployment dep-1 failed/
      )

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Failed to get latest completed deployment')
      )
      expect(mockCreatePullRequestWithPatch).not.toHaveBeenCalled()
      expect(outputs()['latest-completed-deployment-id']).toBeUndefined()
    })

    test('defaults the workspace to the cwd and the host to github.com', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      versionFailure()
      delete process.env.GITHUB_RUN_ID
      delete process.env.GITHUB_WORKSPACE
      context.serverUrl = ''

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow()

      expect(mockExec).toHaveBeenCalledWith('git', [
        'clone',
        '--branch',
        'main',
        'https://x-access-token:gh-token@github.com/test-owner/test-repo.git',
        expect.stringMatching(/original.pr-workspace-\d+$/)
      ])
    })

    test('restores cwd and cleans up when clone fails', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      versionFailure()
      mockExec.mockRejectedValue(
        new Error('The process git failed with exit code 128')
      )

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /^Deployment dep-1 failed/
      )

      expect(mockCreatePullRequestWithPatch).not.toHaveBeenCalled()
      // Never entered the workspace; cwd restored to the original before cleanup
      expect(chdirSpy).toHaveBeenCalledTimes(1)
      expect(chdirSpy).toHaveBeenCalledWith('/original')
      expect(chdirSpy.mock.invocationCallOrder[0]).toBeLessThan(
        fsMock.rmSync.mock.invocationCallOrder[0]
      )
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Failed to create pull request')
      )
    })

    test('restores cwd when PR creation fails inside the workspace', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      versionFailure()
      mockCreatePullRequestWithPatch.mockRejectedValue(new Error('push failed'))

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /^Deployment dep-1 failed/
      )

      expect(chdirSpy).toHaveBeenLastCalledWith('/original')
      expect(outputs()['pr-url']).toBeUndefined()
    })

    test('warns when workspace cleanup fails', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      versionFailure()
      fsMock.rmSync.mockImplementationOnce(() => {
        throw new Error('EBUSY')
      })
      await expect(handleCheckStatus(api, inputs())).rejects.toThrow()
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Failed to clean up workspace')
      )
    })
  })

  describe('Failed (real Umbraco Cloud responses)', () => {
    const noPrAttempted = () => {
      expect(api.getChangesById).not.toHaveBeenCalled()
      expect(api.getLatestCompletedDeployment).not.toHaveBeenCalled()
      expect(mockCreatePullRequestWithPatch).not.toHaveBeenCalled()
      expect(mockExec).not.toHaveBeenCalled()
    }

    test('C5: never PRs a deployment that already updated the Cloud repository', async () => {
      const messages = STATUS_MESSAGES.kuduBuildFailedAfterPush
      mockPollDeploymentStatus.mockResolvedValue(
        failedDeployment(
          'dep-1',
          messages,
          true
        ) as unknown as DeploymentResponse
      )
      api.getDeploymentErrorDetails.mockResolvedValue(messages)

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /^Deployment dep-1 failed$/
      )

      noPrAttempted()
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining(
          'already changed the Umbraco Cloud repository, so a sync PR would include the failing changes'
        )
      )
    })

    test('C5: cloudRepositoryUpdated wins over a version-failure text hint', async () => {
      mockPollDeploymentStatus.mockResolvedValue(
        failedDeployment(
          'dep-1',
          STATUS_MESSAGES.downgrade,
          true
        ) as unknown as DeploymentResponse
      )
      api.getDeploymentErrorDetails.mockResolvedValue([
        STATUS_MESSAGES.downgrade[2]
      ])

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow()

      noPrAttempted()
    })

    test.each([
      ['C2 missing .umbraco file', STATUS_MESSAGES.missingUmbracoFile],
      ['C3 invalid .umbraco base', STATUS_MESSAGES.invalidUmbracoBase],
      ['C4 build error', STATUS_MESSAGES.buildError]
    ])('%s: no fix PR attempted', async (_name, messages) => {
      mockPollDeploymentStatus.mockResolvedValue(
        failedDeployment('dep-1', messages) as unknown as DeploymentResponse
      )
      api.getDeploymentErrorDetails.mockResolvedValue(messages)

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /^Deployment dep-1 failed$/
      )

      noPrAttempted()
      expect(core.info).toHaveBeenCalledWith(
        'No fix PR attempted: this failure is not caused by changes made in Umbraco Cloud.'
      )
    })

    test('C1: downgrade with empty patches lists the packages to update', async () => {
      const messages = STATUS_MESSAGES.downgrade
      mockPollDeploymentStatus.mockResolvedValue(
        failedDeployment('dep-1', messages) as unknown as DeploymentResponse
      )
      api.getDeploymentErrorDetails.mockResolvedValue([messages[2]])
      api.getChangesById.mockImplementation(async (id: string) => {
        if (id === 'dep-1') throw cloudNull()
        return { changes: '' }
      })

      const error = await handleCheckStatus(api, inputs()).catch((e) => e)

      expect(api.getChangesById).toHaveBeenCalledWith('dep-1', 'live')
      expect(mockCreatePullRequestWithPatch).not.toHaveBeenCalled()
      const csproj = 'src/Contoso.Web/Contoso.Web.csproj'
      expect(core.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'Your source references older package versions than Umbraco Cloud is running. Update these in your repository and redeploy'
        )
      )
      expect(core.error).toHaveBeenCalledWith(
        `- Umbraco.Cms: 17.4.2 → 17.7.2 (${csproj})`
      )
      expect(core.error).toHaveBeenCalledWith(
        `- Umbraco.Cloud.StorageProviders.AzureBlob: 17.0.0 → 17.1.0 (${csproj})`
      )
      expect(core.error).toHaveBeenCalledWith(
        `- Umbraco.Cloud.Cms: 17.1.3 → 17.2.3 (${csproj})`
      )
      expect((error as Error).message).toMatch(
        /^Deployment dep-1 failed\. Your source references older package versions.*Umbraco\.Cms 17\.4\.2 → 17\.7\.2, Umbraco\.Cloud\.StorageProviders\.AzureBlob 17\.0\.0 → 17\.1\.0, Umbraco\.Cloud\.Cms 17\.1\.3 → 17\.2\.3/
      )
      // CloudNullDeployment on the failed deployment is expected, not a warning
      expect(core.warning).not.toHaveBeenCalledWith(
        expect.stringContaining('Could not retrieve git patch')
      )
    })

    test('wording changed: downgrade text that cannot be parsed falls back to raw messages', async () => {
      const reworded =
        'Update rejected: Umbraco.Cms would be downgraded from 17.7.2 to 17.4.2 by src/Web/Web.csproj'
      mockPollDeploymentStatus.mockResolvedValue(
        failedDeployment('dep-1', [reworded]) as unknown as DeploymentResponse
      )
      api.getDeploymentErrorDetails.mockResolvedValue([reworded])
      api.getChangesById.mockImplementation(async (id: string) => {
        if (id === 'dep-1') throw cloudNull()
        return { changes: '' }
      })

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /compare your \.csproj package versions with the Cloud environment/
      )

      expect(mockCreatePullRequestWithPatch).not.toHaveBeenCalled()
      expect(core.error).toHaveBeenCalledWith(
        'Your source may reference older package versions than Umbraco Cloud; compare your .csproj package versions with the Cloud environment.'
      )
      expect(core.error).toHaveBeenCalledWith(reworded)
    })

    test('C4/C7: prints signed-log error lines in a group', async () => {
      const messages = STATUS_MESSAGES.restoreError
      mockPollDeploymentStatus.mockResolvedValue(
        failedDeployment('dep-1', messages) as unknown as DeploymentResponse
      )
      api.getDeploymentErrorDetails.mockResolvedValue([messages[2]])
      const lines = SIGNED_LOGS.restore
        .split('\n')
        .filter((line) => /error/i.test(line))
      api.getFailureLogExcerpts.mockResolvedValue([
        { name: 'NuGet restore log', lines }
      ])

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /^Deployment dep-1 failed$/
      )

      expect(api.getFailureLogExcerpts).toHaveBeenCalledWith('dep-1')
      expect(core.startGroup).toHaveBeenCalledWith(
        'Errors from Umbraco Cloud logs'
      )
      expect(core.error).toHaveBeenCalledWith(lines[0])
      expect(lines[0]).toContain(
        'error NU1101: Unable to find package Contoso.DoesNotExist'
      )
      expect(core.endGroup).toHaveBeenCalled()
      const errorIndex = core.error.mock.calls.findIndex(
        (c) => c[0] === lines[0]
      )
      expect(core.startGroup.mock.invocationCallOrder[0]).toBeLessThan(
        core.error.mock.invocationCallOrder[errorIndex]
      )
      expect(core.error.mock.invocationCallOrder[errorIndex]).toBeLessThan(
        core.endGroup.mock.invocationCallOrder[0]
      )
      noPrAttempted()
    })

    test('prints signed-log errors even when the Cloud repository was updated', async () => {
      mockPollDeploymentStatus.mockResolvedValue(
        failedDeployment(
          'dep-1',
          STATUS_MESSAGES.kuduBuildFailedAfterPush,
          true
        ) as unknown as DeploymentResponse
      )
      const lines = SIGNED_LOGS.build
        .split('\n')
        .filter((l) => /error CS/.test(l))
      api.getFailureLogExcerpts.mockResolvedValue([
        { name: 'Build log', lines }
      ])

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow()

      expect(core.error).toHaveBeenCalledWith(lines[0])
      noPrAttempted()
    })

    test('no log group when Cloud logs have no error lines', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      api.getFailureLogExcerpts.mockResolvedValue([
        { name: 'Build', lines: [] }
      ])

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow()

      expect(core.startGroup).not.toHaveBeenCalled()
    })

    test('a failed deployment without status messages still throws a failure', async () => {
      mockPollDeploymentStatus.mockResolvedValue({
        ...deployment('Failed'),
        deploymentStatusMessages: undefined
      } as unknown as DeploymentResponse)

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /^Deployment dep-1 failed/
      )

      expect(mockCreatePullRequestWithPatch).not.toHaveBeenCalled()
    })

    test('treats an empty Cloud log response as no excerpts', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      api.getFailureLogExcerpts.mockResolvedValue(
        undefined as unknown as Array<{ name: string; lines: string[] }>
      )

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /^Deployment dep-1 failed/
      )

      expect(core.startGroup).not.toHaveBeenCalled()
    })

    test('still throws the deployment failure when Cloud logs cannot be read', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      api.getFailureLogExcerpts.mockRejectedValue(new Error('logs 503'))

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /^Deployment dep-1 failed/
      )

      expect(core.debug).toHaveBeenCalledWith(
        expect.stringContaining('Could not read Umbraco Cloud logs')
      )
      expect(core.startGroup).not.toHaveBeenCalled()
    })

    test('wording changed: reworded version failure gets no PR but details are shown', async () => {
      const reworded =
        'Cannot apply update: the incoming project references older Umbraco packages than this environment'
      mockPollDeploymentStatus.mockResolvedValue(
        failedDeployment('dep-1', [reworded]) as unknown as DeploymentResponse
      )
      api.getDeploymentErrorDetails.mockResolvedValue([reworded])

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /^Deployment dep-1 failed$/
      )

      noPrAttempted()
      expect(core.warning).toHaveBeenCalledWith(`- ${reworded}`)
    })

    test('wording changed: reworded NuGet failure is a generic failure without a PR', async () => {
      const reworded =
        'Package feed contoso.github could not be reached while fetching dependencies'
      mockPollDeploymentStatus.mockResolvedValue(
        failedDeployment('dep-1', [reworded]) as unknown as DeploymentResponse
      )
      api.getDeploymentErrorDetails.mockResolvedValue([reworded])

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /^Deployment dep-1 failed$/
      )

      noPrAttempted()
      expect(core.warning).toHaveBeenCalledWith(`- ${reworded}`)
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('No fix PR attempted')
      )
    })

    test('wording changed: reworded upgrade-marker message takes the generic failure path', async () => {
      const reworded =
        'Environment is locked: an earlier upgrade left marker files behind'
      mockPollDeploymentStatus.mockResolvedValue(
        deployment('Failed', [reworded])
      )
      api.getDeploymentErrorDetails.mockResolvedValue([reworded])

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /^Deployment dep-1 failed$/
      )

      expect(api.getDeploymentErrorDetails).toHaveBeenCalledWith('dep-1')
      noPrAttempted()
    })
  })

  test('updating marker failure throws with KUDU guidance', async () => {
    mockPollDeploymentStatus.mockResolvedValue(
      deployment('Failed', [
        "The site can't be upgraded as it's blocked with the following markers: updating"
      ])
    )

    await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
      /leftover upgrade markers.*KUDU/
    )

    expect(core.error).toHaveBeenCalledWith('Resolution using KUDU:')
    expect(api.getDeploymentErrorDetails).not.toHaveBeenCalled()
    expect(mockCreatePullRequestWithPatch).not.toHaveBeenCalled()
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  test('Cancelled throws unexpected state', async () => {
    mockPollDeploymentStatus.mockResolvedValue(deployment('Cancelled'))
    await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
      'Deployment ended in unexpected state: Cancelled'
    )
    expect(outputs().deploymentState).toBe('Cancelled')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  describe('resolveBaseBranch', () => {
    test('input wins', () => {
      context.ref = 'refs/heads/feature'
      expect(resolveBaseBranch(inputs({ baseBranch: 'develop' }))).toBe(
        'develop'
      )
    })

    test('uses triggering branch', () => {
      context.ref = 'refs/heads/feature/x'
      expect(resolveBaseBranch(inputs())).toBe('feature/x')
    })

    test('refs/pull/... falls back to repository default branch', () => {
      context.ref = 'refs/pull/12/merge'
      context.payload = { repository: { default_branch: 'trunk' } }
      expect(resolveBaseBranch(inputs())).toBe('trunk')
    })

    test('an empty ref falls back to main', () => {
      context.ref = ''
      expect(resolveBaseBranch(inputs())).toBe('main')
    })

    test('falls back to main', () => {
      context.ref = 'refs/tags/v1'
      expect(resolveBaseBranch(inputs())).toBe('main')
    })

    test('used for PR creation', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      versionFailure()
      context.ref = 'refs/pull/12/merge'
      context.payload = { repository: { default_branch: 'trunk' } }

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow()

      expect(mockExec).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['--branch', 'trunk'])
      )
      expect(mockCreatePullRequestWithPatch).toHaveBeenCalledWith(
        expect.any(String),
        'trunk',
        expect.any(String),
        expect.any(String),
        'dep-0',
        'gh-token'
      )
    })
  })
})
