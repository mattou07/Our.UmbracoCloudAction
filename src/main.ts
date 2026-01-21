import * as core from '@actions/core'
import { UmbracoCloudAPI } from './api/umbraco-cloud-api.js'
import { handleAddArtifact } from './actions/add-artifact.js'
import { handleStartDeployment } from './actions/start-deployment.js'
import { handleCheckStatus } from './actions/check-status.js'
import { ActionInputs, ActionOutputs } from './types/index.js'
import { validateRequiredInputs } from './utils/helpers.js'

/**
 * Gets all input values for the action
 */
export function getActionInputs(): ActionInputs {
  return {
    projectId: core.getInput('projectId', { required: true }),
    apiKey: core.getInput('apiKey', { required: true }),
    baseUrl: core.getInput('baseUrl') || 'https://api.cloud.umbraco.com',
    filePath: core.getInput('filePath', { required: true }),
    targetEnvironmentAlias: core.getInput('targetEnvironmentAlias', {
      required: true
    }),
    commitMessage:
      core.getInput('commitMessage') || 'Deployment from GitHub Actions',
    noBuildAndRestore: core.getBooleanInput('noBuildAndRestore'),
    skipVersionCheck: core.getBooleanInput('skipVersionCheck'),
    timeoutSeconds: parseInt(core.getInput('timeoutSeconds') || '1200', 10),
    description: core.getInput('description'),
    version: core.getInput('version'),
    baseBranch: core.getInput('baseBranch'),
    uploadRetries: parseInt(core.getInput('upload-retries') || '3', 10),
    uploadRetryDelay: parseInt(
      core.getInput('upload-retry-delay') || '10000',
      10
    ),
    uploadTimeout: parseInt(core.getInput('upload-timeout') || '60000', 10),
    nugetSourceName: core.getInput('nuget-source-name'),
    nugetSourceUrl: core.getInput('nuget-source-url'),
    nugetSourceUsername: core.getInput('nuget-source-username'),
    nugetSourcePassword: core.getInput('nuget-source-password'),
    excludedPaths: core.getInput('excluded-paths') || '.git/,.github/'
  }
}

/**
 * Runs the full deployment pipeline: upload artifact → start deployment → check status
 * This is the single code path for the action (v1 breaking change).
 */
export async function runDeployPipeline(
  api: UmbracoCloudAPI,
  inputs: ActionInputs
): Promise<ActionOutputs> {
  // Validate required inputs for the pipeline
  validateRequiredInputs(inputs as unknown as Record<string, unknown>, [
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

  core.info(`Artifact uploaded successfully: ${artifactId}`)

  core.startGroup('Step 2/3: Starting deployment...')
  const deployInputs: ActionInputs = {
    ...inputs,
    artifactId
  }
  const deploymentOutputs = await handleStartDeployment(api, deployInputs)
  const deploymentId = deploymentOutputs.deploymentId

  if (!deploymentId) {
    core.endGroup()
    throw new Error('Deployment start failed: no deploymentId returned')
  }

  core.info(`Deployment started successfully: ${deploymentId}`)
  core.endGroup()

  core.startGroup('Step 3/3: Verifying deployment status...')
  const statusInputs: ActionInputs = {
    ...inputs,
    deploymentId
  }
  const statusOutputs = await handleCheckStatus(api, statusInputs)

  const green = '\x1b[32m'
  const reset = '\x1b[0m'
  core.info(
    `${green}Deployment pipeline to Umbraco Cloud complete #h5yr 🎉 ${reset}`
  )
  core.info('Find me at: https://mu7.dev/')
  core.endGroup()

  // Return combined outputs
  return {
    artifactId,
    deploymentId,
    deploymentState: statusOutputs.deploymentState,
    deploymentStatus: statusOutputs.deploymentStatus,
    changes: statusOutputs.changes,
    prUrl: statusOutputs.prUrl,
    prNumber: statusOutputs.prNumber
  }
}

/**
 * The main function for the action.
 *
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const inputs = getActionInputs()

    // Initialize API client
    const api = new UmbracoCloudAPI(
      inputs.projectId,
      inputs.apiKey,
      inputs.baseUrl
    )

    core.info('Starting Umbraco Cloud deployment pipeline...')

    await runDeployPipeline(api, inputs)
  } catch (error) {
    core.error(`Error running the action: ${error}`)
    if (error instanceof Error) {
      core.setFailed(error.message)
    } else {
      core.setFailed('An unknown error occurred')
    }
  }
}
