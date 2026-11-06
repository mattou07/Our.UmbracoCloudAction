import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import * as fs from 'fs'
import * as path from 'path'
import type { UmbracoCloudAPI } from '../api/umbraco-cloud-api.js'
import {
  ActionInputs,
  ActionOutputs,
  DeploymentResponse,
  PullRequestInfo
} from '../types/index.js'
import { validateRequiredInputs } from '../utils/helpers.js'
import {
  hasUpdatingMarkerError,
  pollDeploymentStatus
} from '../utils/deployment-polling.js'
import { createPullRequestWithPatch } from '../github/pull-request.js'

type CheckStatusApi = Pick<
  UmbracoCloudAPI,
  | 'getDeploymentStatus'
  | 'getChangesById'
  | 'getLatestCompletedDeployment'
  | 'getDeploymentErrorDetails'
>

const DEPLOYMENT_FAILED_DOCS_URL =
  'https://docs.umbraco.com/umbraco-cloud/optimize-and-maintain-your-site/monitor-and-troubleshoot/resolve-issues-quickly-and-efficiently/deployments/deployment-failed'

/** Errors that a git patch from Cloud can typically fix (package version drift). */
const VERSION_FAILURE_PATTERN =
  /downgrad|version (mismatch|conflict|check)|NU1605|NU1107/i

/**
 * Waits for the deployment to reach a terminal state.
 *
 * Returns the outputs when the deployment completed successfully, and throws
 * for any other outcome (after attempting to open a fix PR for failures).
 */
export async function handleCheckStatus(
  api: CheckStatusApi,
  inputs: ActionInputs
): Promise<ActionOutputs> {
  validateRequiredInputs(inputs, ['deploymentId', 'targetEnvironmentAlias'])
  const deploymentId = inputs.deploymentId!

  core.info(
    `Checking status for deployment ID: ${deploymentId}, environment: ${inputs.targetEnvironmentAlias}`
  )

  const timeoutMs = (inputs.timeoutSeconds || 1200) * 1000
  const deploymentStatus = await pollDeploymentStatus(
    api,
    deploymentId,
    timeoutMs
  )

  core.setOutput('deploymentState', deploymentStatus.deploymentState)
  core.setOutput('deploymentStatus', JSON.stringify(deploymentStatus))

  if (deploymentStatus.deploymentState === 'Completed') {
    return await handleCompletedDeployment(api, inputs, deploymentStatus)
  }

  if (hasUpdatingMarkerError(deploymentStatus.deploymentStatusMessages)) {
    reportUpdatingMarkerGuidance()
    throw new Error(
      `Deployment ${deploymentId} failed: it is blocked by leftover upgrade markers. Remove them via KUDU (site/locks) and retry. See: ${DEPLOYMENT_FAILED_DOCS_URL}`
    )
  }

  if (deploymentStatus.deploymentState === 'Failed') {
    const outputs = await handleFailedDeployment(api, inputs, deploymentStatus)
    const prNote = outputs.prUrl
      ? `. A pull request with the Umbraco Cloud changes was opened: ${outputs.prUrl}`
      : ''
    throw new Error(`Deployment ${deploymentId} failed${prNote}`)
  }

  throw new Error(
    `Deployment ended in unexpected state: ${deploymentStatus.deploymentState}`
  )
}

function reportUpdatingMarkerGuidance(): void {
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
  core.error(DEPLOYMENT_FAILED_DOCS_URL)
}

function baseOutputs(deploymentStatus: DeploymentResponse): ActionOutputs {
  return {
    deploymentState: deploymentStatus.deploymentState,
    deploymentStatus: JSON.stringify(deploymentStatus)
  }
}

function isCloudNullDeployment(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const status = (error as { status?: unknown }).status
  const is409 = status === 409 || error.message.includes('409')
  return is409 && error.message.includes('CloudNullDeployment')
}

async function handleCompletedDeployment(
  api: CheckStatusApi,
  inputs: ActionInputs,
  deploymentStatus: DeploymentResponse
): Promise<ActionOutputs> {
  core.info('Deployment completed successfully')

  try {
    const changes = await api.getChangesById(
      inputs.deploymentId!,
      inputs.targetEnvironmentAlias
    )

    if (changes.changes && changes.changes.trim().length > 0) {
      core.info('Deployment completed. Here is the diff/patch:')
      core.info(changes.changes)
    } else {
      core.info('Deployment completed. No changes/diff available.')
    }

    core.setOutput('changes', JSON.stringify(changes))

    return {
      ...baseOutputs(deploymentStatus),
      changes: JSON.stringify(changes)
    }
  } catch (diffError: unknown) {
    if (isCloudNullDeployment(diffError)) {
      core.info(
        'Deployment completed successfully, but there were no changes to apply to the cloud repository.'
      )
    } else {
      core.warning(
        `Could not retrieve changes for completed deployment: ${diffError}`
      )
    }

    return baseOutputs(deploymentStatus)
  }
}

