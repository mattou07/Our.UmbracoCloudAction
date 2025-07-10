import * as core from '@actions/core'
import { UmbracoCloudAPI } from '../api/umbraco-cloud-api.js'
import {
  ActionInputs,
  ActionOutputs,
  DeploymentStatus,
  DeploymentResponse
} from '../types/index.js'
import { validateRequiredInputs } from '../utils/helpers.js'
import { pollDeploymentStatus } from '../utils/deployment-polling.js'
import * as fs from 'fs'
import * as path from 'path'
import * as exec from '@actions/exec'
import * as github from '@actions/github'

export async function handleCheckStatus(
  api: UmbracoCloudAPI,
  inputs: ActionInputs
): Promise<ActionOutputs> {
  validateRequiredInputs(inputs as unknown as Record<string, unknown>, [
    'deploymentId',
    'targetEnvironmentAlias'
  ])

  core.info(
    `Checking status for deployment ID: ${inputs.deploymentId}, environment: ${inputs.targetEnvironmentAlias}`
  )

  // Poll until completed/failed, then use the result for the rest of the logic
  const deploymentStatus = await pollDeploymentStatus(
    api.getApiKey(),
    api.getProjectId(),
    inputs.deploymentId!
  )

  core.setOutput('deploymentState', deploymentStatus.deploymentState)
  core.setOutput('deploymentStatus', JSON.stringify(deploymentStatus))

  // Type guard to check if a DeploymentResponse is a DeploymentStatus
  function isDeploymentStatus(
    obj: DeploymentResponse
  ): obj is DeploymentStatus {
    return (
      typeof obj.id === 'string' &&
      typeof obj.projectId === 'string' &&
      typeof obj.targetEnvironmentAlias === 'string' &&
      typeof obj.state === 'string' &&
      typeof obj.createdUtc === 'string'
    )
  }

  if (isDeploymentStatus(deploymentStatus)) {
    if (deploymentStatus.deploymentState === 'Completed') {
      return await handleCompletedDeployment(api, inputs, deploymentStatus)
    } else if (deploymentStatus.deploymentState === 'Failed') {
      return await handleFailedDeployment(api, inputs, deploymentStatus)
    } else {
      core.setFailed(
        `Unexpected deployment status: ${deploymentStatus.deploymentState}`
      )
      return {
        deploymentState: deploymentStatus.deploymentState,
        deploymentStatus: JSON.stringify(deploymentStatus)
      }
    }
  } else {
    throw new Error('DeploymentStatus is not valid')
  }
}

async function handleCompletedDeployment(
  api: UmbracoCloudAPI,
  inputs: ActionInputs,
  deploymentStatus: DeploymentStatus
): Promise<ActionOutputs> {
  core.info('Deployment completed successfully')

  // Get changes (diff) for completed deployment
  try {
    const changes = await api.getChangesById(
      inputs.deploymentId!,
      inputs.targetEnvironmentAlias!
    )
    core.info('Deployment completed. Here is the diff/patch:')
    core.info(changes.changes)
    core.setOutput('changes', JSON.stringify(changes))

    return {
      deploymentState: deploymentStatus.deploymentState,
      deploymentStatus: JSON.stringify(deploymentStatus),
      changes: JSON.stringify(changes)
    }
  } catch (diffError: unknown) {
    if (
      diffError instanceof Error &&
      diffError.message.includes('409 Conflict') &&
      diffError.message.includes('CloudNullDeployment')
    ) {
      core.info(
        'Deployment completed successfully, but there were no changes to apply to the cloud repository.'
      )
    } else {
      core.warning(
        `Could not retrieve changes for completed deployment: ${diffError}`
      )
    }

    return {
      deploymentState: deploymentStatus.deploymentState,
      deploymentStatus: JSON.stringify(deploymentStatus)
    }
  }
}

async function handleFailedDeployment(
  api: UmbracoCloudAPI,
  inputs: ActionInputs,
  deploymentStatus: DeploymentStatus
): Promise<ActionOutputs> {
  core.setFailed('Deployment failed')
  core.warning(
    'Cannot retrieve changes for failed deployments - only completed deployments can be used to get git patches'
  )

  // Get detailed error information from Umbraco Cloud
  const errorDetails = await getErrorDetails(api, inputs)

  // Check if this is a NuGet-related failure
  const isNuGetFailure = errorDetails.some(
    (error) =>
      error.toLowerCase().includes('error restoring packages') ||
      error.toLowerCase().includes('nu1301') ||
      error.toLowerCase().includes('nu1302')
  )

  if (isNuGetFailure) {
    core.warning(
      'NuGet-related failure detected. Skipping PR creation as this is likely a credential or configuration issue.'
    )
    return {
      deploymentState: deploymentStatus.deploymentState,
      deploymentStatus: JSON.stringify(deploymentStatus)
    }
  }

  // Try to get the latest completed deployment and create a PR
  return await attemptPullRequestCreation(api, inputs, deploymentStatus)
}

async function getErrorDetails(
  api: UmbracoCloudAPI,
  inputs: ActionInputs
): Promise<string[]> {
  try {
    const errorDetails = await api.getDeploymentErrorDetails(
      inputs.deploymentId!,
      inputs.targetEnvironmentAlias!
    )

    if (errorDetails.length > 0) {
      core.warning('Deployment failed with the following errors:')
      errorDetails.forEach((error) => {
        core.warning(`- ${error}`)
      })
    }

    core.warning(
      'Please check the Umbraco Cloud portal for more detailed error information.'
    )
    core.warning('Common issues include:')
    core.warning('- Private NuGet repository access')
    core.warning('- Build configuration errors')
    core.warning('- Missing dependencies')
    core.warning('- Version conflicts')

    return errorDetails
  } catch (errorDetailsError) {
    core.warning(
      `Could not retrieve detailed error information: ${errorDetailsError}`
    )
    return []
  }
}

