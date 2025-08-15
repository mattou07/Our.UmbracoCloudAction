import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { UmbracoCloudAPI } from '../api/umbraco-cloud-api.js'
import {
  ActionInputs,
  ActionOutputs,
  DeploymentResponse
} from '../types/index.js'
import { validateRequiredInputs } from '../utils/helpers.js'
import { pollDeploymentStatus } from '../utils/deployment-polling.js'
import {
  createPullRequestWithPatch,
  createPullRequestWithMultipleDeployments
} from '../github/pull-request.js'
import * as fs from 'fs'
import * as path from 'path'
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

  // Handle deployment based on state
  if (deploymentStatus.deploymentState === 'Completed') {
    return await handleCompletedDeployment(api, inputs, deploymentStatus)
  } else if (deploymentStatus.deploymentState === 'Failed') {
    return await handleFailedDeployment(api, inputs, deploymentStatus)
  } else {
    // Check if the deployment failed due to updating markers
    const hasUpdatingMarkerError = checkForUpdatingMarkerError(deploymentStatus)
    if (hasUpdatingMarkerError) {
      core.setFailed(
        `Deployment failed due to updating marker: The site is currently being updated and cannot be upgraded. Please wait for the update to complete and retry the deployment.`
      )
    } else {
      core.setFailed(
        `Unexpected deployment status: ${deploymentStatus.deploymentState}`
      )
    }

    return {
      deploymentState: deploymentStatus.deploymentState,
      deploymentStatus: JSON.stringify(deploymentStatus)
    }
  }
}

/**
 * Check if the deployment failed due to updating marker blocking
 */
function checkForUpdatingMarkerError(
  deploymentStatus: DeploymentResponse
): boolean {
  if (!deploymentStatus.deploymentStatusMessages) {
    return false
  }

  return deploymentStatus.deploymentStatusMessages.some(
    (msg) =>
      msg.message.includes(
        "The site can't be upgraded as it's blocked with the following markers: updating"
      ) ||
      msg.message.includes('CheckBlockingMarkers') ||
      msg.message.includes('blocked with the following markers: updating')
  )
}