async function handleFailedDeployment(
  api: CheckStatusApi,
  inputs: ActionInputs,
  deploymentStatus: DeploymentResponse
): Promise<ActionOutputs> {
  core.warning(
    'Deployment failed - attempting to retrieve git patch to fix the issue'
  )

  const errorDetails = await getErrorDetails(api, inputs.deploymentId!)

  // NuGet failures are credential/configuration issues; a patch won't help.
  const isNuGetFailure = errorDetails.some((error) =>
    /error restoring packages|nu1301|nu1302/i.test(error)
  )
  if (isNuGetFailure) {
    core.warning(
      'NuGet-related failure detected. Skipping PR creation as this is likely a credential or configuration issue.'
    )
    return baseOutputs(deploymentStatus)
  }

  const isVersionFailure = errorDetails.some((error) =>
    VERSION_FAILURE_PATTERN.test(error)
  )

  if (isVersionFailure) {
    core.info(
      'Version-related deployment failure detected. Attempting to get git patch to synchronise versions...'
    )

    let patch: string | undefined
    try {
      const changes = await api.getChangesById(
        inputs.deploymentId!,
        inputs.targetEnvironmentAlias
      )
      patch = changes.changes
      core.info('Successfully retrieved git patch from failed deployment')
      core.setOutput('changes', JSON.stringify(changes))
    } catch (patchError) {
      core.warning(
        `Could not retrieve git patch from failed deployment: ${patchError}`
      )
    }

    if (patch && patch.trim()) {
      const prTitle = `Fix: Update package versions for deployment ${inputs.deploymentId}`
      const prBody = `This PR applies the git patch from Umbraco Cloud to fix package version issues in deployment ${inputs.deploymentId}.

**Failed Deployment ID:** ${inputs.deploymentId}
**Target Environment:** ${inputs.targetEnvironmentAlias}
**Issue:** Package version downgrade detected

**Errors:**
${errorDetails.map((error) => `- ${error}`).join('\n')}

The changes in this PR contain the necessary package version updates from Umbraco Cloud.`

      const pr = await tryCreatePullRequest(
        inputs,
        patch,
        prTitle,
        prBody,
        inputs.deploymentId!
      )

      return {
        ...baseOutputs(deploymentStatus),
        changes: JSON.stringify({ changes: patch }),
        ...prOutputs(pr)
      }
    }

    core.info('Falling back to latest completed deployment approach...')
  }

  return await attemptPullRequestCreation(api, inputs, deploymentStatus)
}

