import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as github from '@actions/github'
import { Octokit } from '@octokit/rest'
import { DefaultArtifactClient } from '@actions/artifact'
import { PullRequestInfo } from '../types/index.js'
import { applyVersionFixes, type VersionFix } from '../utils/version-fixes.js'

/**
 * Validates a branch name before it reaches any git command. Rejects names git
 * would treat as options or refuse (leading "-", "..", control characters,
 * ref-syntax characters, trailing "/" or ".lock") and empty names.
 */
export function validateBaseBranch(branch: string): void {
  // eslint-disable-next-line no-control-regex
  const invalid = /^$|^-|[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|\/$|\.lock$/
  if (!invalid.test(branch)) {
    return
  }
  throw new Error(`Invalid base-branch "${branch}"`)
}

/**
 * Builds the git arguments that authenticate network commands without writing
 * the token to the clone's config (the same approach as actions/checkout).
 */
export function gitAuthArgs(token: string): string[] {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  core.setSecret(basic)
  return ['-c', `http.extraheader=AUTHORIZATION: basic ${basic}`]
}

/** Paths touched by a patch, from its `diff --git a/<p> b/<p>` headers. */
function patchPaths(patch: string): string[] {
  const paths = new Set<string>()
  for (const match of patch.matchAll(/^diff --git a\/.+? b\/(.+)$/gm)) {
    paths.add(match[1].trim())
  }
  return [...paths]
}

/** Lists untracked, non-ignored .rej files (relative paths) in a repository. */
async function listRejectFiles(workspaceDir: string): Promise<string[]> {
  let output = ''
  await exec.exec(
    'git',
    ['ls-files', '-z', '--others', '--exclude-standard', '--', '*.rej'],
    {
      cwd: workspaceDir,
      silent: true,
      listeners: {
        stdout: (data: Buffer) => {
          output += data.toString()
        }
      }
    }
  )
  return output.split('\0').filter((file) => file.length > 0)
}

/** True when the branch already exists on the remote (exit code 0). */
async function remoteBranchExists(
  branch: string,
  authArgs: string[]
): Promise<boolean> {
  const code = await exec.exec(
    'git',
    [...authArgs, 'ls-remote', '--exit-code', '--heads', 'origin', branch],
    { ignoreReturnCode: true, silent: true }
  )
  if (code === 0) return true
  // --exit-code: 2 means "no matching ref"; anything else is a real failure
  if (code === 2) return false
  throw new Error(`git ls-remote failed with exit code ${code}`)
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

    const rejRelativePaths = await listRejectFiles(workspaceDir)
    const rejFiles = rejRelativePaths.map((file) =>
      path.join(workspaceDir, file)
    )

    if (rejFiles.length === 0) {
      core.info('No .rej files found, patch applied cleanly with --reject flag')
      return
    }

    core.info(`Found ${rejFiles.length} .rej files to collect as artifacts`)

    // Create directory for reject files outside workspace using os.tmpdir()
    const rejectDir = path.join(os.tmpdir(), `reject-files-${deploymentId}`)
    if (!fs.existsSync(rejectDir)) {
      fs.mkdirSync(rejectDir, { recursive: true })
    }

    // Copy .rej files to reject directory and collect paths for artifact upload
    const artifactFiles: string[] = []
    for (const rejFile of rejFiles) {
      // Keep the path relative to the workspace so same-named files in
      // different folders don't overwrite each other
      const relativePath = path.relative(workspaceDir, rejFile)
      const targetPath = path.join(rejectDir, relativePath)

      // Copy file to reject directory
      fs.mkdirSync(path.dirname(targetPath), { recursive: true })
      fs.copyFileSync(rejFile, targetPath)
      artifactFiles.push(targetPath)

      // Remove .rej file from workspace so it doesn't get committed
      fs.rmSync(rejFile)
      core.info(`Collected reject file: ${relativePath}`)
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

    // Clean up temporary reject files directory
    core.info('Cleaning up temporary reject files directory...')
    fs.rmSync(rejectDir, { recursive: true, force: true })
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

/** True when the working tree has uncommitted changes. */
async function hasWorkingTreeChanges(): Promise<boolean> {
  let output = ''
  await exec.exec('git', ['status', '--porcelain'], {
    silent: true,
    listeners: {
      stdout: (data: Buffer) => {
        output += data.toString()
      }
    }
  })
  return output.trim().length > 0
}

/**
 * Create a pull request with the provided git patch and/or package version
 * fixes. Returns undefined when neither changed anything in the repository.
 */
export async function createPullRequestWithPatch(
  gitPatch: string,
  baseBranch: string,
  title: string,
  body: string,
  latestCompletedDeploymentId: string,
  token: string,
  versionFixes: VersionFix[] = []
): Promise<PullRequestInfo | undefined> {
  try {
    // Validate the deployment ID format
    validateDeploymentId(latestCompletedDeploymentId)

    if (!token) {
      throw new Error(
        'GitHub token not provided. Set the github-token input (needs contents: write and pull-requests: write).'
      )
    }
    validateBaseBranch(baseBranch)

    const workflowPaths = patchPaths(gitPatch).filter((p) =>
      p.startsWith('.github/')
    )
    if (workflowPaths.length > 0) {
      core.warning(
        `The patch changes CI configuration (${workflowPaths.join(', ')}). Review this PR carefully; the default GITHUB_TOKEN cannot push workflow file changes, so the push may be rejected.`
      )
    }

    const authArgs = gitAuthArgs(token)

    // Branch name format: umbcloud/{deploymentId}
    let newBranchName = `umbcloud/${latestCompletedDeploymentId}`
    let guidConflictOccurred = false

    const octokit = new Octokit({
      auth: token
    })

    const { owner, repo } = github.context.repo

    if (await remoteBranchExists(newBranchName, authArgs)) {
      // Branch already exists on the remote, use a timestamp suffix
      newBranchName = `umbcloud/${latestCompletedDeploymentId}-${Date.now()}`
      guidConflictOccurred = true
      core.info(
        `Branch already exists, creating with timestamp: ${newBranchName}`
      )
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

      core.debug(`Debug - GITHUB_ACTOR: ${process.env.GITHUB_ACTOR}`)
      core.debug(`Debug - GITHUB_ACTOR_ID: ${process.env.GITHUB_ACTOR_ID}`)
      core.debug(`Debug - Computed author: ${authorName} <${authorEmail}>`)

      // Configure git user identity using Peter Evans approach with -c flags
      core.info('Setting git identity using -c flags approach...')

      core.info(`Creating local branch: ${newBranchName}`)
      await exec.exec('git', ['checkout', '-b', newBranchName])

      if (gitPatch.trim()) {
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
      }

      // The patch often does not apply (its context comes from the last
      // deployed content), so also set the versions Cloud reported directly.
      const appliedFixes = applyVersionFixes(process.cwd(), versionFixes)

      if (!(await hasWorkingTreeChanges())) {
        core.warning(
          `No fix PR was created: the patch from Umbraco Cloud did not apply to ${baseBranch} and no package versions needed updating. Your repository differs from what was last deployed to Umbraco Cloud; update the package versions listed above manually.`
        )
        return undefined
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
        appliedFixes.length > 0
          ? `Update package versions to match Umbraco Cloud (deployment ${latestCompletedDeploymentId})`
          : `Apply Umbraco Cloud changes from deployment ${latestCompletedDeploymentId}`
      ])

      core.info('Pushing new branch...')
      await exec.exec('git', [...authArgs, 'push', 'origin', newBranchName])

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
