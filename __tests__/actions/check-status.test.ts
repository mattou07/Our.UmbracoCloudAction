import { jest } from '@jest/globals'
import type {
  ActionInputs,
  ChangesResponse,
  DeploymentResponse,
  PullRequestInfo
} from '../../src/types/index.js'

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
  error: jest.fn()
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
    getDeploymentErrorDetails: jest.fn<(id: string) => Promise<string[]>>()
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
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockPollDeploymentStatus.mockReset()
    mockCreatePullRequestWithPatch.mockReset()
    mockExec.mockReset().mockResolvedValue(0)
    api.getChangesById.mockReset().mockResolvedValue({ changes: PATCH })
    api.getLatestCompletedDeployment.mockReset().mockResolvedValue('dep-0')
    api.getDeploymentErrorDetails.mockReset().mockResolvedValue([])
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
      api.getChangesById.mockRejectedValue(
        Object.assign(
          new Error(
            'Failed to get changes: 409 Conflict - {"type":"CloudNullDeployment"}'
          ),
          { status: 409 }
        )
      )

      const result = await handleCheckStatus(api, inputs())

      expect(result.deploymentState).toBe('Completed')
      expect(result.changes).toBeUndefined()
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('no changes to apply')
      )
      expect(core.warning).not.toHaveBeenCalled()
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

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow()

      expect(api.getChangesById).not.toHaveBeenCalledWith('dep-1', 'live')
      expect(api.getLatestCompletedDeployment).toHaveBeenCalled()
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

      await expect(
        handleCheckStatus(api, inputs({ githubToken: '' }))
      ).rejects.toThrow(/^Deployment dep-1 failed$/)

      expect(mockCreatePullRequestWithPatch).not.toHaveBeenCalled()
      expect(mockExec).not.toHaveBeenCalled()
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('No GitHub token available')
      )
    })

    test('falls back to GITHUB_TOKEN env when input is empty', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
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
      api.getChangesById.mockResolvedValue({ changes: '  \n' })

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /^Deployment dep-1 failed$/
      )

      expect(mockCreatePullRequestWithPatch).not.toHaveBeenCalled()
      expect(mockExec).not.toHaveBeenCalled()
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('skipping PR creation')
      )
    })

    test('no completed deployment: skips PR', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      api.getLatestCompletedDeployment.mockResolvedValue(null)
      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /^Deployment dep-1 failed$/
      )
      expect(mockCreatePullRequestWithPatch).not.toHaveBeenCalled()
    })

    test('restores cwd and cleans up when clone fails', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      mockExec.mockRejectedValue(
        new Error('The process git failed with exit code 128')
      )

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /^Deployment dep-1 failed$/
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
      mockCreatePullRequestWithPatch.mockRejectedValue(new Error('push failed'))

      await expect(handleCheckStatus(api, inputs())).rejects.toThrow(
        /^Deployment dep-1 failed$/
      )

      expect(chdirSpy).toHaveBeenLastCalledWith('/original')
      expect(outputs()['pr-url']).toBeUndefined()
    })

    test('warns when workspace cleanup fails', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
      fsMock.rmSync.mockImplementationOnce(() => {
        throw new Error('EBUSY')
      })
      await expect(handleCheckStatus(api, inputs())).rejects.toThrow()
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Failed to clean up workspace')
      )
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

    test('falls back to main', () => {
      context.ref = 'refs/tags/v1'
      expect(resolveBaseBranch(inputs())).toBe('main')
    })

    test('used for PR creation', async () => {
      mockPollDeploymentStatus.mockResolvedValue(deployment('Failed'))
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