async function getErrorDetails(
  api: CheckStatusApi,
  deploymentId: string
): Promise<string[]> {
  try {
    const errorDetails = await api.getDeploymentErrorDetails(deploymentId)

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
  api: CheckStatusApi,
  inputs: ActionInputs,
  deploymentStatus: DeploymentResponse
): Promise<ActionOutputs> {
  try {
    core.info(
      'Attempting to get latest completed deployment with changes and create PR...'
    )

    const latestCompletedDeploymentId = await api.getLatestCompletedDeployment(
      inputs.targetEnvironmentAlias
    )

    if (!latestCompletedDeploymentId) {
      core.warning('No completed deployments found to create PR from')
      return baseOutputs(deploymentStatus)
    }

    core.info(
      `Found latest completed deployment with changes ID: ${latestCompletedDeploymentId}`
    )

    const changes = await api.getChangesById(
      latestCompletedDeploymentId,
      inputs.targetEnvironmentAlias
    )

    core.info('Retrieved changes from latest completed deployment')
    core.setOutput(
      'latest-completed-deployment-id',
      latestCompletedDeploymentId
    )
    core.setOutput('changes', JSON.stringify(changes))

    const prTitle = `Fix: Apply changes from failed deployment ${inputs.deploymentId}`
    const prBody = `This PR applies changes from the latest completed deployment (${latestCompletedDeploymentId}) to fix the failed deployment (${inputs.deploymentId}).

**Failed Deployment ID:** ${inputs.deploymentId}
**Latest Completed Deployment ID:** ${latestCompletedDeploymentId}
**Target Environment:** ${inputs.targetEnvironmentAlias}

The changes in this PR are based on the git patch from the latest successful deployment.`

    const pr = await tryCreatePullRequest(
      inputs,
      changes.changes,
      prTitle,
      prBody,
      latestCompletedDeploymentId
    )

    return {
      ...baseOutputs(deploymentStatus),
      latestCompletedDeploymentId,
      changes: JSON.stringify(changes),
      ...prOutputs(pr)
    }
  } catch (error) {
    core.warning(`Failed to get latest completed deployment: ${error}`)
    return baseOutputs(deploymentStatus)
  }
}

function prOutputs(pr: PullRequestInfo | undefined): ActionOutputs {
  return pr ? { prUrl: pr.url, prNumber: String(pr.number) } : {}
}

/**
 * Resolve the branch the fix PR should target.
 * Explicit input wins; otherwise the triggering branch (only for branch refs,
 * not e.g. refs/pull/N/merge or tags), then the repository default branch.
 */
export function resolveBaseBranch(inputs: ActionInputs): string {
  if (inputs.baseBranch && inputs.baseBranch.trim()) {
    return inputs.baseBranch.trim()
  }

  const ref = github.context.ref || ''
  if (ref.startsWith('refs/heads/')) {
    return ref.substring('refs/heads/'.length)
  }

  const defaultBranch = github.context.payload?.repository?.default_branch
  if (typeof defaultBranch === 'string' && defaultBranch) {
    return defaultBranch
  }

  return 'main'
}

/**
 * Opens a PR with the given patch. Never throws: PR creation is best effort,
 * the deployment outcome decides whether the action fails.
 */
async function tryCreatePullRequest(
  inputs: ActionInputs,
  patch: string,
  prTitle: string,
  prBody: string,
  sourceDeploymentId: string
): Promise<PullRequestInfo | undefined> {
  if (!patch || !patch.trim()) {
    core.info(
      'The git patch from Umbraco Cloud is empty; skipping PR creation.'
    )
    return undefined
  }

  const token =
    inputs.githubToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (!token) {
    core.warning(
      'No GitHub token available (github-token input, GITHUB_TOKEN or GH_TOKEN); skipping PR creation.'
    )
    return undefined
  }

  const baseBranch = resolveBaseBranch(inputs)

  try {
    const pr = await createPullRequestInWorkspace(
      patch,
      prTitle,
      prBody,
      sourceDeploymentId,
      baseBranch,
      token
    )
    core.setOutput('pr-url', pr.url)
    core.setOutput('pr-number', String(pr.number))
    return pr
  } catch (error) {
    core.warning(`Failed to create pull request: ${error}`)
    return undefined
  }
}

async function createPullRequestInWorkspace(
  changes: string,
  prTitle: string,
  prBody: string,
  sourceDeploymentId: string,
  baseBranch: string,
  token: string
): Promise<PullRequestInfo> {
  core.setSecret(token)

  const runId = process.env.GITHUB_RUN_ID || Date.now().toString()
  const prWorkspace = path.join(
    process.env.GITHUB_WORKSPACE || process.cwd(),
    `pr-workspace-${runId}`
  )
  const originalCwd = process.cwd()

  try {
    fs.mkdirSync(prWorkspace, { recursive: true })

    const host = (github.context.serverUrl || 'https://github.com').replace(
      /^https?:\/\//,
      ''
    )
    const { owner, repo } = github.context.repo
    const publicUrl = `https://${host}/${owner}/${repo}.git`
    const repoUrl = `https://x-access-token:${token}@${host}/${owner}/${repo}.git`

    core.info(`Cloning repository to: ${prWorkspace}`)
    core.info(`Repository URL: ${publicUrl}`)
    core.info(`Branch: ${baseBranch}`)

    await exec.exec('git', [
      'clone',
      '--branch',
      baseBranch,
      repoUrl,
      prWorkspace
    ])

    process.chdir(prWorkspace)

    return await createPullRequestWithPatch(
      changes,
      baseBranch,
      prTitle,
      prBody,
      sourceDeploymentId,
      token
    )
  } catch (error) {
    core.error(`Failed to create pull request from workspace: ${error}`)
    core.error(
      `Check that the token can push to ${github.context.repo.owner}/${github.context.repo.repo} (contents: write, pull-requests: write) and that branch "${baseBranch}" exists.`
    )
    throw error
  } finally {
    // Leave the directory before deleting it
    process.chdir(originalCwd)
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
