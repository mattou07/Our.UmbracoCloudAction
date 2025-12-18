import * as core from '@actions/core'
import { UmbracoCloudAPI } from '../api/umbraco-cloud-api.js'
import { ActionInputs, ActionOutputs } from '../types/index.js'
import { validateRequiredInputs } from '../utils/helpers.js'
import { addOrUpdateNuGetConfigSource } from '../utils/nuget-config.js'
import * as fs from 'fs'
import * as path from 'path'
import * as exec from '@actions/exec'
import JSZip from 'jszip'

/**
 * Removes excluded paths from a zip file based on path list
 * Supports single path (e.g., ".git") or comma-separated paths (e.g., ".git/,.github/")
 */
function removeExcludedPaths(zip: JSZip, excludedPaths: string): void {
  if (!excludedPaths.trim()) {
    return
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

  // Additional validation: reject mixed path separators
  const paths = excludedPaths.split(',').map((p) => p.trim())
  for (const path of paths) {
    if (path.includes('/') && path.includes('\\')) {
      throw new Error(
        `Invalid path "${path}" contains mixed separators. Use either forward slashes (/) or backslashes (\\), not both.`
      )
    }
  }

  const pathsToExclude = excludedPaths
    .split(',')
    .map((path) => path.trim())
    .filter((path) => path.length > 0)

  // This should never happen after our validation as we have defaults
  if (pathsToExclude.length === 0) {
    throw new Error('No valid paths found after validation.')
  }

  // Validate individual paths
  for (const path of pathsToExclude) {
    if (path.includes('..') || path.startsWith('/')) {
      throw new Error(
        `Invalid path "${path}" in excluded-paths. Paths should be relative to your repository and not contain ".." or not start with "/" for safety reasons`
      )
    }
  }

  core.info(`Processing excluded paths: ${pathsToExclude.join(', ')}`)

  const removedFiles: string[] = []
  const foundPaths: string[] = []
  const notFoundPaths: string[] = [...pathsToExclude]

  Object.keys(zip.files).forEach((filename) => {
    for (const excludePath of pathsToExclude) {
      if (filename.startsWith(excludePath)) {
        zip.remove(filename)
        removedFiles.push(filename)
        if (!foundPaths.includes(excludePath)) {
          foundPaths.push(excludePath)
          // Remove from not found list
          const notFoundIndex = notFoundPaths.indexOf(excludePath)
          if (notFoundIndex > -1) {
            notFoundPaths.splice(notFoundIndex, 1)
          }
        }
        break // Move to next filename once a match is found
      }
    }
  })

  if (removedFiles.length > 0) {
    // ANSI escape codes for styling
    const red = '\x1b[31m'
    const dim = '\x1b[2m'
    const reset = '\x1b[0m'

    core.startGroup(
      `${red}Removed ${removedFiles.length} file(s)${reset} matching excluded paths: ${foundPaths.join(', ')}`
    )
    for (const file of removedFiles) {
      core.info(`${dim}- ${reset}${red}${file}${reset}`)
    }
    core.endGroup()
  }

  // Log info about paths that weren't found (already removed or never existed)
  // This is not an error since the goal is to ensure they're not in the artifact
  if (notFoundPaths.length > 0) {
    const yellow = '\x1b[33m'
    const reset = '\x1b[0m'
    core.info(
      `${yellow}Excluded paths already removed or not present in artifact:${reset} ${notFoundPaths.join(', ')}`
    )
  }

  // Only warn if no paths were found at all and no files were removed
  // This might indicate a configuration issue, but is not a hard error
  if (
    removedFiles.length === 0 &&
    foundPaths.length === 0 &&
    pathsToExclude.length > 0
  ) {
    core.warning(
      'No excluded paths were found in the artifact. This may be expected if they were already removed, or may indicate a misconfiguration.'
    )
  }
}

export { removeExcludedPaths }

export async function handleAddArtifact(
  api: UmbracoCloudAPI,
  inputs: ActionInputs
): Promise<ActionOutputs> {
  validateRequiredInputs(inputs as unknown as Record<string, unknown>, [
    'filePath'
  ])

  let nugetSourceStatus = ''
  let modifiedFilePath = inputs.filePath!

  // Handle NuGet source injection if provided
  if (inputs.nugetSourceName && inputs.nugetSourceUrl) {
    try {
      modifiedFilePath = await processArtifactWithNugetConfig(
        inputs.filePath!,
        inputs.nugetSourceName,
        inputs.nugetSourceUrl,
        inputs.nugetSourceUsername,
        inputs.nugetSourcePassword,
        inputs.excludedPaths
      )
      nugetSourceStatus = 'NuGet.config successfully injected into artifact'
    } catch (error) {
      const errorMessage = `Failed to configure NuGet source: ${error}`
      core.warning(errorMessage)
      nugetSourceStatus = errorMessage
    }
  } else {
    // Process .cloud_gitignore replacement if present, even without NuGet config
    try {
      modifiedFilePath = await processCloudGitignore(
        inputs.filePath!,
        inputs.excludedPaths
      )
      core.info('Successfully processed .cloud_gitignore')
    } catch (error) {
      core.warning(`Failed to process .cloud_gitignore: ${error}`)
    }

    // Only validate git repository if we didn't process the artifact
    await validateArtifactGitRepository(modifiedFilePath)
  }

  const artifactId = await api.addDeploymentArtifact(
    modifiedFilePath,
    inputs.description,
    inputs.version
  )

  core.info(`Artifact uploaded successfully with ID: ${artifactId}`)
  core.setOutput('artifactId', artifactId)

  return {
    artifactId,
    nugetSourceStatus
  }
}

async function processArtifactWithNugetConfig(
  filePath: string,
  nugetSourceName: string,
  nugetSourceUrl: string,
  nugetSourceUsername?: string,
  nugetSourcePassword?: string,
  excludedPaths?: string
): Promise<string> {
  core.info(
    'NuGet source configuration provided. Injecting NuGet.config into zip...'
  )

  // Load the zip file
  const data = fs.readFileSync(filePath)
  const zip = await JSZip.loadAsync(data)

  // Remove excluded paths
  removeExcludedPaths(zip, excludedPaths || '.git/,.github/')

  // Check if NuGet.config already exists in the zip
  let existingNugetConfig: string | undefined
  const nugetConfigFile = zip.file('NuGet.config')
  if (nugetConfigFile) {
    core.info(
      'NuGet Config: Found existing NuGet.config in zip, will preserve existing content'
    )
    existingNugetConfig = await nugetConfigFile.async('text')
    core.debug(`NuGet Config: Existing content in zip:\n${existingNugetConfig}`)
  } else {
    core.info(
      'NuGet Config: No existing NuGet.config found in zip, will create new one'
    )
  }

  // Add or update NuGet.config using existing content if available
  const nugetConfig = {
    name: nugetSourceName,
    source: nugetSourceUrl,
    username: nugetSourceUsername,
    password: nugetSourcePassword
  }

  const result = await addOrUpdateNuGetConfigSource(
    nugetConfig,
    existingNugetConfig || ''
  )
  core.info(`NuGet.config ${result.message}`)

  // Add the updated NuGet.config content to zip
  zip.file('NuGet.config', result.xmlContent)

  // Process .cloud_gitignore replacement if present
  await processCloudGitignoreInZip(zip)

  // Write the updated zip back to the original file
  const updatedData = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  })

  fs.writeFileSync(filePath, updatedData)
  core.info(
    `Zip file size after processing: ${fs.statSync(filePath).size} bytes`
  )
  core.info(
    'Successfully injected NuGet.config and processed excluded paths in artifact zip'
  )

  return filePath
}

