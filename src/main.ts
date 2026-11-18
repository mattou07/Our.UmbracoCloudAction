import * as core from '@actions/core'
import { UmbracoCloudAPI } from './api/umbraco-cloud-api.js'
import { handleAddArtifact } from './actions/add-artifact.js'
import { handleStartDeployment } from './actions/start-deployment.js'
import { handleCheckStatus } from './actions/check-status.js'
import { ActionInputs, ActionOutputs } from './types/index.js'
import {
  parseHttpsBaseUrl,
  parseIntegerInput,
  validateRequiredInputs
} from './utils/helpers.js'
import {
  initializeApiLogging,
  uploadApiLogArtifactIfAvailable
} from './utils/api-logging.js'

const DEFAULT_BASE_URL = 'https://api.cloud.umbraco.com'

/**
 * Gets all input values for the action.
 * Throws on malformed numeric or URL inputs so misconfiguration fails fast.
 */
export function getActionInputs(): ActionInputs {
  const inputs: ActionInputs = {
    projectId: core.getInput('projectId', { required: true }),
    apiKey: core.getInput('apiKey', { required: true }),
    baseUrl: parseHttpsBaseUrl(
      'baseUrl',
      core.getInput('baseUrl') || DEFAULT_BASE_URL
    ),
    filePath: core.getInput('filePath', { required: true }),
    targetEnvironmentAlias: core.getInput('targetEnvironmentAlias', {
      required: true
    }),
    commitMessage:
      core.getInput('commitMessage') || 'Deployment from GitHub Actions',
    noBuildAndRestore: parseBoolean(core.getInput('noBuildAndRestore')),
    skipVersionCheck: parseBoolean(core.getInput('skipVersionCheck')),
    timeoutSeconds: parseIntegerInput(
      'timeoutSeconds',
      core.getInput('timeoutSeconds'),
      1200
    ),
    description: core.getInput('description'),
    version: core.getInput('version'),
    baseBranch: core.getInput('base-branch'),
    githubToken: core.getInput('github-token'),
    uploadRetries: parseIntegerInput(
      'upload-retries',
      core.getInput('upload-retries'),
      3
    ),
    uploadRetryDelay: parseIntegerInput(
      'upload-retry-delay',
      core.getInput('upload-retry-delay'),
      10000,
      0
    ),
    uploadTimeout: parseIntegerInput(
      'upload-timeout',
      core.getInput('upload-timeout'),
      60000
    ),
    nugetSourceName: core.getInput('nuget-source-name'),
    nugetSourceUrl: core.getInput('nuget-source-url'),
    nugetSourceUsername: core.getInput('nuget-source-username'),
    nugetSourcePassword: core.getInput('nuget-source-password'),
    excludedPaths: core.getInput('excluded-paths') || '.git/,.github/',
    enableApiLogging: parseBoolean(core.getInput('enable-api-logging')),
    apiLogArtifactName:
      core.getInput('api-log-artifact-name') || 'umbraco-cloud-api-log'
  }

  // Make sure secrets never show up in logs even if they were not passed via
  // the `secrets` context (e.g. hard-coded or built from variables).
  for (const secret of [
    inputs.apiKey,
    inputs.githubToken,
    inputs.nugetSourcePassword
  ]) {
    if (secret) core.setSecret(secret)
  }

  return inputs
}

/**
 * Parse a boolean input. Empty means false; anything other than true/false is
 * rejected (same accepted values as core.getBooleanInput).
 */
function parseBoolean(value: string): boolean {
  const normalised = value.trim().toLowerCase()
  if (normalised === '' || normalised === 'false') return false
  if (normalised === 'true') return true
  throw new TypeError(`Expected "true" or "false" but got "${value}"`)
}

/**
 * Runs the full deployment pipeline: upload artifact → start deployment → check status.
 * Throws if any step fails, including when the deployment ends in a non-Completed state.
 */
export async function runDeployPipeline(
  api: UmbracoCloudAPI,
  inputs: ActionInputs
): Promise<ActionOutputs> {
  validateRequiredInputs(inputs, [
    'projectId',
    'apiKey',
    'filePath',
    'targetEnvironmentAlias'
  ])

  core.info('Step 1/3: Uploading artifact...')
  const artifactOutputs = await handleAddArtifact(api, inputs)
  const artifactId = artifactOutputs.artifactId

  if (!artifactId) {
    throw new Error('Artifact upload failed: no artifactId returned')
  }

  core.startGroup('Step 2/3: Starting deployment...')
  let deploymentId: string | undefined
  try {
    const deploymentOutputs = await handleStartDeployment(api, {
      ...inputs,
      artifactId
    })
    deploymentId = deploymentOutputs.deploymentId
  } finally {
    core.endGroup()
  }

  if (!deploymentId) {
    throw new Error('Deployment start failed: no deploymentId returned')
  }

  core.startGroup('Step 3/3: Verifying deployment status...')
  let statusOutputs: ActionOutputs
  try {
    // Throws when the deployment does not complete successfully
    statusOutputs = await handleCheckStatus(api, { ...inputs, deploymentId })
  } finally {
    core.endGroup()
  }

  const green = '\x1b[32m'
  const reset = '\x1b[0m'
  core.info(
    `${green}Deployment pipeline to Umbraco Cloud complete #h5yr 🎉 ${reset}`
  )
  core.info(
    'Made at: https://www.crumpled-dog.com/ thank them for providing me the resources to put this together 🐕!'
  )
  core.info('You can find me at: https://mu7.dev/')
  core.info(
    'Contact Umbraco Cloud support for website issues: https://www.s1.umbraco.io/projects'
  )
  core.info(
    'Raise issues with the action here: https://github.com/mattou07/Our.UmbracoCloudAction/issues'
  )

  return {
    artifactId,
    deploymentId,
    nugetSourceStatus: artifactOutputs.nugetSourceStatus,
    deploymentState: statusOutputs.deploymentState,
    deploymentStatus: statusOutputs.deploymentStatus,
    changes: statusOutputs.changes
  }
}

/**
 * The main function for the action.
 *
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  let loggingConfigured = false

  try {
    const inputs = getActionInputs()
    initializeApiLogging(
      inputs.enableApiLogging || false,
      inputs.apiLogArtifactName
    )
    loggingConfigured = true

    const api = new UmbracoCloudAPI(inputs.projectId, inputs.apiKey, {
      baseUrl: inputs.baseUrl,
      uploadRetries: inputs.uploadRetries,
      uploadRetryDelayMs: inputs.uploadRetryDelay,
      uploadTimeoutMs: inputs.uploadTimeout
    })

    core.info('Starting Umbraco Cloud deployment pipeline...')

    await runDeployPipeline(api, inputs)
  } catch (error) {
    core.setFailed(
      error instanceof Error ? error.message : 'An unknown error occurred'
    )
  } finally {
    if (loggingConfigured) {
      try {
        await uploadApiLogArtifactIfAvailable()
      } catch (uploadError) {
        core.warning(`Failed to upload API log artifact: ${uploadError}`)
      }
    }
  }
}
