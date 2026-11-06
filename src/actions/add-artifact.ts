import * as core from '@actions/core'
import * as fs from 'fs'
import JSZip from 'jszip'
import { UmbracoCloudAPI } from '../api/umbraco-cloud-api.js'
import { ActionInputs, ActionOutputs } from '../types/index.js'
import { validateRequiredInputs } from '../utils/helpers.js'
import { addOrUpdateNuGetConfigSource } from '../utils/nuget-config.js'

const DEFAULT_EXCLUDED_PATHS = '.git/,.github/'
const DEFAULT_NUGET_CONFIG_NAME = 'NuGet.config'

/**
 * Normalises a path for comparison against zip entry names:
 * backslashes become forward slashes and a leading "./" is stripped.
 */
function normalisePath(p: string): string {
  let normalised = p.replace(/\\/g, '/')
  while (normalised.startsWith('./')) {
    normalised = normalised.substring(2)
  }
  return normalised
}

/**
 * Returns true when the zip entry name is the excluded path itself or lives
 * underneath it. An exclusion without a trailing slash is treated as either a
 * file or a directory, but never as a raw prefix (".git" does not match
 * ".gitignore" or ".github/").
 */
function matchesExcludedPath(entryName: string, excludePath: string): boolean {
  const name = normalisePath(entryName)
  const p = excludePath
  if (name === p || name === `${p}/`) {
    return true
  }
  const dirPrefix = p.endsWith('/') ? p : `${p}/`
  return name.startsWith(dirPrefix)
}

/**
 * Removes excluded paths from a zip file based on path list
 * Supports single path (e.g., ".git") or comma-separated paths (e.g., ".git/,.github/")
 *
 * @returns true when at least one entry was removed
 */
function removeExcludedPaths(zip: JSZip, excludedPaths: string): boolean {
  if (!excludedPaths.trim()) {
    return false
  }

  // Validate format: single path or comma-separated paths (no space-separated paths)
  // Valid: "mypath/test", "mypath\\hello", ".git/,mypath/test", ".git/, .github/"
  // Invalid: "path1 path2" (space-separated), "mypath\\//hello" (mixed separators)
  const pathPattern = /^[^\s,]+(\s*,\s*[^\s,]+)*$/

  if (!pathPattern.test(excludedPaths)) {
    throw new Error(
      `Invalid excluded-paths format: "${excludedPaths}". Use single path (e.g., ".git/") or comma-separated paths (e.g., ".git/,.github/,node_modules/")`
    )
  }

  const rawPaths = excludedPaths
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  // This should never happen after our validation as we have defaults
  if (rawPaths.length === 0) {
    throw new Error('No valid paths found after validation.')
  }

  for (const rawPath of rawPaths) {
    // Reject mixed path separators
    if (rawPath.includes('/') && rawPath.includes('\\')) {
      throw new Error(
        `Invalid path "${rawPath}" contains mixed separators. Use either forward slashes (/) or backslashes (\\), not both.`
      )
    }
    if (rawPath.includes('..') || rawPath.startsWith('/')) {
      throw new Error(
        `Invalid path "${rawPath}" in excluded-paths. Paths should be relative to your repository and not contain ".." or not start with "/" for safety reasons`
      )
    }
  }

  const pathsToExclude = rawPaths
    .map(normalisePath)
    .filter((p) => p.length > 0 && p !== '/')

  if (pathsToExclude.length === 0) {
    throw new Error('No valid paths found after validation.')
  }

  core.info(`Processing excluded paths: ${pathsToExclude.join(', ')}`)

  const removedFiles: string[] = []
  const foundPaths = new Set<string>()

  for (const filename of Object.keys(zip.files)) {
    const match = pathsToExclude.find((p) => matchesExcludedPath(filename, p))
    if (match) {
      zip.remove(filename)
      removedFiles.push(filename)
      foundPaths.add(match)
    }
  }

  if (removedFiles.length > 0) {
    core.startGroup(
      `Removed ${removedFiles.length} file(s) matching excluded paths: ${[...foundPaths].join(', ')}`
    )
    for (const file of removedFiles) {
      core.info(`- ${file}`)
    }
    core.endGroup()
  }

  // Log info about paths that weren't found (already removed or never existed)
  // This is not an error since the goal is to ensure they're not in the artifact
  const notFoundPaths = pathsToExclude.filter((p) => !foundPaths.has(p))
  if (notFoundPaths.length > 0) {
    const yellow = '\x1b[33m'
    const reset = '\x1b[0m'
    core.info(
      `${yellow}Excluded paths already removed or not present in artifact:${reset} ${notFoundPaths.join(', ')}`
    )
  }

  // Note if nothing was removed at all; this might indicate a
  // configuration issue, but is not a hard error
  if (removedFiles.length === 0) {
    core.info(
      'No excluded paths were found in the artifact. This may be expected if they were already removed, or may indicate a misconfiguration.'
    )
  }

  return removedFiles.length > 0
}

