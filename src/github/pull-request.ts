import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import * as github from '@actions/github'
import { Octokit } from '@octokit/rest'
import { PullRequestInfo } from '../types/index.js'

/**
 * Custom error for git patch application failures
 */
class GitPatchApplyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitPatchApplyError'
  }
}

/**
 * Try to apply a git patch and return success status
 */
async function tryApplyGitPatch(
  gitPatch: string,
  patchFilePath: string
): Promise<boolean> {
  try {
    core.info('Writing patch file...')
    fs.writeFileSync(patchFilePath, gitPatch, 'utf8')

    core.info('Applying git patch...')
    const applyExitCode = await exec.exec(
      'git',
      ['apply', '--check', patchFilePath],
      {
        ignoreReturnCode: true
      }
    )

    if (applyExitCode === 0) {
      // Patch can be applied, now actually apply it
      const actualApplyExitCode = await exec.exec(
        'git',
        ['apply', patchFilePath],
        {
          ignoreReturnCode: true
        }
      )

      if (actualApplyExitCode === 0) {
        core.info('Git patch applied successfully')
        return true
      } else {
        core.warning('Git patch failed to apply during actual application')
        return false
      }
    } else {
      core.warning(
        'Git patch cannot be applied (likely already applied or conflicts)'
      )
      return false
    }
  } catch (error) {
    core.warning(`Error applying git patch: ${error}`)
    return false
  } finally {
    // Clean up patch file
    if (fs.existsSync(patchFilePath)) {
      fs.unlinkSync(patchFilePath)
    }
  }
}

/**
 * Create a pull request with git patches from multiple deployment IDs, trying until one works
 */
