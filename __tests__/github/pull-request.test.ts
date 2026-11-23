import { jest } from '@jest/globals'
import * as path from 'path'

// ESM mock setup
jest.unstable_mockModule('@actions/core', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  setSecret: jest.fn()
}))

jest.unstable_mockModule('@actions/exec', () => ({
  exec: jest.fn()
}))

jest.unstable_mockModule('fs', () => ({
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  readdirSync: jest.fn(),
  mkdirSync: jest.fn(),
  rmSync: jest.fn(),
  copyFileSync: jest.fn()
}))

jest.unstable_mockModule('os', () => ({
  tmpdir: jest.fn(() => '/tmp')
}))

jest.unstable_mockModule('@actions/artifact', () => ({
  DefaultArtifactClient: jest.fn().mockImplementation(() => ({
    uploadArtifact: jest.fn()
  }))
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

jest.unstable_mockModule('../../src/utils/version-fixes.js', () => ({
  applyVersionFixes: jest.fn()
}))

describe('createPullRequestWithPatch', () => {
  let core: any
  let exec: any
  let fs: any
  let Octokit: any
  let createPullRequestWithPatch: any
  let validateBaseBranch: any
  let gitAuthArgs: any
  let applyVersionFixes: any

  const mockOctokit = {
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

  const AUTH_B64 = Buffer.from('x-access-token:test-token').toString('base64')
  const AUTH_ARGS = ['-c', `http.extraheader=AUTHORIZATION: basic ${AUTH_B64}`]

  /**
   * Fake git: ls-remote reports the branch missing (exit 2) unless told
   * otherwise, ls-files lists the given .rej files (NUL separated), apply
   * returns applyCode, and any command containing throwOn throws.
   */
  function mockGit(
    opts: {
      applyCode?: number
      lsRemoteCode?: number
      rej?: string[]
      status?: string
      throwOn?: string
    } = {}
  ) {
    exec.exec.mockImplementation((_cmd: any, args: any, options: any) => {
      if (opts.throwOn && args.includes(opts.throwOn)) {
        throw new Error(`${opts.throwOn} failed`)
      }
      if (args.includes('ls-remote')) {
        return Promise.resolve(opts.lsRemoteCode ?? 2)
      }
      if (args.includes('ls-files')) {
        const out = (opts.rej ?? []).map((f) => `${f}\0`).join('')
        options.listeners.stdout(Buffer.from(out))
        return Promise.resolve(0)
      }
      if (args.includes('status')) {
        options.listeners.stdout(Buffer.from(opts.status ?? ' M test.txt\n'))
        return Promise.resolve(0)
      }
      if (args.includes('apply')) {
        return Promise.resolve(opts.applyCode ?? 0)
      }
      return Promise.resolve(0)
    })
  }

  const run = (
    patch: string,
    branch = 'main',
    id = 'dep-123',
    token = 'test-token'
  ) => createPullRequestWithPatch(patch, branch, 'Title', 'Body', id, token)

  beforeAll(async () => {
    core = await import('@actions/core')
    exec = await import('@actions/exec')
    fs = await import('fs')
    await import('os')
    await import('@actions/artifact')
    await import('@actions/github')
    applyVersionFixes = (await import('../../src/utils/version-fixes.js'))
      .applyVersionFixes
    Octokit = await import('@octokit/rest')
    const mod = await import('../../src/github/pull-request.js')
    createPullRequestWithPatch = mod.createPullRequestWithPatch
    validateBaseBranch = mod.validateBaseBranch
    gitAuthArgs = mod.gitAuthArgs
  })

  beforeEach(() => {
    jest.clearAllMocks()

    // Set up default environment variables
    process.env.GITHUB_ACTOR = 'testuser'
    process.env.GITHUB_ACTOR_ID = '12345'

    // Set up default mocks
    Octokit.Octokit.mockImplementation(() => mockOctokit)

    mockOctokit.pulls.create.mockResolvedValue({
      data: {
        html_url: 'https://github.com/testowner/testrepo/pull/123',
        number: 123
      }
    })

    mockGit()
    fs.existsSync.mockReturnValue(false)
    applyVersionFixes.mockReturnValue([])
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
    const result = await createPullRequestWithPatch(
      validPatch,
      'main',
      'Test PR Title',
      'Test PR body content',
      'dep-123',
      'test-token'
    )

    expect(result).toEqual(validResponse)
    expect(mockOctokit.pulls.create).toHaveBeenCalledWith({
      owner: 'testowner',
      repo: 'testrepo',
      title: 'Test PR Title',
      head: 'umbcloud/dep-123',
      base: 'main',
      body: 'Test PR body content'
    })
  })

  test('authenticates Octokit with the token parameter, not the environment', async () => {
    process.env.GITHUB_TOKEN = 'env-token'

    const result = await run(validPatch, 'main', 'dep-123', 'param-token')

    expect(result).toEqual(validResponse)
    expect(Octokit.Octokit).toHaveBeenCalledWith({ auth: 'param-token' })
  })

  test('applies git patch and commits changes successfully', async () => {
    await run(validPatch)

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      './git-patch-dep-123.diff',
      validPatch,
      'utf8'
    )
    expect(exec.exec).toHaveBeenCalledWith(
      'git',
      [
        'apply',
        '--reject',
        '--ignore-space-change',
        '--ignore-whitespace',
        './git-patch-dep-123.diff'
      ],
      { ignoreReturnCode: true, cwd: expect.any(String) }
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
      ...AUTH_ARGS,
      'push',
      'origin',
      'umbcloud/dep-123'
    ])
  })

  test('uses a local branch and a cheap git sequence (no API branch, no fetch)', async () => {
    await run(validPatch)

    const verbs = exec.exec.mock.calls.map((c: any) => {
      const args: string[] = c[1]
      const skip = args[0] === '-c' && args[1].startsWith('http.extraheader')
      const rest = skip ? args.slice(2) : args
      return rest[0] === '-c' ? 'commit' : rest[0]
    })
    expect(verbs).toEqual([
      'ls-remote',
      'checkout',
      'apply',
      'ls-files',
      'status',
      'add',
      'commit',
      'push',
      'checkout'
    ])
    expect(exec.exec).toHaveBeenCalledWith(
      'git',
      [
        ...AUTH_ARGS,
        'ls-remote',
        '--exit-code',
        '--heads',
        'origin',
        'umbcloud/dep-123'
      ],
      { ignoreReturnCode: true, silent: true }
    )
    expect(exec.exec).toHaveBeenCalledWith('git', [
      'checkout',
      '-b',
      'umbcloud/dep-123'
    ])
    expect(exec.exec).toHaveBeenLastCalledWith('git', ['checkout', 'main'])
    expect(exec.exec.mock.calls.some((c: any) => c[1].includes('fetch'))).toBe(
      false
    )
  })

  test('authenticates network commands with an extraheader and never exposes the raw token', async () => {
    await run(validPatch)

    const networkCalls = exec.exec.mock.calls.filter((c: any) =>
      ['ls-remote', 'push'].some((cmd) => c[1].includes(cmd))
    )
    expect(networkCalls).toHaveLength(2)
    for (const call of networkCalls) {
      expect(call[1].slice(0, 2)).toEqual(AUTH_ARGS)
    }
    for (const call of exec.exec.mock.calls) {
      expect(call[1].join(' ')).not.toContain('test-token')
    }
    expect(core.setSecret).toHaveBeenCalledWith(AUTH_B64)
    expect(gitAuthArgs('test-token')).toEqual(AUTH_ARGS)
  })

  // Branch name validation
  test.each([
    ['-delete'],
    ['--upload-pack=x'],
    [''],
    ['a b'],
    ['a\tb'],
    ['a..b'],
    ['a~1'],
    ['a^'],
    ['a:b'],
    ['a?'],
    ['a*'],
    ['a[0]'],
    ['a\\b'],
    ['a\x01b'],
    ['a\x7fb'],
    ['feature/'],
    ['feature.lock']
  ])('rejects invalid base branch %j before any git call', async (branch) => {
    expect(() => validateBaseBranch(branch)).toThrow(
      `Invalid base-branch "${branch}"`
    )
    await expect(run(validPatch, branch)).rejects.toThrow(
      `Invalid base-branch "${branch}"`
    )
    expect(exec.exec).not.toHaveBeenCalled()
  })

  test.each([
    ['main'],
    ['release/1.2'],
    ['feature/x_y-z'],
    ['v1.0.0'],
    ['a.b']
  ])('accepts valid base branch %s', (branch) => {
    expect(() => validateBaseBranch(branch)).not.toThrow()
  })

  // Workflow files in the patch
  test('warns when the patch touches .github but still applies it', async () => {
    const patch = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index 1..2 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1 +1 @@
-a
+b
${validPatch}`

    const result = await run(patch)

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('.github/workflows/ci.yml')
    )
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('GITHUB_TOKEN')
    )
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      './git-patch-dep-123.diff',
      patch,
      'utf8'
    )
    expect(result).toEqual(validResponse)
  })

  test('does not warn about CI configuration for ordinary patches', async () => {
    await run(validPatch)
    expect(core.warning).not.toHaveBeenCalled()
  })

  // Invalid Input Scenarios
  test('throws error when GitHub token is missing', async () => {
    await expect(run(validPatch, 'main', 'dep-123', '')).rejects.toThrow(
      'GitHub token not provided'
    )
    expect(exec.exec).not.toHaveBeenCalled()
  })

  test('logs git identity details at debug level only', async () => {
    await run(validPatch)

    expect(core.debug).toHaveBeenCalledWith('Debug - GITHUB_ACTOR: testuser')
    expect(core.info).not.toHaveBeenCalledWith(
      expect.stringContaining('Debug -')
    )
  })

  test('throws error when git patch application fails', async () => {
    mockGit({ applyCode: 2 }) // Exit code > 1 indicates actual failure

    await expect(run(validPatch)).rejects.toThrow('Failed to apply git patch')
  })

  test('throws when ls-remote fails for a reason other than "not found"', async () => {
    mockGit({ lsRemoteCode: 128 })

    await expect(run(validPatch)).rejects.toThrow(
      'git ls-remote failed with exit code 128'
    )
    expect(mockOctokit.pulls.create).not.toHaveBeenCalled()
  })

  test('throws error when pull request creation fails', async () => {
    mockOctokit.pulls.create.mockRejectedValue(new Error('Validation failed'))

    await expect(run(validPatch)).rejects.toThrow('Validation failed')
  })

  // Edge Cases
  test('handles branch name conflict by adding timestamp', async () => {
    // ls-remote exit code 0 means the branch exists on the remote
    mockGit({ lsRemoteCode: 0 })
    const mockTimestamp = 1693747200000
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(mockTimestamp)

    const result = await run(validPatch)
    nowSpy.mockRestore()

    expect(exec.exec).toHaveBeenCalledWith('git', [
      'checkout',
      '-b',
      `umbcloud/dep-123-${mockTimestamp}`
    ])
    expect(exec.exec).toHaveBeenCalledWith('git', [
      ...AUTH_ARGS,
      'push',
      'origin',
      `umbcloud/dep-123-${mockTimestamp}`
    ])
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
    delete process.env.GITHUB_ACTOR
    delete process.env.GITHUB_ACTOR_ID

    await run(validPatch)

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
    fs.existsSync.mockReturnValue(true)
    mockGit({ throwOn: 'commit' })

    await expect(run(validPatch)).rejects.toThrow('commit failed')

    expect(fs.unlinkSync).toHaveBeenCalledWith('./git-patch-dep-123.diff')
  })

  test('handles git checkout failure gracefully in cleanup', async () => {
    mockGit({ throwOn: 'main' })

    const result = await run(validPatch)

    expect(result).toEqual(validResponse)
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Could not return to original branch')
    )
  })

  test('does not write or apply an empty patch', async () => {
    const result = await run('  \n')

    expect(fs.writeFileSync).not.toHaveBeenCalled()
    expect(exec.exec.mock.calls.some((c: any) => c[1].includes('apply'))).toBe(
      false
    )
    expect(result).toEqual(validResponse)
  })

  describe('version fixes', () => {
    const fixes = [
      { name: 'Contoso.Pkg', version: '2.0.0', file: 'src/Contoso.csproj' }
    ]
    const runWithFixes = (patch: string, versionFixes = fixes) =>
      createPullRequestWithPatch(
        patch,
        'main',
        'Title',
        'Body',
        'dep-123',
        'test-token',
        versionFixes
      )
    const applied = [
      {
        name: 'Contoso.Pkg',
        file: 'src/Contoso.csproj',
        from: '1.0.0',
        to: '2.0.0'
      }
    ]
    const commitMessage = () =>
      exec.exec.mock.calls.find((c: any) => c[1].includes('commit'))?.[1].pop()
    const verbs = () =>
      exec.exec.mock.calls.map((c: any) =>
        c[1].find(
          (a: string) =>
            !a.startsWith('-') &&
            !a.startsWith('http') &&
            !a.startsWith('user.')
        )
      )

    test('applies the fixes after an all-rejected patch and commits with the version message', async () => {
      mockGit({ applyCode: 1, status: ' M src/Contoso.csproj\n' })
      applyVersionFixes.mockReturnValue(applied)

      const result = await runWithFixes(validPatch)

      expect(applyVersionFixes).toHaveBeenCalledWith(process.cwd(), fixes)
      expect(commitMessage()).toBe(
        'Update package versions to match Umbraco Cloud (deployment dep-123)'
      )
      expect(exec.exec).toHaveBeenCalledWith('git', [
        ...AUTH_ARGS,
        'push',
        'origin',
        'umbcloud/dep-123'
      ])
      expect(mockOctokit.pulls.create).toHaveBeenCalled()
      expect(result).toEqual(validResponse)
      // patch first, then fixes, then the change check
      const order = verbs()
      expect(order.indexOf('apply')).toBeLessThan(order.indexOf('status'))
    })

    test('applies fixes only when the patch is empty', async () => {
      applyVersionFixes.mockReturnValue(applied)

      const result = await runWithFixes('')

      expect(fs.writeFileSync).not.toHaveBeenCalled()
      expect(verbs()).not.toContain('apply')
      expect(commitMessage()).toBe(
        'Update package versions to match Umbraco Cloud (deployment dep-123)'
      )
      expect(result).toEqual(validResponse)
    })

    test('keeps the patch commit message when the patch changed files but no fix applied', async () => {
      const result = await runWithFixes(validPatch)

      expect(commitMessage()).toBe(
        'Apply Umbraco Cloud changes from deployment dep-123'
      )
      expect(result).toEqual(validResponse)
    })

    test('creates no commit, push or PR when nothing changed', async () => {
      mockGit({ applyCode: 1, status: '' })

      const result = await runWithFixes(validPatch)

      expect(result).toBeUndefined()
      expect(core.warning).toHaveBeenCalledTimes(1)
      expect(core.warning).toHaveBeenCalledWith(
        'No fix PR was created: the patch from Umbraco Cloud did not apply to main and no package versions needed updating. Your repository differs from what was last deployed to Umbraco Cloud; update the package versions listed above manually.'
      )
      const order = verbs()
      expect(order).not.toContain('add')
      expect(order).not.toContain('commit')
      expect(order).not.toContain('push')
      expect(mockOctokit.pulls.create).not.toHaveBeenCalled()
      expect(exec.exec).toHaveBeenLastCalledWith('git', ['checkout', 'main'])
    })
  })

  test('handles GUID-format deployment ID', async () => {
    const guidDeploymentId = '550e8400-e29b-41d4-a716-446655440000'

    const result = await run(validPatch, 'main', guidDeploymentId)

    expect(exec.exec).toHaveBeenCalledWith('git', [
      'checkout',
      '-b',
      `umbcloud/${guidDeploymentId}`
    ])
    expect(result).toEqual(validResponse)
  })

  test('throws error for invalid deployment ID with special characters', async () => {
    await expect(
      run(validPatch, 'main', '550e8400@e29b!41d4#a716$446655440000')
    ).rejects.toThrow(
      'Invalid deployment ID format. Must be a valid GUID or contain only alphanumeric characters and hyphens.'
    )
  })

  test('throws error for deployment ID with spaces', async () => {
    await expect(
      run(validPatch, 'main', '550e8400 e29b 41d4 a716 446655440000')
    ).rejects.toThrow(
      'Invalid deployment ID format. Must be a valid GUID or contain only alphanumeric characters and hyphens.'
    )
  })

  test('accepts valid deployment ID formats', async () => {
    const validIds = [
      '550e8400-e29b-41d4-a716-446655440000', // Standard GUID
      '{550E8400-E29B-41D4-A716-446655440000}', // GUID with braces
      'dep-123', // Simple format
      'ABC123-def456', // Mixed case simple
      'deployment-1234567890abcdef', // Longer format
      '123e4567-e89b-12d3-a456-9AC7CBDCEE52', // Another valid GUID
      '{123E4567-E89B-12D3-A456-9AC7CBDCEE52}' // GUID with braces uppercase
    ]

    for (const deploymentId of validIds) {
      const result = await run(validPatch, 'main', deploymentId)
      expect(result).toEqual(validResponse)
    }
  })

  test('throws error for invalid deployment ID characters', async () => {
    const testCases = [
      'invalid@deployment',
      'deployment#id',
      'deployment id with spaces',
      'deployment/id',
      'deployment\\id',
      'deployment.id'
    ]

    for (const id of testCases) {
      await expect(run(validPatch, 'main', id)).rejects.toThrow(
        'Invalid deployment ID format. Must be a valid GUID or contain only alphanumeric characters and hyphens.'
      )
    }
  })

  test('accepts valid GUID patterns specifically', async () => {
    const validGuids = [
      '123e4567-e89b-12d3-a456-426614174000', // Standard GUID
      '{123E4567-E89B-12D3-A456-426614174000}', // With braces
      '00000000-0000-0000-0000-000000000000', // Nil GUID
      'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF' // All F's
    ]

    for (const guid of validGuids) {
      const result = await run(validPatch, 'main', guid)
      expect(result).toEqual(validResponse)
    }
  })

  test('returns PullRequestInfo type with correct structure', async () => {
    const result = await run(validPatch)

    expect(typeof result.url).toBe('string')
    expect(typeof result.number).toBe('number')
    expect(result.url).toMatch(/^https:\/\/github\.com\/.*\/pull\/\d+$/)
    expect(result.number).toBeGreaterThan(0)
  })

  describe('git patch --reject functionality', () => {
    const workspace = process.cwd()

    beforeEach(() => {
      fs.existsSync.mockReturnValue(true)
    })

    it('lists .rej files with git ls-files instead of walking the tree', async () => {
      mockGit({ applyCode: 1, rej: ['file1.cs.rej'] })

      await run(createComplexFailingPatch(), 'main', 'deploy-456')

      expect(exec.exec).toHaveBeenCalledWith(
        'git',
        ['ls-files', '-z', '--others', '--exclude-standard', '--', '*.rej'],
        expect.objectContaining({ cwd: workspace, silent: true })
      )
      expect(fs.readdirSync).not.toHaveBeenCalled()
    })

    it('should apply patch with --reject and handle .rej files when rejections occur', async () => {
      mockGit({ applyCode: 1, rej: ['file1.cs.rej', 'file2.csproj.rej'] })

      const result = await run(
        createComplexFailingPatch(),
        'main',
        'deploy-456'
      )

      expect(exec.exec).toHaveBeenCalledWith(
        'git',
        [
          'apply',
          '--reject',
          '--ignore-space-change',
          '--ignore-whitespace',
          './git-patch-deploy-456.diff'
        ],
        expect.objectContaining({
          cwd: expect.any(String),
          ignoreReturnCode: true
        })
      )
      expect(core.info).toHaveBeenCalledWith(
        'Found 2 .rej files to collect as artifacts'
      )
      expect(fs.rmSync).toHaveBeenCalledWith(
        expect.stringContaining('file1.cs.rej')
      )
      expect(fs.rmSync).toHaveBeenCalledWith(
        expect.stringContaining('file2.csproj.rej')
      )
      expect(core.info).toHaveBeenCalledWith(
        'Uploaded 2 reject files as artifact: patch-rejections-deploy-456'
      )
      expect(core.info).toHaveBeenCalledWith(
        'Cleaning up temporary reject files directory...'
      )
      expect(exec.exec).toHaveBeenCalledWith('git', ['add', '.'])
      expect(result.url).toBe(validResponse.url)
    })

    it('should handle .rej files in nested directories', async () => {
      mockGit({
        applyCode: 1,
        rej: [
          'file1.rej',
          'src/file2.cs.rej',
          'src/ProjectA/project.csproj.rej'
        ]
      })

      const result = await run(
        createComplexFailingPatch(),
        'main',
        'deploy-789'
      )

      expect(core.info).toHaveBeenCalledWith(
        'Found 3 .rej files to collect as artifacts'
      )
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('Uploaded 3 reject files as artifact')
      )
      expect(result.number).toBe(123)
    })

    it('should fail gracefully when git apply --reject fails', async () => {
      mockGit({ applyCode: 2 })

      await expect(
        run(createComplexFailingPatch(), 'main', 'deploy-fail')
      ).rejects.toThrow('Failed to apply git patch')
    })

    it('should proceed normally when git apply --reject succeeds cleanly', async () => {
      mockGit({ applyCode: 0 })

      const result = await run(
        createSimpleWorkingPatch(),
        'main',
        'deploy-clean'
      )

      expect(core.info).toHaveBeenCalledWith(
        'Git patch applied cleanly with --reject flag'
      )
      expect(core.info).toHaveBeenCalledWith(
        'No .rej files found, patch applied cleanly with --reject flag'
      )
      expect(result.number).toBe(123)
    })

    it('should handle exit code 1 with zero .rej files (edge case)', async () => {
      mockGit({ applyCode: 1 })

      const result = await run(
        createSimpleWorkingPatch(),
        'main',
        'deploy-edge'
      )

      expect(core.info).toHaveBeenCalledWith(
        'Git patch applied with --reject flag, some hunks rejected'
      )
      expect(core.info).toHaveBeenCalledWith(
        'No .rej files found, patch applied cleanly with --reject flag'
      )
      expect(result.number).toBe(123)
    })

    it('preserves relative paths of nested .rej files so same-named files do not collide', async () => {
      fs.existsSync.mockReturnValue(false)
      mockGit({ applyCode: 1, rej: ['a/app.csproj.rej', 'b/app.csproj.rej'] })

      await run(createComplexFailingPatch(), 'main', 'deploy-nested')

      const rejectDir = path.join('/tmp', 'reject-files-deploy-nested')
      const targetA = path.join(rejectDir, 'a', 'app.csproj.rej')
      const targetB = path.join(rejectDir, 'b', 'app.csproj.rej')
      expect(fs.copyFileSync).toHaveBeenCalledWith(
        path.join(workspace, 'a', 'app.csproj.rej'),
        targetA
      )
      expect(fs.copyFileSync).toHaveBeenCalledWith(
        path.join(workspace, 'b', 'app.csproj.rej'),
        targetB
      )
      expect(fs.mkdirSync).toHaveBeenCalledWith(path.dirname(targetA), {
        recursive: true
      })
      expect(core.info).toHaveBeenCalledWith(
        `Collected reject file: ${path.join('a', 'app.csproj.rej')}`
      )
    })

    it('should handle file copy failure gracefully', async () => {
      mockGit({ applyCode: 1, rej: ['test.rej'] })
      fs.copyFileSync.mockImplementationOnce(() => {
        throw new Error('Permission denied')
      })

      await expect(
        run(createComplexFailingPatch(), 'main', 'deploy-copy-fail')
      ).rejects.toThrow('Failed to apply git patch')
    })
  })

  // Helper functions for test data
  function createComplexFailingPatch(): string {
    return `diff --git a/src/MyProject.Web/umbraco/Deploy/Revision/data-type__918d93a589ab42ffba90ad0a8812b7f3.uda b/src/MyProject.Web/umbraco/Deploy/Revision/data-type__918d93a589ab42ffba90ad0a8812b7f3.uda
index abc123..def456 100644
--- a/src/MyProject.Web/umbraco/Deploy/Revision/data-type__918d93a589ab42ffba90ad0a8812b7f3.uda
+++ b/src/MyProject.Web/umbraco/Deploy/Revision/data-type__918d93a589ab42ffba90ad0a8812b7f3.uda
@@ -13,7 +13,7 @@
   "Name": "Content Block - Hero Section",
-    "blocks": []
+    "blocks": [{"contentElementTypeKey": "hero-block-123"}]
diff --git a/src/MyProject.Extensions/MyProject.Extensions.csproj b/src/MyProject.Extensions/MyProject.Extensions.csproj
index 789abc..012def 100644
--- a/src/MyProject.Extensions/MyProject.Extensions.csproj
+++ b/src/MyProject.Extensions/MyProject.Extensions.csproj
@@ -41,7 +41,7 @@
-    <PackageReference Include="Umbraco.Cms" Version="16.1.1" />
+    <PackageReference Include="Umbraco.Cms" Version="16.2.0" />`
  }

  function createSimpleWorkingPatch(): string {
    return `diff --git a/README.md b/README.md
index abc123..def456 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,4 @@
 # Test Repository
+Added a simple line that should apply cleanly.`
  }
})