async function attemptPullRequestCreation(
  api: UmbracoCloudAPI,
  inputs: ActionInputs,
  deploymentStatus: DeploymentResponse
): Promise<ActionOutputs> {
  try {
    core.info(
      'Attempting to get latest completed deployment with changes and create PR...'
    )

    const latestCompletedDeploymentId = await api.getLatestCompletedDeployment(
      inputs.targetEnvironmentAlias!
    )

    if (!latestCompletedDeploymentId) {
      core.warning('No completed deployments found to create PR from')
      return {
        deploymentState: deploymentStatus.deploymentState,
        deploymentStatus: JSON.stringify(deploymentStatus)
      }
    }

    core.info(
      `Found latest completed deployment with changes ID: ${latestCompletedDeploymentId}`
    )

    // Get the changes from the latest completed deployment
    const changes = await api.getChangesById(
      latestCompletedDeploymentId,
      inputs.targetEnvironmentAlias!
    )

    core.info('Retrieved changes from latest completed deployment')
    core.setOutput(
      'latest-completed-deployment-id',
      latestCompletedDeploymentId
    )
    core.setOutput('changes', JSON.stringify(changes))

    // Create GitHub PR with the changes
    const prTitle = `Fix: Apply changes from failed deployment ${inputs.deploymentId}`
    const prBody = `This PR applies changes from the latest completed deployment (${latestCompletedDeploymentId}) to fix the failed deployment (${inputs.deploymentId}).

**Failed Deployment ID:** ${inputs.deploymentId}
**Latest Completed Deployment ID:** ${latestCompletedDeploymentId}
**Target Environment:** ${inputs.targetEnvironmentAlias}

The changes in this PR are based on the git patch from the latest successful deployment.`

    await createPullRequestInWorkspace(
      changes.changes,
      prTitle,
      prBody,
      latestCompletedDeploymentId
    )

    return {
      deploymentState: deploymentStatus.deploymentState,
      deploymentStatus: JSON.stringify(deploymentStatus),
      latestCompletedDeploymentId,
      changes: JSON.stringify(changes)
    }
  } catch (error) {
    core.warning(
      `Failed to get latest completed deployment or create PR: ${error}`
    )
    if (
      error instanceof Error &&
      error.message.includes('Not in a git repository')
    ) {
      core.warning(
        'PR creation failed because the action is not running in a git repository context.'
      )
      core.warning(
        'This typically happens when the action is not properly configured in the GitHub Actions workflow.'
      )
      core.warning('Please ensure the workflow includes: actions/checkout@v4')
    }

    return {
      deploymentState: deploymentStatus.deploymentState,
      deploymentStatus: JSON.stringify(deploymentStatus)
    }
  }
}

async function createPullRequestInWorkspace(
  changes: string,
  prTitle: string,
  prBody: string,
  latestCompletedDeploymentId: string
): Promise<void> {
  const runId = process.env.GITHUB_RUN_ID || Date.now().toString()
  const prWorkspace = path.join(
    process.env.GITHUB_WORKSPACE || process.cwd(),
    `pr-workspace-${runId}`
  )

  try {
    // Create the subfolder
    fs.mkdirSync(prWorkspace, { recursive: true })

    // Clone the current repo and checkout the current branch into the subfolder
    const repoUrl = `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${github.context.repo.owner}/${github.context.repo.repo}.git`
    const currentBranch = github.context.ref.replace('refs/heads/', '')

    await exec.exec('git', [
      'clone',
      '--branch',
      currentBranch,
      '--single-branch',
      repoUrl,
      prWorkspace
    ])

    // Change working directory to the subfolder for all git/PR operations
    const originalCwd = process.cwd()
    process.chdir(prWorkspace)

    // Ensure working directory is clean before proceeding
    await ensureCleanWorkingDirectory()

    // Run the PR creation logic (patch application, branch creation, etc.)
    await createPullRequestWithPatch(
      changes,
      currentBranch,
      prTitle,
      prBody,
      latestCompletedDeploymentId
    )

    // Restore original working directory
    process.chdir(originalCwd)
  } finally {
    // Clean up the subfolder after PR creation
    if (fs.existsSync(prWorkspace)) {
      fs.rmSync(prWorkspace, { recursive: true, force: true })
    }
  }
}

async function ensureCleanWorkingDirectory(): Promise<void> {
  let gitStatusOutput = ''
  await exec.exec('git', ['status', '--porcelain'], {
    listeners: {
      stdout: (data) => {
        gitStatusOutput += data.toString()
      }
    }
  })

  if (gitStatusOutput.trim() !== '') {
    core.info('Working directory is not clean. Resetting...')
    await exec.exec('git', ['reset', '--hard', 'HEAD'])
    await exec.exec('git', ['clean', '-fd'])
    core.info('Working directory reset complete')
  } else {
    core.info('Working directory is already clean')
  }
}

// Stub for createPullRequestWithPatch if not imported
async function createPullRequestWithPatch(
  _changes: unknown,
  _currentBranch: unknown,
  _prTitle: unknown,
  _prBody: unknown,
  _latestCompletedDeploymentId: unknown
): Promise<void> {
  // Implement or mock as needed
  core.info('createPullRequestWithPatch called (stub)')
}
