import { jest } from '@jest/globals'
import type { DeploymentResponse } from '../../src/types/index.js'

// ESM mock setup
const mockPollDeploymentStatus = jest.fn<() => Promise<DeploymentResponse>>()
jest.unstable_mockModule('../../src/utils/deployment-polling.js', () => ({
  pollDeploymentStatus: mockPollDeploymentStatus
}))

jest.unstable_mockModule('@actions/core', () => ({
  info: jest.fn(),
  setOutput: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
  error: jest.fn()
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

describe('handleStartDeployment', () => {
  let handleStartDeployment: any

  const mockStartDeployment = jest.fn<() => Promise<string>>()
  const mockApi = {
    getApiKey: () => 'test-api-key',
    getProjectId: () => 'test-project-id',
    startDeployment: mockStartDeployment
  }

  beforeAll(async () => {
    const startDeploymentModule = await import(
      '../../src/actions/start-deployment.js'
    )
    handleStartDeployment = startDeploymentModule.handleStartDeployment
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockStartDeployment.mockReset()
    mockPollDeploymentStatus.mockReset()
  })

  describe('timeoutSeconds parameter', () => {
    test('passes custom timeoutSeconds to pollDeploymentStatus', async () => {
      // Arrange
      const customTimeoutSeconds = 1800 // 30 minutes
      const expectedTimeoutMs = customTimeoutSeconds * 1000

      mockStartDeployment.mockResolvedValue('deployment-123')
      mockPollDeploymentStatus.mockResolvedValue(
        createDeploymentResponse('deployment-123', 'Completed')
      )

      const inputs = {
        artifactId: 'artifact-123',
        targetEnvironmentAlias: 'staging',
        commitMessage: 'Test deployment',
        noBuildAndRestore: false,
        skipVersionCheck: false,
        timeoutSeconds: customTimeoutSeconds
      }

      // Act
      await handleStartDeployment(mockApi, inputs)

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

      mockStartDeployment.mockResolvedValue('deployment-456')
      mockPollDeploymentStatus.mockResolvedValue(
        createDeploymentResponse('deployment-456', 'Completed')
      )

      const inputs = {
        artifactId: 'artifact-456',
        targetEnvironmentAlias: 'production',
        commitMessage: 'Production deployment',
        noBuildAndRestore: false,
        skipVersionCheck: false
        // timeoutSeconds not provided
      }

      // Act
      await handleStartDeployment(mockApi, inputs)

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

      mockStartDeployment.mockResolvedValue('deployment-789')
      mockPollDeploymentStatus.mockResolvedValue(
        createDeploymentResponse('deployment-789', 'Completed')
      )

      const inputs = {
        artifactId: 'artifact-789',
        targetEnvironmentAlias: 'dev',
        commitMessage: 'Dev deployment',
        noBuildAndRestore: false,
        skipVersionCheck: false,
        timeoutSeconds: 0 // falsy value
      }

      // Act
      await handleStartDeployment(mockApi, inputs)

      // Assert
      expect(mockPollDeploymentStatus).toHaveBeenCalledWith(
        'test-api-key',
        'test-project-id',
        'deployment-789',
        defaultTimeoutMs
      )
    })

    test('handles very large timeoutSeconds value', async () => {
      // Arrange
      const largeTimeoutSeconds = 7200 // 2 hours
      const expectedTimeoutMs = largeTimeoutSeconds * 1000

      mockStartDeployment.mockResolvedValue('deployment-large')
      mockPollDeploymentStatus.mockResolvedValue(
        createDeploymentResponse('deployment-large', 'Completed')
      )

      const inputs = {
        artifactId: 'artifact-large',
        targetEnvironmentAlias: 'staging',
        commitMessage: 'Long deployment',
        noBuildAndRestore: false,
        skipVersionCheck: false,
        timeoutSeconds: largeTimeoutSeconds
      }

      // Act
      await handleStartDeployment(mockApi, inputs)

      // Assert
      expect(mockPollDeploymentStatus).toHaveBeenCalledWith(
        'test-api-key',
        'test-project-id',
        'deployment-large',
        expectedTimeoutMs
      )
    })
  })
})
