import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import * as github from '@actions/github'
import { Octokit } from '@octokit/rest'
import { PullRequestInfo } from '../types/index.js'

/**
 * Create a pull request with the provided git patch
 */
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
    core.info(`Creating new branch: ${newBranchName}`)

    // Initialize Octokit
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

    // Create the new branch using Octokit
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

    // Create a temporary patch file and apply it using git
    const patchFileName = `git-patch-${latestCompletedDeploymentId}.diff`
    const patchFilePath = `./${patchFileName}`

    try {
      core.info('Writing patch file...')
      fs.writeFileSync(patchFilePath, gitPatch, 'utf8')

      core.info('Checking out new branch...')
      await exec.exec('git', ['checkout', newBranchName])

      core.info('Applying git patch...')
      const applyExitCode = await exec.exec('git', ['apply', patchFilePath], {
        ignoreReturnCode: true
      })

      if (applyExitCode !== 0) {
        throw new Error('Failed to apply git patch')
      }

      core.info('Adding changes to git...')
      await exec.exec('git', ['add', '.'])

      core.info('Committing changes...')
      await exec.exec('git', [
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
