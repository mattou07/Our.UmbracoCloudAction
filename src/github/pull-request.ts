import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import * as path from 'path'
import * as github from '@actions/github'
import { Octokit } from '@octokit/rest'
import { DefaultArtifactClient } from '@actions/artifact'
import { PullRequestInfo } from '../types/index.js'

/**
 * Recursively finds all files with a specific extension in a directory
 */
function findFilesWithExtension(
  directory: string,
  extension: string
): string[] {
  const foundFiles: string[] = []

  try {
    const items = fs.readdirSync(directory, { withFileTypes: true })

    for (const item of items) {
      const fullPath = path.join(directory, item.name)

      if (item.isDirectory()) {
        // Recursively search subdirectories
        foundFiles.push(...findFilesWithExtension(fullPath, extension))
      } else if (item.isFile() && item.name.endsWith(extension)) {
        foundFiles.push(fullPath)
      }
    }
  } catch (error) {
    core.warning(`Could not read directory ${directory}: ${error}`)
  }

  return foundFiles
}

/**
 * Applies git patch with --reject flag and handles .rej files
 */
async function applyPatchWithReject(
  patchFilePath: string,
  workspaceDir: string,
  deploymentId: string
): Promise<void> {
  try {
    core.info(
      'Run git apply with --reject, --ignore-space-change, and --ignore-whitespace flags...'
    )
    const rejectExitCode = await exec.exec(
      'git',
      [
        'apply',
        '--reject',
        '--ignore-space-change',
        '--ignore-whitespace',
        patchFilePath
      ],
      {
        ignoreReturnCode: true,
        cwd: workspaceDir
      }
    )
    core.info('Exit code from git apply with --reject flag: ' + rejectExitCode)
    // With --reject flag, exit code 1 means "applied with rejections" (normal)
    // Exit code 0 means "applied cleanly"
    // Only exit codes > 1 indicate actual failure
    if (rejectExitCode > 1) {
      throw new Error('Failed to apply git patch with --reject flag')
    }

    if (rejectExitCode === 0) {
      core.info('Git patch applied cleanly with --reject flag')
    } else {
      core.info('Git patch applied with --reject flag, some hunks rejected')
    }

    core.info('Looking for .rej files...')

    // Find all .rej files recursively
    const rejFiles = findFilesWithExtension(workspaceDir, '.rej')

    if (rejFiles.length === 0) {
      core.info('No .rej files found, patch applied cleanly with --reject flag')
      return
    }

    core.info(`Found ${rejFiles.length} .rej files to collect as artifacts`)

    // Create directory for reject files outside workspace
    const rejectDir = path.join(process.cwd(), 'reject-files')
    if (!fs.existsSync(rejectDir)) {
      fs.mkdirSync(rejectDir, { recursive: true })
    }

    // Copy .rej files to reject directory and collect paths for artifact upload
    const artifactFiles: string[] = []
    for (const rejFile of rejFiles) {
      const fileName = path.basename(rejFile)
      const targetPath = path.join(rejectDir, fileName)

      // Copy file to reject directory
      fs.copyFileSync(rejFile, targetPath)
      artifactFiles.push(targetPath)

      // Remove .rej file from workspace so it doesn't get committed
      fs.rmSync(rejFile)
      core.info(`Collected reject file: ${fileName}`)
    }

    // Upload .rej files as GitHub artifact
    core.info('Uploading reject files as GitHub artifact...')
    const artifactClient = new DefaultArtifactClient()

    await artifactClient.uploadArtifact(
      `patch-rejections-${deploymentId}`,
      artifactFiles,
      rejectDir,
      {
        retentionDays: 30
      }
    )

    core.info(
      `Uploaded ${rejFiles.length} reject files as artifact: patch-rejections-${deploymentId}`
    )
  } catch (error) {
    core.error(`Failed to apply patch with --reject: ${error}`)
    throw new Error('Failed to apply git patch')
  }
}

/**
 * Validates that a deployment ID contains only alphanumeric characters and hyphens
 * or is a valid GUID format
 */
function validateDeploymentId(deploymentId: string): void {
  // Standard GUID pattern: 8-4-4-4-12 hexadecimal characters separated by hyphens
  // Optional curly braces are supported as per Microsoft GUID format
  const guidPattern =
    /^[{]?[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}[}]?$/

  // Fallback pattern for simpler deployment IDs (alphanumeric + hyphens)
  const simplePattern = /^[a-zA-Z0-9-]+$/

  // Check if deployment ID matches either valid pattern
  const isValidGuid = guidPattern.test(deploymentId)
  const isValidSimple = simplePattern.test(deploymentId)

  if (isValidGuid || isValidSimple) {
    return // Valid format - exit early
  }

  throw new Error(
    'Invalid deployment ID format. Must be a valid GUID or contain only alphanumeric characters and hyphens.'
  )
}

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
    // Validate the deployment ID format
    validateDeploymentId(latestCompletedDeploymentId)

    // Create a new branch name using the format: umbcloud/{deploymentId}
    let newBranchName = `umbcloud/${latestCompletedDeploymentId}`
    let guidConflictOccurred = false
    core.info(`Creating new branch: ${newBranchName}`)

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

      // Create and checkout the branch locally first
      core.info(`Fetching and checking out remote branch: ${newBranchName}`)
      await exec.exec('git', ['fetch', 'origin'])
      await exec.exec('git', ['checkout', newBranchName])

      core.info('Writing patch file...')
      fs.writeFileSync(patchFilePath, gitPatch, 'utf8')

      // Apply patch with --reject retry logic and .rej file handling
      await applyPatchWithReject(
        patchFilePath,
        process.cwd(),
        latestCompletedDeploymentId
      )

      // Clean up patch file before adding changes to git
      core.info('Removing patch file...')
      if (fs.existsSync(patchFilePath)) {
        fs.unlinkSync(patchFilePath)
      }

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
