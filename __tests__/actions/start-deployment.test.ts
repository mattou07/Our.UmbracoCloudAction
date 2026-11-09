import { jest } from '@jest/globals'
import type { ActionInputs, DeploymentRequest } from '../../src/types/index.js'

// ESM mock setup
const mockPollDeploymentStatus = jest.fn()
jest.unstable_mockModule('../../src/utils/deployment-polling.js', () => ({
  pollDeploymentStatus: mockPollDeploymentStatus,
  hasUpdatingMarkerError: jest.fn(() => false)
}))

const core = {
  info: jest.fn(),
  setOutput: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
  error: jest.fn()
}
jest.unstable_mockModule('@actions/core', () => core)

const baseInputs = (overrides: Partial<ActionInputs> = {}): ActionInputs => ({
  projectId: 'pid',
  apiKey: 'key',
  filePath: './a.zip',
  targetEnvironmentAlias: 'staging',
  artifactId: 'artifact-123',
  ...overrides
})

describe('handleStartDeployment', () => {
  let handleStartDeployment: typeof import('../../src/actions/start-deployment.js').handleStartDeployment

  const mockStartDeployment =
    jest.fn<
      (
        request: DeploymentRequest,
        options?: { waitForRunningDeploymentMs?: number }
      ) => Promise<string>
    >()
  const api = { startDeployment: mockStartDeployment }

  beforeAll(async () => {
    handleStartDeployment = (
      await import('../../src/actions/start-deployment.js')
    ).handleStartDeployment
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockStartDeployment.mockReset().mockResolvedValue('deployment-123')
  })

  test('starts the deployment with the provided options', async () => {
    const result = await handleStartDeployment(
      api,
      baseInputs({
        commitMessage: 'Custom message',
        noBuildAndRestore: true,
        skipVersionCheck: true
      })
    )

    expect(mockStartDeployment).toHaveBeenCalledWith(
      {
        targetEnvironmentAlias: 'staging',
        artifactId: 'artifact-123',
        commitMessage: 'Custom message',
        noBuildAndRestore: true,
        skipVersionCheck: true
      },
      expect.anything()
    )
    expect(result).toEqual({ deploymentId: 'deployment-123' })
  })

  test('applies defaults for optional fields', async () => {
    await handleStartDeployment(api, baseInputs())

    expect(mockStartDeployment).toHaveBeenCalledWith(
      {
        targetEnvironmentAlias: 'staging',
        artifactId: 'artifact-123',
        commitMessage: 'Deployment from GitHub Actions',
        noBuildAndRestore: false,
        skipVersionCheck: false
      },
      expect.anything()
    )
  })

  test('waits for a running deployment for up to the timeout', async () => {
    await handleStartDeployment(api, baseInputs({ timeoutSeconds: 1800 }))
    expect(mockStartDeployment).toHaveBeenCalledWith(expect.any(Object), {
      waitForRunningDeploymentMs: 1800000
    })
  })

  test('defaults the running-deployment wait to 1200 seconds', async () => {
    await handleStartDeployment(api, baseInputs())
    expect(mockStartDeployment).toHaveBeenCalledWith(expect.any(Object), {
      waitForRunningDeploymentMs: 1200000
    })
  })

  test('sets the deploymentId output', async () => {
    await handleStartDeployment(api, baseInputs())
    expect(core.setOutput).toHaveBeenCalledWith(
      'deploymentId',
      'deployment-123'
    )
  })

  test('does not poll for deployment status', async () => {
    await handleStartDeployment(api, baseInputs({ timeoutSeconds: 1800 }))
    expect(mockPollDeploymentStatus).not.toHaveBeenCalled()
  })

  test('throws when artifactId is missing', async () => {
    await expect(
      handleStartDeployment(api, baseInputs({ artifactId: undefined }))
    ).rejects.toThrow('Missing required inputs: artifactId')
    expect(mockStartDeployment).not.toHaveBeenCalled()
  })

  test('propagates API errors', async () => {
    mockStartDeployment.mockRejectedValue(new Error('403 Forbidden'))
    await expect(handleStartDeployment(api, baseInputs())).rejects.toThrow(
      '403 Forbidden'
    )
    expect(core.setOutput).not.toHaveBeenCalled()
  })
})