export async function createPullRequestWithMultipleDeployments(
  deploymentIds: string[],
  getChangesFunction: (deploymentId: string) => Promise<string>,
  baseBranch: string,
  title: string,
  body: string
): Promise<PullRequestInfo & { deploymentId: string }> {
  if (deploymentIds.length === 0) {
    throw new Error('No deployment IDs provided')
  }

  for (let i = 0; i < deploymentIds.length; i++) {
    const deploymentId = deploymentIds[i]
    core.info(
      `Attempting to create PR with deployment ${deploymentId} (${i + 1}/${deploymentIds.length})`
    )

    try {
      // Get the git patch for this deployment
      const gitPatch = await getChangesFunction(deploymentId)

      if (!gitPatch.trim()) {
        core.warning(
          `Deployment ${deploymentId} has empty git patch, trying next...`
        )
        continue
      }

      // Try to create the PR with this deployment
      const result = await createPullRequestWithPatch(
        gitPatch,
        baseBranch,
        title,
        body,
        deploymentId
      )

      core.info(`Successfully created PR with deployment ${deploymentId}`)
      return {
        ...result,
        deploymentId
      }
    } catch (error) {
      if (error instanceof GitPatchApplyError) {
        core.warning(
          `Git patch from deployment ${deploymentId} cannot be applied (likely already applied or conflicts). Trying next deployment...`
        )
      } else {
        core.warning(
          `Failed to create PR with deployment ${deploymentId}: ${error}`
        )
      }

      if (i === deploymentIds.length - 1) {
        // This was the last deployment, re-throw the error
        throw new Error(
          `Failed to create PR with any of the ${deploymentIds.length} deployments. Last error: ${error}`
        )
      } else {
        core.info(`Trying next deployment...`)
        continue
      }
    }
  }

  throw new Error('No deployments were successfully processed')
}
export async function createPullRequestWithPatch(
  gitPatch: string,
  baseBranch: string,
  title: string,
  body: string,
  latestCompletedDeploymentId: string
): Promise<PullRequestInfo> {
  try {
    // Create a new branch name using the format: umbcloud/{deploymentId}
    let newBranchName = `umbcloud/${latestCompletedDeploymentId}`
    let guidConflictOccurred = false
    core.info(`Planning to create branch: ${newBranchName}`)

    // Initialize Octokit with the GitHub token from environment
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
    if (!token) {
      throw new Error(
        'GitHub token not found. Please set GITHUB_TOKEN or GH_TOKEN environment variable.'
      )
    }

    const octokit = new Octokit({
      auth: token
    })

    const { owner, repo } = github.context.repo

    // Get the latest commit SHA from the current workflow branch
    const { data: baseBranchData } = await octokit.repos.getBranch({
      owner,
      repo,
      branch: baseBranch
    })
    const baseSha = baseBranchData.commit.sha
    core.info(`Base branch SHA: ${baseSha}`)

    // Create a temporary patch file and apply it using git
    const patchFileName = `git-patch-${latestCompletedDeploymentId}.diff`
    const patchFilePath = `./${patchFileName}`

    try {
      // Configure git user identity for commits - following Peter Evans create-pull-request approach
      core.info('Configuring git user identity...')

      // Set author and committer using GitHub context values
      // Author: The user who triggered the workflow
      const authorName = process.env.GITHUB_ACTOR || 'github-actions[bot]'
      const authorId = process.env.GITHUB_ACTOR_ID || '41898282'
      const authorEmail = `${authorId}+${authorName}@users.noreply.github.com`

      // Debug: Output the values we're about to use
      core.info(`Debug - GITHUB_ACTOR: ${process.env.GITHUB_ACTOR}`)
      core.info(`Debug - GITHUB_ACTOR_ID: ${process.env.GITHUB_ACTOR_ID}`)
      core.info(`Debug - Computed author: ${authorName} <${authorEmail}>`)

      // Configure git user identity using Peter Evans approach with -c flags
      core.info('Setting git identity using -c flags approach...')

      // Apply the git patch to the current branch (base branch) first
      core.info('Applying git patch to base branch...')
      const patchApplied = await tryApplyGitPatch(gitPatch, patchFilePath)

      if (!patchApplied) {
        throw new GitPatchApplyError(
          'Failed to apply git patch - likely already applied or conflicts exist'
        )
      }

      // Only create the branch after patch is successfully applied
      core.info(`Creating new branch: ${newBranchName}`)

      // Check if branch name conflicts and create unique name if needed
      try {
        await octokit.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${newBranchName}`,
          sha: baseSha
        })
        core.info(`Branch created successfully: ${newBranchName}`)
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('Reference already exists')
        ) {
          // Branch already exists, try with a timestamp suffix
          const timestamp = Date.now()
          newBranchName = `umbcloud/${latestCompletedDeploymentId}-${timestamp}`
          guidConflictOccurred = true
          core.info(
            `Branch already exists, creating with timestamp: ${newBranchName}`
          )

          await octokit.git.createRef({
            owner,
            repo,
            ref: `refs/heads/${newBranchName}`,
            sha: baseSha
          })
          core.info(`Branch created successfully: ${newBranchName}`)
        } else {
          throw error
        }
      }

      // Fetch and checkout the newly created branch
      core.info(`Fetching and checking out new branch: ${newBranchName}`)
      await exec.exec('git', ['fetch', 'origin'])
      await exec.exec('git', ['checkout', newBranchName])

      core.info('Adding changes to git...')
      await exec.exec('git', ['add', '.'])

      core.info('Committing changes...')
      await exec.exec('git', [
        '-c',
        `user.name=${authorName}`,
        '-c',
        `user.email=${authorEmail}`,
        'commit',
        '-m',
        `Apply Umbraco Cloud changes from deployment ${latestCompletedDeploymentId}`
      ])

      core.info('Pushing new branch...')
      await exec.exec('git', ['push', 'origin', newBranchName])

      // Create pull request
      core.info('Creating pull request...')
      const { data: pullRequest } = await octokit.pulls.create({
        owner,
        repo,
        title: guidConflictOccurred ? `${title} (Conflict Resolution)` : title,
        head: newBranchName,
        base: baseBranch,
        body: guidConflictOccurred
          ? `${body}\n\n**Note:** A timestamp was added to the branch name due to an existing branch conflict.`
          : body
      })

      core.info(`Pull request created: ${pullRequest.html_url}`)

      return {
        url: pullRequest.html_url,
        number: pullRequest.number
      }
    } finally {
      // Clean up temporary patch file
      if (fs.existsSync(patchFilePath)) {
        fs.unlinkSync(patchFilePath)
      }

      // Return to original branch
      try {
        await exec.exec('git', ['checkout', baseBranch])
      } catch (error) {
        core.warning(`Could not return to original branch: ${error}`)
      }
    }
  } catch (error) {
    core.error(`Failed to create pull request: ${error}`)
    throw error
  }
}
