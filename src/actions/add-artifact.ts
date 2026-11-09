import * as core from '@actions/core'
import * as fs from 'fs'
import * as path from 'path'
import JSZip from 'jszip'
import { UmbracoCloudAPI } from '../api/umbraco-cloud-api.js'
import { ActionInputs, ActionOutputs } from '../types/index.js'
import { validateRequiredInputs } from '../utils/helpers.js'
import { addOrUpdateNuGetConfigSource } from '../utils/nuget-config.js'

const DEFAULT_EXCLUDED_PATHS = '.git/,.github/'
const DEFAULT_NUGET_CONFIG_NAME = 'NuGet.config'
const UMBRACO_MARKER_FILE = '.umbraco'
const NUGET_ORG_SOURCE_NAME = 'nuget.org'
const NUGET_ORG_SOURCE_URL = 'https://api.nuget.org/v3/index.json'

/**
 * Seed used when the artifact has no root NuGet.config. A repository-level
 * NuGet.config that only lists the private feed relies on the build machine's
 * user-level config for nuget.org; listing nuget.org explicitly keeps restore
 * of public packages working regardless of how the build host is configured.
 */
const FRESH_NUGET_CONFIG_SEED = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="${NUGET_ORG_SOURCE_NAME}" value="${NUGET_ORG_SOURCE_URL}" />
  </packageSources>
</configuration>`

function countFiles(zip: JSZip): number {
  return Object.values(zip.files).filter((f) => !f.dir).length
}

/** True when the zip has a `.umbraco` file at its root. */
function hasRootUmbracoFile(zip: JSZip): boolean {
  const entry = zip.files[UMBRACO_MARKER_FILE]
  return Boolean(entry && !entry.dir)
}

/**
 * Reads and parses the artifact zip, turning file-system and JSZip errors into
 * messages that name the filePath input.
 */
async function loadArtifactZip(filePath: string): Promise<JSZip> {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `filePath "${filePath}" does not exist (resolved to ${resolved})`
    )
  }
  if (!fs.statSync(filePath).isFile()) {
    throw new Error(
      `filePath "${filePath}" is not a file (resolved to ${resolved})`
    )
  }
  const data = fs.readFileSync(filePath)
  try {
    return await JSZip.loadAsync(data)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `filePath "${filePath}" is not a valid zip file: ${message}`
    )
  }
}

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
  const zip = await loadArtifactZip(filePath)
  let modified = false

  const hadUmbracoFile = hasRootUmbracoFile(zip)
  const hadRootNuGetConfig = findRootNuGetConfig(zip) !== undefined

  if (
    removeExcludedPaths(zip, inputs.excludedPaths || DEFAULT_EXCLUDED_PATHS)
  ) {
    modified = true
  }

  // Check before any step that can add files (NuGet injection creates
  // NuGet.config), otherwise an artifact emptied by excluded-paths would be
  // uploaded containing only the generated NuGet.config.
  if (countFiles(zip) === 0) {
    throw new Error(
      'Artifact contains no files after applying excluded-paths. Check the excluded-paths input and the contents of the artifact zip.'
    )
  }

  // Umbraco Cloud rejects packages without a root .umbraco file, failing the
  // deployment with: "Incoming package has no .umbraco file in its root. It
  // names the project folder and project file the build uses."
  if (!hasRootUmbracoFile(zip)) {
    const base =
      'Artifact has no .umbraco file at the root of the zip. Umbraco Cloud requires this file: it names the project folder and project file (.csproj) the build uses, and deployments without it are rejected.'
    throw new Error(
      hadUmbracoFile
        ? `${base} The .umbraco file was present in the artifact but was removed by the excluded-paths input ("${inputs.excludedPaths}"); remove the matching entry from excluded-paths.`
        : `${base} Add a .umbraco file to the root of the artifact before uploading.`
    )
  }

  if (await processCloudGitignoreInZip(zip)) {
    modified = true
  }

  let nugetSourceStatus = ''
  if (nugetConfigured) {
    if (hadRootNuGetConfig && findRootNuGetConfig(zip) === undefined) {
      core.warning(
        `excluded-paths removed the existing root NuGet.config from the artifact. Because a NuGet source is configured, a new NuGet.config is being generated containing only '${inputs.nugetSourceName}' and ${NUGET_ORG_SOURCE_NAME}; any other sources or settings from the excluded file are not included.`
      )
    }
    try {
      await injectNuGetConfig(zip, {
        name: inputs.nugetSourceName!,
        source: inputs.nugetSourceUrl!,
        username: inputs.nugetSourceUsername,
        password: inputs.nugetSourcePassword
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      nugetSourceStatus = `Failed to configure NuGet source: ${message}`
      core.setOutput('nuget-source-status', nugetSourceStatus)
      throw new Error(nugetSourceStatus)
    }
    modified = true
    nugetSourceStatus = 'NuGet.config successfully injected into artifact'
  }

  const fileCount = countFiles(zip)

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
      `NuGet Config: No existing NuGet.config found in zip root, will create new one including ${NUGET_ORG_SOURCE_NAME}`
    )
    // Seed with nuget.org unless the configured source already is nuget.org
    // (by key or URL), which would otherwise produce a duplicate feed.
    const isNuGetOrg =
      config.name.toLowerCase() === NUGET_ORG_SOURCE_NAME ||
      config.source.replace(/\/+$/, '').toLowerCase() === NUGET_ORG_SOURCE_URL
    existingContent = isNuGetOrg ? undefined : FRESH_NUGET_CONFIG_SEED
  }

  const result = await addOrUpdateNuGetConfigSource(config, existingContent)
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