async function handleCompletedDeployment(
  api: UmbracoCloudAPI,
  inputs: ActionInputs,
  deploymentStatus: DeploymentResponse
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
  deploymentStatus: DeploymentResponse
): Promise<ActionOutputs> {
  // Check for specific updating marker error first
  const hasUpdatingMarkerError = checkForUpdatingMarkerError(deploymentStatus)
  if (hasUpdatingMarkerError) {
    core.setFailed('Deployment failed due to leftover upgrade markers')
    core.error(
      '❌ Deployment is blocked by leftover upgrade markers interfering with the Deploy process.'
    )
    core.error(
      'This might happen if your environment was restarted during an upgrade, or the upgrade process encountered issues.'
    )
    core.error('')
    core.error('Resolution using KUDU:')
    core.error(
      '1. Access KUDU on the target environment via the Umbraco Cloud portal'
    )
    core.error('2. Navigate to site > locks folder')
    core.error(
      '3. Remove files named: upgrading, upgrade-failed, or failed-upgrade'
    )
    core.error('4. Repeat the operation on the target environment')
    core.error('')
    core.error('For detailed steps see:')
    core.error(
      'https://docs.umbraco.com/umbraco-cloud/optimize-and-maintain-your-site/monitor-and-troubleshoot/resolve-issues-quickly-and-efficiently/deployments/deployment-failed'
    )

    return {
      deploymentState: deploymentStatus.deploymentState,
      deploymentStatus: JSON.stringify(deploymentStatus)
    }
  }

  core.setFailed('Deployment failed')
  core.warning(
    'Deployment failed - attempting to retrieve git patch to fix the issue'
  )

  // Get detailed error information from Umbraco Cloud
  const errorDetails = await getErrorDetails(api, inputs)

  // Check if this is a NuGet-related failure first (exit early, no PR creation)
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

  // Check if this is a version-related failure that can be fixed with a patch
  const isVersionFailure = errorDetails.some(
    (error) =>
      error.toLowerCase().includes('downgraded') ||
      error.toLowerCase().includes('version') ||
      error.toLowerCase().includes('package')
  )

  if (isVersionFailure) {
    core.info(
      'Version-related deployment failure detected. Attempting to get git patch to synchronise versions...'
    )

    try {
      // Try to get the git patch from the failed deployment
      const changes = await api.getChangesById(
        inputs.deploymentId!,
        inputs.targetEnvironmentAlias!
      )

      core.info('Successfully retrieved git patch from failed deployment')
      core.setOutput('changes', JSON.stringify(changes))

      // Create GitHub PR with the patch
      const prTitle = `Fix: Update package versions for deployment ${inputs.deploymentId}`
      const prBody = `This PR applies the git patch from Umbraco Cloud to fix package version issues in deployment ${inputs.deploymentId}.

**Failed Deployment ID:** ${inputs.deploymentId}
**Target Environment:** ${inputs.targetEnvironmentAlias}
**Issue:** Package version downgrade detected

**Errors:**
${errorDetails.map((error) => `- ${error}`).join('\n')}

The changes in this PR contain the necessary package version updates from Umbraco Cloud.`

      await createPullRequestInWorkspace(
        changes.changes,
        prTitle,
        prBody,
        inputs.deploymentId!
      )

      return {
        deploymentState: deploymentStatus.deploymentState,
        deploymentStatus: JSON.stringify(deploymentStatus),
        changes: JSON.stringify(changes)
      }
    } catch (patchError) {
      core.warning(
        `Could not retrieve git patch from failed deployment: ${patchError}`
      )
      core.info('Falling back to latest completed deployment approach...')

      // Fall back to the original approach
      return await attemptPullRequestCreation(api, inputs, deploymentStatus)
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
      'Attempting to get multiple completed deployments with changes and create PR...'
    )

    // Get multiple deployment IDs as fallbacks
    const deploymentIds = await api.getLatestCompletedDeployments(
      inputs.targetEnvironmentAlias!,
      10 // Try up to 10 deployments for better fallback coverage
    )

    if (deploymentIds.length === 0) {
      core.warning('No completed deployments found to create PR from')
      return {
        deploymentState: deploymentStatus.deploymentState,
        deploymentStatus: JSON.stringify(deploymentStatus)
      }
    }

    core.info(
      `Found ${deploymentIds.length} completed deployment(s) with changes: ${deploymentIds.join(', ')}`
    )

    // Create GitHub PR with the changes, trying multiple deployments
    const prTitle = `Fix: Apply changes from failed deployment ${inputs.deploymentId}`
    const prBody = (
      deploymentId: string
    ) => `This PR applies changes from completed deployment (${deploymentId}) to fix the failed deployment (${inputs.deploymentId}).

**Failed Deployment ID:** ${inputs.deploymentId}
**Source Deployment ID:** ${deploymentId}
**Target Environment:** ${inputs.targetEnvironmentAlias}

The changes in this PR are based on the git patch from a successful deployment.`

    // Function to get changes for a specific deployment
    const getChangesFunction = async (
      deploymentId: string
    ): Promise<string> => {
      const changes = await api.getChangesById(
        deploymentId,
        inputs.targetEnvironmentAlias!
      )
      return changes.changes
    }

    // Try to create PR with multiple deployments in workspace
    const result = await createPullRequestWithMultipleDeploymentsInWorkspace(
      deploymentIds,
      getChangesFunction,
      github.context.ref.replace('refs/heads/', ''),
      prTitle,
      prBody(deploymentIds[0]) // Use the first deployment ID for the body initially
    )

    // Get the successful deployment ID from the result
    const successfulDeploymentId = result.deploymentId

    // Get the changes from the successful deployment for the output
    const changes = await api.getChangesById(
      successfulDeploymentId,
      inputs.targetEnvironmentAlias!
    )

    core.info('Retrieved changes from latest completed deployment')
    core.setOutput('latest-completed-deployment-id', successfulDeploymentId)
    core.setOutput('changes', JSON.stringify(changes))

    return {
      deploymentState: deploymentStatus.deploymentState,
      deploymentStatus: JSON.stringify(deploymentStatus),
      latestCompletedDeploymentId: successfulDeploymentId,
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
  sourceDeploymentId: string
): Promise<void> {
  const runId = process.env.GITHUB_RUN_ID || Date.now().toString()
  const prWorkspace = path.join(
    process.env.GITHUB_WORKSPACE || process.cwd(),
    `pr-workspace-${runId}`
  )

  // Store original working directory before any changes
  const originalCwd = process.cwd()

  try {
    // The GITHUB_TOKEN is automatically available in GitHub Actions environment
    const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
    if (!githubToken) {
      throw new Error(
        'GITHUB_TOKEN or GH_TOKEN environment variable is not available. Ensure the workflow has proper permissions.'
      )
    }

    // Create the subfolder
    fs.mkdirSync(prWorkspace, { recursive: true })

    // Clone the current repo and checkout the current branch into the subfolder
    // Use the token in the URL for authentication
    const repoUrl = `https://x-access-token:${githubToken}@github.com/${github.context.repo.owner}/${github.context.repo.repo}.git`
    const currentBranch = github.context.ref.replace('refs/heads/', '')

    core.info(`Cloning repository to: ${prWorkspace}`)
    core.info(
      `Repository URL: https://github.com/${github.context.repo.owner}/${github.context.repo.repo}.git`
    )
    core.info(`Branch: ${currentBranch}`)

    await exec.exec('git', [
      'clone',
      '--branch',
      currentBranch,
      repoUrl,
      prWorkspace
    ])

    // Change working directory to the subfolder for all git/PR operations
    process.chdir(prWorkspace)

    // Ensure working directory is clean before proceeding
    await ensureCleanWorkingDirectory()

    // Run the PR creation logic (patch application, branch creation, etc.)
    await createPullRequestWithPatch(
      changes,
      currentBranch,
      prTitle,
      prBody,
      sourceDeploymentId
    )

    // Restore original working directory
    process.chdir(originalCwd)
  } catch (error) {
    // Restore original working directory even on error
    process.chdir(originalCwd)
    core.error(`Failed to create PR workspace or clone repository: ${error}`)

    if (error instanceof Error) {
      if (
        error.message.includes('Authentication failed') ||
        error.message.includes('fatal: Authentication failed')
      ) {
        core.error(
          'Git authentication failed. This suggests an issue with the GITHUB_TOKEN.'
        )
        core.error('Ensure that:')
        core.error('1. The workflow has appropriate permissions')
        core.error('2. The GITHUB_TOKEN is properly set')
        core.error('3. The repository is accessible with the provided token')
      } else if (
        error.message.includes('Repository not found') ||
        error.message.includes('fatal: repository')
      ) {
        core.error('Repository not found or not accessible.')
        core.error(
          'Check that the repository exists and the token has the necessary permissions.'
        )
      }
    }

    throw error
  } finally {
    // Clean up the subfolder after PR creation
    if (fs.existsSync(prWorkspace)) {
      try {
        fs.rmSync(prWorkspace, { recursive: true, force: true })
        core.info(`Cleaned up workspace: ${prWorkspace}`)
      } catch (cleanupError) {
        core.warning(`Failed to clean up workspace: ${cleanupError}`)
      }
    }
  }
}

async function createPullRequestWithMultipleDeploymentsInWorkspace(
  deploymentIds: string[],
  getChangesFunction: (deploymentId: string) => Promise<string>,
  baseBranch: string,
  prTitle: string,
  prBody: string
): Promise<{ deploymentId: string }> {
  const runId = process.env.GITHUB_RUN_ID || Date.now().toString()
  const prWorkspace = path.join(
    process.env.GITHUB_WORKSPACE || process.cwd(),
    `pr-workspace-${runId}`
  )

  // Store original working directory before any changes
  const originalCwd = process.cwd()

  try {
    // The GITHUB_TOKEN is automatically available in GitHub Actions environment
    const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
    if (!githubToken) {
      throw new Error(
        'GITHUB_TOKEN or GH_TOKEN environment variable is not available. Ensure the workflow has proper permissions.'
      )
    }

    // Create the subfolder
    fs.mkdirSync(prWorkspace, { recursive: true })

    // Clone the current repo and checkout the current branch into the subfolder
    // Use the token in the URL for authentication
    const repoUrl = `https://x-access-token:${githubToken}@github.com/${github.context.repo.owner}/${github.context.repo.repo}.git`
    const currentBranch = github.context.ref.replace('refs/heads/', '')

    core.info(`Cloning repository to: ${prWorkspace}`)
    core.info(
      `Repository URL: https://github.com/${github.context.repo.owner}/${github.context.repo.repo}.git`
    )
    core.info(`Branch: ${currentBranch}`)

    await exec.exec('git', [
      'clone',
      '--branch',
      currentBranch,
      repoUrl,
      prWorkspace
    ])

    // Change working directory to the subfolder for all git/PR operations
    process.chdir(prWorkspace)

    // Ensure working directory is clean before proceeding
    await ensureCleanWorkingDirectory()

    // Try multiple deployments using the existing multi-deployment function
    const result = await createPullRequestWithMultipleDeployments(
      deploymentIds,
      getChangesFunction,
      baseBranch,
      prTitle,
      prBody
    )

    // Restore original working directory
    process.chdir(originalCwd)

    return result
  } catch (error) {
    // Restore original working directory even on error
    process.chdir(originalCwd)
    core.error(`Failed to create PR workspace or clone repository: ${error}`)

    if (error instanceof Error) {
      if (
        error.message.includes('Authentication failed') ||
        error.message.includes('fatal: Authentication failed')
      ) {
        core.error(
          'Git authentication failed. This suggests an issue with the GITHUB_TOKEN.'
        )
        core.error('Ensure that:')
        core.error('1. The workflow has appropriate permissions')
        core.error('2. The GITHUB_TOKEN is properly set')
        core.error('3. The repository is accessible with the provided token')
      } else if (
        error.message.includes('Repository not found') ||
        error.message.includes('fatal: repository')
      ) {
        core.error('Repository not found or not accessible.')
        core.error(
          'Check that the repository exists and the token has the necessary permissions.'
        )
      }
    }

    throw error
  } finally {
    // Clean up the subfolder after PR creation
    if (fs.existsSync(prWorkspace)) {
      try {
        fs.rmSync(prWorkspace, { recursive: true, force: true })
        core.info(`Cleaned up workspace: ${prWorkspace}`)
      } catch (cleanupError) {
        core.warning(`Failed to clean up workspace: ${cleanupError}`)
      }
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
