import { jest } from '@jest/globals'

// ESM mock setup
jest.unstable_mockModule('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn()
}))

jest.unstable_mockModule('@actions/exec', () => ({
  exec: jest.fn()
}))

jest.unstable_mockModule('fs', () => ({
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  existsSync: jest.fn()
}))

jest.unstable_mockModule('@actions/github', () => ({
  context: {
    repo: {
      owner: 'testowner',
      repo: 'testrepo'
    }
  }
}))

jest.unstable_mockModule('@octokit/rest', () => ({
  Octokit: jest.fn()
}))

describe('createPullRequestWithPatch', () => {
  let core: any
  let exec: any
  let fs: any
  let Octokit: any
  let createPullRequestWithPatch: any

  const mockOctokit = {
    repos: {
      getBranch: jest.fn() as any
    },
    git: {
      createRef: jest.fn() as any
    },
    pulls: {
      create: jest.fn() as any
    }
  }

  const validPatch = `diff --git a/test.txt b/test.txt
index abc123..def456 100644
--- a/test.txt
+++ b/test.txt
@@ -1 +1 @@
-old content
+new content`

  const validResponse = {
    url: 'https://github.com/testowner/testrepo/pull/123',
    number: 123
  }

  beforeAll(async () => {
    core = await import('@actions/core')
    exec = await import('@actions/exec')
    fs = await import('fs')
    await import('@actions/github')
    Octokit = await import('@octokit/rest')
    createPullRequestWithPatch = (
      await import('../../src/github/pull-request.js')
    ).createPullRequestWithPatch
  })

  beforeEach(() => {
    jest.clearAllMocks()

    // Set up default environment variables
    process.env.GITHUB_TOKEN = 'test-token'
    process.env.GITHUB_ACTOR = 'testuser'
    process.env.GITHUB_ACTOR_ID = '12345'

    // Set up default mocks
    Octokit.Octokit.mockImplementation(() => mockOctokit)

    mockOctokit.repos.getBranch.mockResolvedValue({
      data: {
        commit: {
          sha: 'abc123def456'
        }
      }
    })

    mockOctokit.git.createRef.mockResolvedValue({})

    mockOctokit.pulls.create.mockResolvedValue({
      data: {
        html_url: 'https://github.com/testowner/testrepo/pull/123',
        number: 123
      }
    })

    exec.exec.mockResolvedValue(0)
    fs.existsSync.mockReturnValue(false)
  })

  afterEach(() => {
    // Clean up environment variables
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_ACTOR
    delete process.env.GITHUB_ACTOR_ID
  })

  // Valid Input Scenarios
  test('creates pull request successfully with valid inputs', async () => {
    // Arrange
    const gitPatch = validPatch
    const baseBranch = 'main'
    const title = 'Test PR Title'
    const body = 'Test PR body content'
    const deploymentId = 'dep-123'

    // Act
    const result = await createPullRequestWithPatch(
      gitPatch,
      baseBranch,
      title,
      body,
      deploymentId
    )

    // Assert
    expect(result).toEqual(validResponse)
    expect(mockOctokit.repos.getBranch).toHaveBeenCalledWith({
      owner: 'testowner',
      repo: 'testrepo',
      branch: baseBranch
    })
    expect(mockOctokit.git.createRef).toHaveBeenCalledWith({
      owner: 'testowner',
      repo: 'testrepo',
      ref: `refs/heads/umbcloud/${deploymentId}`,
      sha: 'abc123def456'
    })
    expect(mockOctokit.pulls.create).toHaveBeenCalledWith({
      owner: 'testowner',
      repo: 'testrepo',
      title: title,
      head: `umbcloud/${deploymentId}`,
      base: baseBranch,
      body: body
    })
  })

  test('creates pull request with GH_TOKEN when GITHUB_TOKEN not available', async () => {
    // Arrange
    delete process.env.GITHUB_TOKEN
    process.env.GH_TOKEN = 'gh-token'

    // Act
    const result = await createPullRequestWithPatch(
      validPatch,
      'main',
      'Title',
      'Body',
      'dep-123'
    )

    // Assert
    expect(result).toEqual(validResponse)
    expect(Octokit.Octokit).toHaveBeenCalledWith({ auth: 'gh-token' })
  })

  test('applies git patch and commits changes successfully', async () => {
    // Arrange & Act
    await createPullRequestWithPatch(
      validPatch,
      'main',
      'Title',
      'Body',
      'dep-123'
    )

    // Assert
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      './git-patch-dep-123.diff',
      validPatch,
      'utf8'
    )
    expect(exec.exec).toHaveBeenCalledWith(
      'git',
      ['apply', './git-patch-dep-123.diff'],
      { ignoreReturnCode: true }
    )
    expect(exec.exec).toHaveBeenCalledWith('git', ['add', '.'])
    expect(exec.exec).toHaveBeenCalledWith('git', [
      '-c',
      'user.name=testuser',
      '-c',
      'user.email=12345+testuser@users.noreply.github.com',
      'commit',
      '-m',
      'Apply Umbraco Cloud changes from deployment dep-123'
    ])
    expect(exec.exec).toHaveBeenCalledWith('git', [
      'push',
      'origin',
      'umbcloud/dep-123'
    ])
  })

  // Invalid Input Scenarios
  test('throws error when GitHub token is missing', async () => {
    // Arrange
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN

    // Act & Assert
    await expect(
      createPullRequestWithPatch(validPatch, 'main', 'Title', 'Body', 'dep-123')
    ).rejects.toThrow(
      'GitHub token not found. Please set GITHUB_TOKEN or GH_TOKEN environment variable.'
    )
  })

  test('throws error when git patch application fails', async () => {
    // Arrange
    exec.exec.mockImplementation((cmd: any, args: any) => {
      if (args.includes('apply')) {
        return Promise.resolve(1) // Non-zero exit code indicates failure
      }
      return Promise.resolve(0)
    })

    // Act & Assert
    await expect(
      createPullRequestWithPatch(validPatch, 'main', 'Title', 'Body', 'dep-123')
    ).rejects.toThrow('Failed to apply git patch')
  })

  test('throws error when branch creation fails with non-conflict error', async () => {
    // Arrange
    mockOctokit.git.createRef.mockRejectedValue(
      new Error('API rate limit exceeded')
    )

    // Act & Assert
    await expect(
      createPullRequestWithPatch(validPatch, 'main', 'Title', 'Body', 'dep-123')
    ).rejects.toThrow('API rate limit exceeded')
  })

  test('throws error when pull request creation fails', async () => {
    // Arrange
    mockOctokit.pulls.create.mockRejectedValue(new Error('Validation failed'))

    // Act & Assert
    await expect(
      createPullRequestWithPatch(validPatch, 'main', 'Title', 'Body', 'dep-123')
    ).rejects.toThrow('Validation failed')
  })

  // Edge Cases
  test('handles branch name conflict by adding timestamp', async () => {
    // Arrange
    const conflictError = new Error('Reference already exists')
    mockOctokit.git.createRef
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce({})

    const mockTimestamp = 1693747200000
    jest.spyOn(Date, 'now').mockReturnValue(mockTimestamp)

    // Act
    const result = await createPullRequestWithPatch(
      validPatch,
      'main',
      'Title',
      'Body',
      'dep-123'
    )

    // Assert
    expect(mockOctokit.git.createRef).toHaveBeenCalledTimes(2)
    expect(mockOctokit.git.createRef).toHaveBeenLastCalledWith({
      owner: 'testowner',
      repo: 'testrepo',
      ref: `refs/heads/umbcloud/dep-123-${mockTimestamp}`,
      sha: 'abc123def456'
    })
    expect(mockOctokit.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Title (Conflict Resolution)',
        head: `umbcloud/dep-123-${mockTimestamp}`,
        body: expect.stringContaining('timestamp was added to the branch name')
      })
    )
    expect(result).toEqual(validResponse)
  })

  test('uses fallback values when GitHub environment variables are missing', async () => {
    // Arrange
    delete process.env.GITHUB_ACTOR
    delete process.env.GITHUB_ACTOR_ID

    // Act
    await createPullRequestWithPatch(
      validPatch,
      'main',
      'Title',
      'Body',
      'dep-123'
    )

    // Assert
    expect(exec.exec).toHaveBeenCalledWith('git', [
      '-c',
      'user.name=github-actions[bot]',
      '-c',
      'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit',
      '-m',
      'Apply Umbraco Cloud changes from deployment dep-123'
    ])
  })

  test('cleans up patch file even when process fails', async () => {
    // Arrange
    fs.existsSync.mockReturnValue(true)
    exec.exec.mockImplementation((cmd: any, args: any) => {
      if (args.includes('commit')) {
        throw new Error('Commit failed')
      }
      return Promise.resolve(0)
    })

    // Act & Assert
    await expect(
      createPullRequestWithPatch(validPatch, 'main', 'Title', 'Body', 'dep-123')
    ).rejects.toThrow('Commit failed')

    expect(fs.unlinkSync).toHaveBeenCalledWith('./git-patch-dep-123.diff')
  })

  test('handles git checkout failure gracefully in cleanup', async () => {
    // Arrange
    exec.exec.mockImplementation((cmd: any, args: any) => {
      if (args.includes('checkout') && args.includes('main')) {
        throw new Error('Checkout failed')
      }
      return Promise.resolve(0)
    })

    // Act
    const result = await createPullRequestWithPatch(
      validPatch,
      'main',
      'Title',
      'Body',
      'dep-123'
    )

    // Assert
    expect(result).toEqual(validResponse)
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Could not return to original branch')
    )
  })

  test('handles empty or invalid git patch', async () => {
    // Arrange
    const emptyPatch = ''

    // Act
    const result = await createPullRequestWithPatch(
      emptyPatch,
      'main',
      'Title',
      'Body',
      'dep-123'
    )

    // Assert
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      './git-patch-dep-123.diff',
      emptyPatch,
      'utf8'
    )
    expect(result).toEqual(validResponse)
  })

  test('handles GUID-format deployment ID', async () => {
    // Arrange
    const guidDeploymentId = '550e8400-e29b-41d4-a716-446655440000'

    // Act
    const result = await createPullRequestWithPatch(
      validPatch,
      'main',
      'Title',
      'Body',
      guidDeploymentId
    )

    // Assert
    expect(mockOctokit.git.createRef).toHaveBeenCalledWith({
      owner: 'testowner',
      repo: 'testrepo',
      ref: `refs/heads/umbcloud/${guidDeploymentId}`,
      sha: 'abc123def456'
    })
    expect(result).toEqual(validResponse)
  })

  test('throws error for invalid deployment ID with special characters', async () => {
    // Arrange
    const invalidDeploymentId = '550e8400@e29b!41d4#a716$446655440000'

    // Act & Assert
    await expect(
      createPullRequestWithPatch(
        validPatch,
        'main',
        'Title',
        'Body',
        invalidDeploymentId
      )
    ).rejects.toThrow(
      'Invalid deployment ID format. Must be a valid GUID or contain only alphanumeric characters and hyphens.'
    )
  })

  test('throws error for deployment ID with spaces', async () => {
    // Arrange
    const invalidDeploymentId = '550e8400 e29b 41d4 a716 446655440000'

    // Act & Assert
    await expect(
      createPullRequestWithPatch(
        validPatch,
        'main',
        'Title',
        'Body',
        invalidDeploymentId
      )
    ).rejects.toThrow(
      'Invalid deployment ID format. Must be a valid GUID or contain only alphanumeric characters and hyphens.'
    )
  })

  test('accepts valid deployment ID formats', async () => {
    // Arrange - Test different valid formats
    const validIds = [
      '550e8400-e29b-41d4-a716-446655440000', // Standard GUID
      '{550E8400-E29B-41D4-A716-446655440000}', // GUID with braces
      'dep-123', // Simple format
      'ABC123-def456', // Mixed case simple
      'deployment-1234567890abcdef', // Longer format
      '123e4567-e89b-12d3-a456-9AC7CBDCEE52', // Another valid GUID
      '{123E4567-E89B-12D3-A456-9AC7CBDCEE52}' // GUID with braces uppercase
    ]

    // Act & Assert - All should work without throwing
    for (const deploymentId of validIds) {
      const result = await createPullRequestWithPatch(
        validPatch,
        'main',
        'Title',
        'Body',
        deploymentId
      )
      expect(result).toEqual(validResponse)
    }
  })

  test('throws error for invalid deployment ID characters', async () => {
    // Arrange - Test strings that don't match either GUID pattern OR simple alphanumeric pattern
    const testCases = [
      { id: 'invalid@deployment', desc: 'Contains @ symbol' },
      { id: 'deployment#id', desc: 'Contains # symbol' },
      { id: 'deployment id with spaces', desc: 'Contains spaces' },
      { id: 'deployment/id', desc: 'Contains forward slash' },
      { id: 'deployment\\id', desc: 'Contains backslash' },
      { id: 'deployment.id', desc: 'Contains period' }
    ]

    // Act & Assert - Test each case individually
    for (const testCase of testCases) {
      await expect(
        createPullRequestWithPatch(
          validPatch,
          'main',
          'Title',
          'Body',
          testCase.id
        )
      ).rejects.toThrow(
        'Invalid deployment ID format. Must be a valid GUID or contain only alphanumeric characters and hyphens.'
      )
    }
  })

  test('accepts valid GUID patterns specifically', async () => {
    // Arrange - Test that our GUID pattern correctly validates proper GUIDs
    const validGuids = [
      '123e4567-e89b-12d3-a456-426614174000', // Standard GUID
      '{123E4567-E89B-12D3-A456-426614174000}', // With braces
      '00000000-0000-0000-0000-000000000000', // Nil GUID
      'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF' // All F's
    ]

    // Act & Assert - All should work
    for (const guid of validGuids) {
      const result = await createPullRequestWithPatch(
        validPatch,
        'main',
        'Title',
        'Body',
        guid
      )
      expect(result).toEqual(validResponse)
    }
  })

  // TypeScript Type Safety
  test('returns PullRequestInfo type with correct structure', async () => {
    // Arrange & Act
    const result = await createPullRequestWithPatch(
      validPatch,
      'main',
      'Title',
      'Body',
      'dep-123'
    )

    // Assert - Validate interface compliance
    expect(result).toHaveProperty('url')
    expect(result).toHaveProperty('number')
    expect(typeof result.url).toBe('string')
    expect(typeof result.number).toBe('number')
    expect(result.url).toMatch(/^https:\/\/github\.com\/.*\/pull\/\d+$/)
    expect(result.number).toBeGreaterThan(0)
  })

  test('validates input parameter types', async () => {
    // Arrange
    const validInputs = {
      gitPatch: validPatch,
      baseBranch: 'main',
      title: 'Test Title',
      body: 'Test Body',
      latestCompletedDeploymentId: 'dep-123'
    }

    // Act
    const result = await createPullRequestWithPatch(
      validInputs.gitPatch,
      validInputs.baseBranch,
      validInputs.title,
      validInputs.body,
      validInputs.latestCompletedDeploymentId
    )

    // Assert - All parameters should be used as strings
    expect(typeof validInputs.gitPatch).toBe('string')
    expect(typeof validInputs.baseBranch).toBe('string')
    expect(typeof validInputs.title).toBe('string')
    expect(typeof validInputs.body).toBe('string')
    expect(typeof validInputs.latestCompletedDeploymentId).toBe('string')
    expect(result).toEqual(validResponse)
  })
})