export { removeExcludedPaths }

export async function handleAddArtifact(
  api: UmbracoCloudAPI,
  inputs: ActionInputs
): Promise<ActionOutputs> {
  validateRequiredInputs(inputs as unknown as Record<string, unknown>, [
    'filePath'
  ])

  const filePath = inputs.filePath!
  const nugetConfigured = Boolean(
    inputs.nugetSourceName && inputs.nugetSourceUrl
  )

  // Single pipeline: load once, apply all modifications, write back once
  const data = fs.readFileSync(filePath)
  const zip = await JSZip.loadAsync(data)
  let modified = false

  if (
    removeExcludedPaths(zip, inputs.excludedPaths || DEFAULT_EXCLUDED_PATHS)
  ) {
    modified = true
  }

  if (await processCloudGitignoreInZip(zip)) {
    modified = true
  }

  let nugetSourceStatus = ''
  if (nugetConfigured) {
    try {
      await injectNuGetConfig(zip, {
        name: inputs.nugetSourceName!,
        source: inputs.nugetSourceUrl!,
        username: inputs.nugetSourceUsername,
        password: inputs.nugetSourcePassword
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to configure NuGet source: ${message}`)
    }
    modified = true
    nugetSourceStatus = 'NuGet.config successfully injected into artifact'
  }

  const fileCount = Object.values(zip.files).filter((f) => !f.dir).length
  if (fileCount === 0) {
    throw new Error(
      'Artifact contains no files after applying excluded-paths. Check the excluded-paths input and the contents of the artifact zip.'
    )
  }

  if (modified) {
    const updatedData = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    })
    fs.writeFileSync(filePath, updatedData)
    core.info(
      `Artifact updated (${fileCount} file(s), ${updatedData.length} bytes)`
    )
  } else {
    core.info(`Artifact unchanged (${fileCount} file(s))`)
  }

  const artifactId = await api.addDeploymentArtifact(
    filePath,
    inputs.description,
    inputs.version
  )

  core.info(`Artifact uploaded successfully with ID: ${artifactId}`)
  core.setOutput('artifactId', artifactId)
  if (nugetConfigured) {
    core.setOutput('nuget-source-status', nugetSourceStatus)
  }

  return {
    artifactId,
    nugetSourceStatus
  }
}

/**
 * Finds NuGet.config at the root of the zip, matching the file name
 * case-insensitively. Returns the entry name as stored in the zip.
 */
function findRootNuGetConfig(zip: JSZip): string | undefined {
  return Object.keys(zip.files).find(
    (name) =>
      !zip.files[name].dir &&
      name.toLowerCase() === DEFAULT_NUGET_CONFIG_NAME.toLowerCase()
  )
}

async function injectNuGetConfig(
  zip: JSZip,
  config: { name: string; source: string; username?: string; password?: string }
): Promise<void> {
  core.info(
    'NuGet source configuration provided. Injecting NuGet.config into zip...'
  )

  const existingEntryName = findRootNuGetConfig(zip)
  let existingContent: string | undefined
  if (existingEntryName) {
    core.info(
      `NuGet Config: Found existing ${existingEntryName} in zip, will preserve existing content`
    )
    existingContent = await zip.files[existingEntryName].async('text')
  } else {
    core.info(
      'NuGet Config: No existing NuGet.config found in zip root, will create new one'
    )
  }

  const result = await addOrUpdateNuGetConfigSource(config, existingContent)
  if (!result.success) {
    throw new Error(result.message)
  }
  core.info(`NuGet Config: ${result.message}`)

  zip.file(existingEntryName ?? DEFAULT_NUGET_CONFIG_NAME, result.xmlContent)
}

/**
 * Replaces every .gitignore in the zip with the content of .cloud_gitignore,
 * if one is present.
 *
 * @returns true when the zip was modified
 */
async function processCloudGitignoreInZip(zip: JSZip): Promise<boolean> {
  const cloudGitignoreFile = Object.keys(zip.files).find(
    (filename) =>
      !zip.files[filename].dir &&
      (filename === '.cloud_gitignore' ||
        filename.endsWith('/.cloud_gitignore'))
  )

  if (!cloudGitignoreFile) {
    core.info(
      '.cloud_gitignore file not found - .gitignore files will not be modified'
    )
    return false
  }

  const cloudGitignoreContent =
    await zip.files[cloudGitignoreFile].async('string')

  const gitignoreFiles = Object.keys(zip.files).filter(
    (filename) =>
      !zip.files[filename].dir &&
      (filename === '.gitignore' || filename.endsWith('/.gitignore'))
  )

  if (gitignoreFiles.length === 0) {
    core.info('No .gitignore files found in artifact to replace')
    return false
  }

  for (const gitignoreFile of gitignoreFiles) {
    zip.file(gitignoreFile, cloudGitignoreContent)
    core.info(
      `Replaced ${gitignoreFile} with content from ${cloudGitignoreFile}`
    )
  }

  return true
}