async function validateArtifactGitRepository(filePath: string): Promise<void> {
  core.info('Validating artifact contains git repository...')

  // Create temporary directory for validation
  const validationDir = path.join(process.cwd(), 'temp-validation')

  try {
    if (!fs.existsSync(validationDir)) {
      fs.mkdirSync(validationDir, { recursive: true })
    }

    // Extract zip to validation directory
    await exec.exec('unzip', ['-q', filePath, '-d', validationDir])

    // Validate git repository
    await validateGitRepository(validationDir, 'in artifact')
  } finally {
    // Clean up validation directory
    if (fs.existsSync(validationDir)) {
      fs.rmSync(validationDir, { recursive: true, force: true })
    }
  }
}

async function validateGitRepository(
  directoryPath: string,
  context: string
): Promise<void> {
  core.info(`Validating git repository ${context}...`)
  try {
    // Store current working directory
    const originalCwd = process.cwd()

    try {
      // Change to the specified directory
      process.chdir(directoryPath)

      // First, check if this directory itself is a git repository
      try {
        await exec.exec('git', ['rev-parse', '--git-dir'])
        core.info(
          `Git repository validation successful ${context} (found in root)`
        )
        return
      } catch (rootError) {
        core.debug(`No git repository found in root directory: ${rootError}`)
      }

      // If not found in root, search for .git directory in subdirectories
      const items = fs.readdirSync(directoryPath)
      for (const item of items) {
        const itemPath = path.join(directoryPath, item)
        const stats = fs.statSync(itemPath)

        if (stats.isDirectory()) {
          // Check if this subdirectory contains a .git folder
          const gitPath = path.join(itemPath, '.git')
          if (fs.existsSync(gitPath)) {
            // Change to the subdirectory and validate
            process.chdir(itemPath)
            await exec.exec('git', ['rev-parse', '--git-dir'])
            core.info(
              `Git repository validation successful ${context} (found in subdirectory: ${item})`
            )
            return
          }
        }
      }

      // If we get here, no git repository was found
      throw new Error(
        'No git repository found in any directory or subdirectory'
      )
    } finally {
      // Always restore original working directory
      process.chdir(originalCwd)
    }
  } catch (error) {
    core.setFailed(`Failed to validate git repository ${context}: ${error}`)
    throw error
  }
}

