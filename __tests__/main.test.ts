import { jest } from '@jest/globals'
import type { ActionInputs, ActionOutputs } from '../src/types/index.js'

// --- ESM mocks -------------------------------------------------------------

// Minimal @actions/core: getInput mirrors the real implementation (env lookup,
// trimming, required check) so input parsing is exercised end to end.
const core = {
  getInput: jest.fn((name: string, options?: { required?: boolean }) => {
    const value = (
      process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] || ''
    ).trim()
    if (options?.required && !value) {
      throw new Error(`Input required and not supplied: ${name}`)
    }
    return value
  }),
  setSecret: jest.fn(),
  setFailed: jest.fn(),
  setOutput: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  startGroup: jest.fn(),
  endGroup: jest.fn()
}
jest.unstable_mockModule('@actions/core', () => core)

type Handler = (api: unknown, inputs: ActionInputs) => Promise<ActionOutputs>
const handleAddArtifact = jest.fn<Handler>()
const handleStartDeployment = jest.fn<Handler>()
const handleCheckStatus = jest.fn<Handler>()
jest.unstable_mockModule('../src/actions/add-artifact.js', () => ({
  handleAddArtifact
}))
jest.unstable_mockModule('../src/actions/start-deployment.js', () => ({
  handleStartDeployment
}))
jest.unstable_mockModule('../src/actions/check-status.js', () => ({
  handleCheckStatus
}))

const initializeApiLogging = jest.fn()
const uploadApiLogArtifactIfAvailable = jest.fn<() => Promise<void>>()
jest.unstable_mockModule('../src/utils/api-logging.js', () => ({
  initializeApiLogging,
  uploadApiLogArtifactIfAvailable
}))

const UmbracoCloudAPI = jest.fn()
jest.unstable_mockModule('../src/api/umbraco-cloud-api.js', () => ({
  UmbracoCloudAPI
}))

const { getActionInputs, run, runDeployPipeline } = await import(
  '../src/main.js'
)

// --- helpers ---------------------------------------------------------------

type Inputs = Record<string, string | undefined>
function defineEnv(inputs: Inputs) {
  for (const [key, value] of Object.entries(inputs)) {
    const envKey = `INPUT_${key.toUpperCase()}`
    if (value === undefined) delete process.env[envKey]
    else process.env[envKey] = value
  }
}

const requiredInputs: Inputs = {
  projectId: 'pid',
  apiKey: 'key',
  filePath: './artifact.zip',
  targetEnvironmentAlias: 'dev'
}

function clearInputs() {
  for (const key in process.env) {
    if (key.startsWith('INPUT_')) delete process.env[key]
  }
}

const loggedInfo = () => core.info.mock.calls.map((c) => String(c[0]))

