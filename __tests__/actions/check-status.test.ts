import { jest } from '@jest/globals'
import type {
  DeploymentResponse,
  ChangesResponse
} from '../../src/types/index.js'

// ESM mock setup
const mockPollDeploymentStatus = jest.fn<() => Promise<DeploymentResponse>>()
jest.unstable_mockModule('../../src/utils/deployment-polling.js', () => ({
  pollDeploymentStatus: mockPollDeploymentStatus
}))

jest.unstable_mockModule('@actions/core', () => ({
  info: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
  error: jest.fn()
}))

jest.unstable_mockModule('@actions/exec', () => ({
  exec: jest.fn(),
  getExecOutput: jest.fn()
}))

jest.unstable_mockModule('@actions/github', () => ({
  context: {
    repo: { owner: 'test-owner', repo: 'test-repo' },
    ref: 'refs/heads/main'
  },
  getOctokit: jest.fn()
}))

jest.unstable_mockModule('fs', () => ({
  existsSync: jest.fn(() => false),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn()
}))

jest.unstable_mockModule('../../src/github/pull-request.js', () => ({
  createPullRequestWithPatch: jest.fn()
}))

// Helper to create a valid DeploymentResponse mock
function createDeploymentResponse(
  deploymentId: string,
  state: string = 'Completed'
): DeploymentResponse {
  return {
    deploymentId,
    deploymentState: state,
    modifiedUtc: '2025-01-01T00:00:00Z',
    deploymentStatusMessages: []
  }
}

// Helper to create a valid ChangesResponse mock
function createChangesResponse(changes: string = ''): ChangesResponse {
  return { changes }
}

describe('handleCheckStatus', () => {
  let handleCheckStatus: any

  const mockGetChangesById = jest.fn<() => Promise<ChangesResponse>>()
  const mockApi = {
    getApiKey: () => 'test-api-key',
    getProjectId: () => 'test-project-id',
    getChangesById: mockGetChangesById
  }

  beforeAll(async () => {
    const checkStatusModule = await import('../../src/actions/check-status.js')
    handleCheckStatus = checkStatusModule.handleCheckStatus
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetChangesById.mockReset()
    mockPollDeploymentStatus.mockReset()
  })

  describe('timeoutSeconds parameter', () => {
    test('passes custom timeoutSeconds to pollDeploymentStatus', async () => {
      // Arrange
      const customTimeoutSeconds = 2400 // 40 minutes
      const expectedTimeoutMs = customTimeoutSeconds * 1000

      mockPollDeploymentStatus.mockResolvedValue(
        createDeploymentResponse('deployment-123', 'Completed')
      )

      mockGetChangesById.mockResolvedValue(createChangesResponse())

      const inputs = {
        deploymentId: 'deployment-123',
        targetEnvironmentAlias: 'staging',
        timeoutSeconds: customTimeoutSeconds
      }

      // Act
      await handleCheckStatus(mockApi, inputs)

      // Assert
      expect(mockPollDeploymentStatus).toHaveBeenCalledWith(
        'test-api-key',
        'test-project-id',
        'deployment-123',
        expectedTimeoutMs
      )
    })

    test('uses default timeoutSeconds (1200) when not provided', async () => {
      // Arrange
      const defaultTimeoutMs = 1200 * 1000 // 20 minutes in ms

      mockPollDeploymentStatus.mockResolvedValue(
        createDeploymentResponse('deployment-456', 'Completed')
      )

      mockGetChangesById.mockResolvedValue(createChangesResponse())

      const inputs = {
        deploymentId: 'deployment-456',
        targetEnvironmentAlias: 'production'
        // timeoutSeconds not provided
      }

      // Act
      await handleCheckStatus(mockApi, inputs)

      // Assert
      expect(mockPollDeploymentStatus).toHaveBeenCalledWith(
        'test-api-key',
        'test-project-id',
        'deployment-456',
        defaultTimeoutMs
      )
    })

    test('handles zero timeoutSeconds by using default', async () => {
      // Arrange - when timeoutSeconds is 0, fallback to default
      const defaultTimeoutMs = 1200 * 1000

      mockPollDeploymentStatus.mockResolvedValue(
        createDeploymentResponse('deployment-789', 'Completed')
      )

      mockGetChangesById.mockResolvedValue(createChangesResponse())

      const inputs = {
        deploymentId: 'deployment-789',
        targetEnvironmentAlias: 'dev',
        timeoutSeconds: 0 // falsy value
      }

      // Act
      await handleCheckStatus(mockApi, inputs)

      // Assert
      expect(mockPollDeploymentStatus).toHaveBeenCalledWith(
        'test-api-key',
        'test-project-id',
        'deployment-789',
        defaultTimeoutMs
      )
    })

    test('handles very short timeoutSeconds value', async () => {
      // Arrange
      const shortTimeoutSeconds = 60 // 1 minute
      const expectedTimeoutMs = shortTimeoutSeconds * 1000

      mockPollDeploymentStatus.mockResolvedValue(
        createDeploymentResponse('deployment-short', 'Completed')
      )

      mockGetChangesById.mockResolvedValue(createChangesResponse())

      const inputs = {
        deploymentId: 'deployment-short',
        targetEnvironmentAlias: 'staging',
        timeoutSeconds: shortTimeoutSeconds
      }

      // Act
      await handleCheckStatus(mockApi, inputs)

      // Assert
      expect(mockPollDeploymentStatus).toHaveBeenCalledWith(
        'test-api-key',
        'test-project-id',
        'deployment-short',
        expectedTimeoutMs
      )
    })

    test('converts timeoutSeconds to milliseconds correctly', async () => {
      // Arrange
      const timeoutSeconds = 900 // 15 minutes
      const expectedTimeoutMs = 900000 // 900 * 1000

      mockPollDeploymentStatus.mockResolvedValue(
        createDeploymentResponse('deployment-conversion', 'Completed')
      )

      mockGetChangesById.mockResolvedValue(createChangesResponse())

      const inputs = {
        deploymentId: 'deployment-conversion',
        targetEnvironmentAlias: 'staging',
        timeoutSeconds: timeoutSeconds
      }

      // Act
      await handleCheckStatus(mockApi, inputs)

      // Assert
      const calls = mockPollDeploymentStatus.mock.calls as unknown[][]
      const calledWithTimeoutMs = calls[0][3] as number
      expect(calledWithTimeoutMs).toBe(expectedTimeoutMs)
      expect(typeof calledWithTimeoutMs).toBe('number')
    })
  })
})
