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
        inputs.nugetSourcePassword
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
      modifiedFilePath = await processCloudGitignore(inputs.filePath!)
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
  nugetSourcePassword?: string
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

async function processCloudGitignore(filePath: string): Promise<string> {
  core.info('Checking for .cloud_gitignore file to replace .gitignore...')

  // Load the zip file
  const data = fs.readFileSync(filePath)
  const zip = await JSZip.loadAsync(data)

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