async function processCloudGitignore(
  filePath: string,
  excludedPaths?: string
): Promise<string> {
  core.info('Checking for .cloud_gitignore file to replace .gitignore...')

  // Load the zip file
  const data = fs.readFileSync(filePath)
  const zip = await JSZip.loadAsync(data)

  // Remove excluded paths first
  removeExcludedPaths(zip, excludedPaths || '.git/,.github/')

  // Process .cloud_gitignore replacement
  const wasProcessed = await processCloudGitignoreInZip(zip)

  if (wasProcessed) {
    // Write the updated zip back to the original file
    const updatedData = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 }
    })

    fs.writeFileSync(filePath, updatedData)
    core.info('Successfully replaced .gitignore with .cloud_gitignore content')
  }

  return filePath
}

async function processCloudGitignoreInZip(zip: JSZip): Promise<boolean> {
  // Look for .cloud_gitignore file in the zip
  const cloudGitignoreFile = Object.keys(zip.files).find(
    (filename) =>
      filename === '.cloud_gitignore' || filename.endsWith('/.cloud_gitignore')
  )

  if (!cloudGitignoreFile) {
    core.info(
      '.cloud_gitignore file not found - .gitignore file will not be modified'
    )
    return false
  }

  const cloudGitignoreZipFile = zip.files[cloudGitignoreFile]
  if (!cloudGitignoreZipFile || cloudGitignoreZipFile.dir) {
    core.info(
      '.cloud_gitignore found but is not a valid file - .gitignore file will not be modified'
    )
    return false
  }

  try {
    // Read the .cloud_gitignore content
    const cloudGitignoreContent = await cloudGitignoreZipFile.async('string')

    // Look for .gitignore files in the zip
    const gitignoreFiles = Object.keys(zip.files).filter(
      (filename) =>
        filename.endsWith('.gitignore') &&
        !filename.endsWith('.cloud_gitignore')
    )

    if (gitignoreFiles.length === 0) {
      core.info('No .gitignore files found in artifact to replace')
      return true
    }

    // Replace all .gitignore files with .cloud_gitignore content
    for (const gitignoreFile of gitignoreFiles) {
      const file = zip.files[gitignoreFile]
      if (file && !file.dir) {
        zip.file(gitignoreFile, cloudGitignoreContent)
        core.info(
          `Replaced ${gitignoreFile} with content from ${cloudGitignoreFile}`
        )
      }
    }

    return true
  } catch (error) {
    core.warning(`Failed to process .cloud_gitignore: ${error}`)
    return false
  }
}