describe('main.ts', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    clearInputs()
  })

  afterAll(() => clearInputs())

  describe('getActionInputs - Valid Inputs', () => {
    test('parses all required inputs correctly', () => {
      defineEnv(requiredInputs)

      const result = getActionInputs()

      expect(result.projectId).toBe('pid')
      expect(result.apiKey).toBe('key')
      expect(result.filePath).toBe('./artifact.zip')
      expect(result.targetEnvironmentAlias).toBe('dev')
    })

    test('throws when a required input is missing', () => {
      defineEnv({ ...requiredInputs, apiKey: undefined })
      expect(() => getActionInputs()).toThrow(
        'Input required and not supplied: apiKey'
      )
    })

    test('parses all inputs with custom values', () => {
      defineEnv({
        projectId: 'pid',
        apiKey: 'key',
        filePath: '/custom/path/artifact.zip',
        targetEnvironmentAlias: 'staging',
        baseUrl: 'https://custom-api.umbraco.com/',
        commitMessage: 'Custom deploy message',
        timeoutSeconds: '2400',
        noBuildAndRestore: 'true',
        skipVersionCheck: 'true',
        description: 'Custom artifact description',
        version: '2.1.0',
        'base-branch': 'develop',
        'github-token': 'ghs_token',
        'upload-retries': '5',
        'upload-retry-delay': '15000',
        'upload-timeout': '120000',
        'nuget-source-name': 'CustomSource',
        'nuget-source-url': 'https://nuget.custom.com/v3/index.json',
        'nuget-source-username': 'nuget-user',
        'nuget-source-password': 'nuget-pass',
        'excluded-paths': '.git/,.github/,.vscode/',
        'enable-api-logging': 'true',
        'api-log-artifact-name': 'my-log'
      })

      const result = getActionInputs()

      expect(result).toMatchObject<Partial<ActionInputs>>({
        projectId: 'pid',
        apiKey: 'key',
        filePath: '/custom/path/artifact.zip',
        targetEnvironmentAlias: 'staging',
        baseUrl: 'https://custom-api.umbraco.com',
        commitMessage: 'Custom deploy message',
        timeoutSeconds: 2400,
        noBuildAndRestore: true,
        skipVersionCheck: true,
        description: 'Custom artifact description',
        version: '2.1.0',
        baseBranch: 'develop',
        githubToken: 'ghs_token',
        uploadRetries: 5,
        uploadRetryDelay: 15000,
        uploadTimeout: 120000,
        nugetSourceName: 'CustomSource',
        nugetSourceUrl: 'https://nuget.custom.com/v3/index.json',
        nugetSourceUsername: 'nuget-user',
        nugetSourcePassword: 'nuget-pass',
        excludedPaths: '.git/,.github/,.vscode/',
        enableApiLogging: true,
        apiLogArtifactName: 'my-log'
      })
    })

    test('uses default values for optional inputs', () => {
      defineEnv(requiredInputs)

      const result = getActionInputs()

      expect(result).toMatchObject<Partial<ActionInputs>>({
        baseUrl: 'https://api.cloud.umbraco.com',
        commitMessage: 'Deployment from GitHub Actions',
        timeoutSeconds: 1200,
        noBuildAndRestore: false,
        skipVersionCheck: false,
        uploadRetries: 3,
        uploadRetryDelay: 10000,
        uploadTimeout: 60000,
        excludedPaths: '.git/,.github/',
        enableApiLogging: false,
        apiLogArtifactName: 'umbraco-cloud-api-log',
        description: '',
        version: '',
        baseBranch: '',
        githubToken: ''
      })
    })
  })

  describe('getActionInputs - secrets', () => {
    test('masks api key, github token and nuget password', () => {
      defineEnv({
        ...requiredInputs,
        'github-token': 'ghs_secret',
        'nuget-source-password': 'nuget-secret'
      })

      getActionInputs()

      expect(core.setSecret).toHaveBeenCalledWith('key')
      expect(core.setSecret).toHaveBeenCalledWith('ghs_secret')
      expect(core.setSecret).toHaveBeenCalledWith('nuget-secret')
    })

    test('does not register empty secrets', () => {
      defineEnv(requiredInputs)
      getActionInputs()
      expect(core.setSecret).toHaveBeenCalledTimes(1)
      expect(core.setSecret).toHaveBeenCalledWith('key')
    })
  })

  describe('getActionInputs - Boolean Input Parsing', () => {
    test('correctly parses boolean true values', () => {
      defineEnv({
        ...requiredInputs,
        noBuildAndRestore: 'true',
        skipVersionCheck: 'TRUE'
      })

      const result = getActionInputs()

      expect(result.noBuildAndRestore).toBe(true)
      expect(result.skipVersionCheck).toBe(true)
    })

    test('correctly parses boolean false values', () => {
      defineEnv({
        ...requiredInputs,
        noBuildAndRestore: 'false',
        skipVersionCheck: 'false'
      })

      const result = getActionInputs()

      expect(result.noBuildAndRestore).toBe(false)
      expect(result.skipVersionCheck).toBe(false)
    })

    test('defaults to false for missing boolean inputs', () => {
      defineEnv(requiredInputs)
      expect(process.env.INPUT_NOBUILDANDRESTORE).toBeUndefined()

      const inputs = getActionInputs()

      expect(inputs.noBuildAndRestore).toBe(false)
      expect(inputs.skipVersionCheck).toBe(false)
      expect(inputs.enableApiLogging).toBe(false)
    })

    test('throws for non-boolean values', () => {
      defineEnv({ ...requiredInputs, noBuildAndRestore: 'yes' })
      expect(() => getActionInputs()).toThrow(
        'Expected "true" or "false" but got "yes"'
      )
    })
  })

  describe('getActionInputs - Numeric Input Parsing', () => {
    test('correctly parses numeric inputs', () => {
      defineEnv({
        ...requiredInputs,
        timeoutSeconds: '3600',
        'upload-retries': '7',
        'upload-retry-delay': '20000',
        'upload-timeout': '90000'
      })

      const inputs = getActionInputs()

      expect(inputs.timeoutSeconds).toBe(3600)
      expect(inputs.uploadRetries).toBe(7)
      expect(inputs.uploadRetryDelay).toBe(20000)
      expect(inputs.uploadTimeout).toBe(90000)
    })

    test('throws for non-numeric timeoutSeconds', () => {
      defineEnv({ ...requiredInputs, timeoutSeconds: 'not-a-number' })
      expect(() => getActionInputs()).toThrow(/timeoutSeconds.*not a whole/)
    })

    test('throws for non-numeric upload-retries', () => {
      defineEnv({ ...requiredInputs, 'upload-retries': 'invalid' })
      expect(() => getActionInputs()).toThrow(/upload-retries/)
    })

    test('throws for negative values', () => {
      defineEnv({ ...requiredInputs, 'upload-timeout': '-5' })
      expect(() => getActionInputs()).toThrow(/upload-timeout.*at least 1/)
    })

    test('throws for zero timeoutSeconds', () => {
      defineEnv({ ...requiredInputs, timeoutSeconds: '0' })
      expect(() => getActionInputs()).toThrow(/timeoutSeconds.*at least 1/)
    })

    test('throws for zero upload-retries', () => {
      defineEnv({ ...requiredInputs, 'upload-retries': '0' })
      expect(() => getActionInputs()).toThrow(/upload-retries.*at least 1/)
    })

    test('allows zero upload-retry-delay', () => {
      defineEnv({ ...requiredInputs, 'upload-retry-delay': '0' })
      expect(getActionInputs().uploadRetryDelay).toBe(0)
    })

    test('handles very large numeric values', () => {
      defineEnv({
        ...requiredInputs,
        timeoutSeconds: '999999',
        'upload-timeout': '2147483647'
      })

      const inputs = getActionInputs()
      expect(inputs.timeoutSeconds).toBe(999999)
      expect(inputs.uploadTimeout).toBe(2147483647)
    })
  })

  describe('getActionInputs - baseUrl', () => {
    test('throws for non-https baseUrl', () => {
      defineEnv({ ...requiredInputs, baseUrl: 'http://api.cloud.umbraco.com' })
      expect(() => getActionInputs()).toThrow(/must use https/)
    })

    test('throws for an invalid URL', () => {
      defineEnv({ ...requiredInputs, baseUrl: 'not a url' })
      expect(() => getActionInputs()).toThrow(/is not a URL/)
    })
  })

  describe('getActionInputs - Edge Cases', () => {
    test('handles empty string inputs for optional fields', () => {
      defineEnv({ ...requiredInputs, baseUrl: '', commitMessage: '' })

      const inputs = getActionInputs()
      expect(inputs.baseUrl).toBe('https://api.cloud.umbraco.com')
      expect(inputs.commitMessage).toBe('Deployment from GitHub Actions')
    })

    test('handles whitespace-only inputs', () => {
      defineEnv({
        projectId: '  test-project  ',
        apiKey: '  test-key  ',
        filePath: '  ./artifact.zip  ',
        targetEnvironmentAlias: '  dev  ',
        description: '\t\n'
      })

      const inputs = getActionInputs()
      expect(inputs.projectId).toBe('test-project')
      expect(inputs.apiKey).toBe('test-key')
      expect(inputs.filePath).toBe('./artifact.zip')
      expect(inputs.targetEnvironmentAlias).toBe('dev')
      expect(inputs.description).toBe('')
    })
  })

  describe('runDeployPipeline', () => {
    const api = {} as never
    const inputs: ActionInputs = {
      projectId: 'pid',
      apiKey: 'key',
      filePath: './a.zip',
      targetEnvironmentAlias: 'dev'
    }

    beforeEach(() => {
      handleAddArtifact.mockResolvedValue({
        artifactId: 'art-1',
        nugetSourceStatus: 'skipped'
      })
      handleStartDeployment.mockResolvedValue({ deploymentId: 'dep-1' })
      handleCheckStatus.mockResolvedValue({
        deploymentState: 'Completed',
        deploymentStatus: '{}',
        changes: 'diff'
      })
    })

    test('chains the three steps and returns combined outputs', async () => {
      const result = await runDeployPipeline(api, inputs)

      expect(handleStartDeployment).toHaveBeenCalledWith(
        api,
        expect.objectContaining({ artifactId: 'art-1' })
      )
      expect(handleCheckStatus).toHaveBeenCalledWith(
        api,
        expect.objectContaining({ deploymentId: 'dep-1' })
      )
      expect(result).toEqual({
        artifactId: 'art-1',
        deploymentId: 'dep-1',
        nugetSourceStatus: 'skipped',
        deploymentState: 'Completed',
        deploymentStatus: '{}',
        changes: 'diff'
      })
      expect(loggedInfo().some((m) => m.includes('#h5yr'))).toBe(true)
    })

    test('throws when no artifactId is returned', async () => {
      handleAddArtifact.mockResolvedValue({})
      await expect(runDeployPipeline(api, inputs)).rejects.toThrow(
        'no artifactId returned'
      )
      expect(handleStartDeployment).not.toHaveBeenCalled()
    })

    test('throws when no deploymentId is returned', async () => {
      handleStartDeployment.mockResolvedValue({})
      await expect(runDeployPipeline(api, inputs)).rejects.toThrow(
        'no deploymentId returned'
      )
      expect(handleCheckStatus).not.toHaveBeenCalled()
      expect(core.endGroup).toHaveBeenCalledTimes(1)
    })

    test('does not print the success banner when the status check throws', async () => {
      handleCheckStatus.mockRejectedValue(new Error('Deployment dep-1 failed'))
      await expect(runDeployPipeline(api, inputs)).rejects.toThrow(
        'Deployment dep-1 failed'
      )
      expect(loggedInfo().some((m) => m.includes('#h5yr'))).toBe(false)
      expect(core.endGroup).toHaveBeenCalledTimes(2)
    })
  })

  describe('run', () => {
    beforeEach(() => {
      defineEnv(requiredInputs)
      handleAddArtifact.mockResolvedValue({ artifactId: 'art-1' })
      handleStartDeployment.mockResolvedValue({ deploymentId: 'dep-1' })
      handleCheckStatus.mockResolvedValue({ deploymentState: 'Completed' })
      uploadApiLogArtifactIfAvailable.mockResolvedValue(undefined)
    })

    test('success: prints banner, does not fail, uploads API log', async () => {
      await run()

      expect(UmbracoCloudAPI).toHaveBeenCalledWith('pid', 'key', {
        baseUrl: 'https://api.cloud.umbraco.com',
        uploadRetries: 3,
        uploadRetryDelayMs: 10000,
        uploadTimeoutMs: 60000
      })
      expect(initializeApiLogging).toHaveBeenCalledWith(
        false,
        'umbraco-cloud-api-log'
      )
      expect(loggedInfo().some((m) => m.includes('#h5yr'))).toBe(true)
      expect(core.setFailed).not.toHaveBeenCalled()
      expect(uploadApiLogArtifactIfAvailable).toHaveBeenCalledTimes(1)
    })

    test('failed deployment: setFailed with message, no banner, log still uploaded', async () => {
      handleCheckStatus.mockRejectedValue(new Error('Deployment dep-1 failed'))

      await run()

      expect(core.setFailed).toHaveBeenCalledWith('Deployment dep-1 failed')
      expect(loggedInfo().some((m) => m.includes('complete #h5yr'))).toBe(false)
      expect(uploadApiLogArtifactIfAvailable).toHaveBeenCalledTimes(1)
    })

    test('non-Error throws produce a generic failure message', async () => {
      handleAddArtifact.mockRejectedValue('boom')
      await run()
      expect(core.setFailed).toHaveBeenCalledWith('An unknown error occurred')
    })

    test('invalid inputs: setFailed and no log upload (logging not configured)', async () => {
      defineEnv({ timeoutSeconds: 'abc' })

      await run()

      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('timeoutSeconds')
      )
      expect(initializeApiLogging).not.toHaveBeenCalled()
      expect(uploadApiLogArtifactIfAvailable).not.toHaveBeenCalled()
      expect(handleAddArtifact).not.toHaveBeenCalled()
    })

    test('warns when API log upload fails', async () => {
      uploadApiLogArtifactIfAvailable.mockRejectedValue(new Error('upload err'))

      await run()

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Failed to upload API log artifact')
      )
      expect(core.setFailed).not.toHaveBeenCalled()
    })
  })
})
