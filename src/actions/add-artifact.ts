import * as core from '@actions/core'
import { UmbracoCloudAPI } from '../api/umbraco-cloud-api.js'
import { ActionInputs, ActionOutputs } from '../types/index.js'
import { validateRequiredInputs } from '../utils/helpers.js'
import { addOrUpdateNuGetConfigSource } from '../utils/nuget-config.js'
import * as fs from 'fs'
import * as path from 'path'
import * as exec from '@actions/exec'
import JSZip from 'jszip'

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
        inputs.gitignoreReplacementPath
      )
      nugetSourceStatus = 'NuGet.config successfully injected into artifact'
    } catch (error) {
      const errorMessage = `Failed to configure NuGet source: ${error}`
      core.warning(errorMessage)
      nugetSourceStatus = errorMessage
    }
  } else {
    // Process gitignore replacement if path provided, even without NuGet config
    if (inputs.gitignoreReplacementPath) {
      try {
        modifiedFilePath = await processGitignoreReplacement(
          inputs.filePath!,
          inputs.gitignoreReplacementPath
        )
        core.info('Successfully replaced .gitignore with custom file')
      } catch (error) {
        core.warning(`Failed to replace .gitignore: ${error}`)
      }
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
  gitignoreReplacementPath?: string
): Promise<string> {
  core.info(
    'NuGet source configuration provided. Injecting NuGet.config into zip...'
  )

  // Load the zip file
  const data = fs.readFileSync(filePath)
  const zip = await JSZip.loadAsync(data)

  // Remove all .git/ entries
  let gitFolderRemoved = false
  Object.keys(zip.files).forEach((filename) => {
    if (filename.startsWith('.git/')) {
      zip.remove(filename)
      gitFolderRemoved = true
    }
  })

  if (gitFolderRemoved) {
    core.info('.git folder discovered and removed from the zip')
  }

  // Add or update NuGet.config in the root
  const nugetConfig = {
    name: nugetSourceName,
    source: nugetSourceUrl,
    username: nugetSourceUsername,
    password: nugetSourcePassword
  }

  const result = await addOrUpdateNuGetConfigSource(nugetConfig)
  core.info(`NuGet.config ${result.message}`)

  // Read the generated NuGet.config from disk and add to zip
  const nugetConfigContent = fs.readFileSync('NuGet.config', 'utf8')
  zip.file('NuGet.config', nugetConfigContent)

  // Remove the temp NuGet.config file
  fs.unlinkSync('NuGet.config')

  // Process gitignore replacement if path provided
  if (gitignoreReplacementPath) {
    await processGitignoreReplacementInZip(zip, gitignoreReplacementPath)
  }

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
    'Successfully injected NuGet.config and removed .git from artifact zip'
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

async function processGitignoreReplacement(
  filePath: string,
  gitignoreReplacementPath: string
): Promise<string> {
  core.info(
    `Replacing .gitignore with custom file: ${gitignoreReplacementPath}`
  )

  // Validate the replacement file exists
  if (!fs.existsSync(gitignoreReplacementPath)) {
    throw new Error(
      `Gitignore replacement file not found: ${gitignoreReplacementPath}`
    )
  }

  // Load the zip file
  const data = fs.readFileSync(filePath)
  const zip = await JSZip.loadAsync(data)

  // Process gitignore replacement
  await processGitignoreReplacementInZip(zip, gitignoreReplacementPath)

  // Write the updated zip back to the original file
  const updatedData = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  })

  fs.writeFileSync(filePath, updatedData)
  core.info('Successfully replaced .gitignore with custom file')

  return filePath
}

async function processGitignoreReplacementInZip(
  zip: JSZip,
  gitignoreReplacementPath: string
): Promise<void> {
  // Read the replacement gitignore content
  const replacementContent = fs.readFileSync(gitignoreReplacementPath, 'utf8')

  // Look for .gitignore files in the zip
  const gitignoreFiles = Object.keys(zip.files).filter(
    (filename) =>
      filename.endsWith('.gitignore') || filename.endsWith('/.gitignore')
  )

  if (gitignoreFiles.length === 0) {
    core.info('No .gitignore files found in artifact to replace')
    return
  }

  for (const gitignoreFile of gitignoreFiles) {
    const file = zip.files[gitignoreFile]
    if (file && !file.dir) {
      try {
        // Replace the entire content with the replacement file
        zip.file(gitignoreFile, replacementContent)
        core.info(
          `Replaced ${gitignoreFile} with content from ${gitignoreReplacementPath}`
        )
      } catch (error) {
        core.warning(`Failed to replace ${gitignoreFile}: ${error}`)
      }
    }
  }
}
