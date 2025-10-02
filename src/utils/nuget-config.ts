import * as fs from 'fs'
import * as path from 'path'
import * as xml2js from 'xml2js'
import * as core from '@actions/core'
import { glob } from 'glob'
import {
  NuGetSourceConfig,
  NuGetConfigModificationResult
} from '../types/index.js'

// Define types for NuGet config XML structure
interface NuGetXmlAttribute {
  $: {
    key: string
    value: string
  }
}

interface NuGetPackageSources {
  add: NuGetXmlAttribute[]
}

interface NuGetPackageSourceCredentials {
  [sourceName: string]: Array<{
    add: NuGetXmlAttribute[]
  }>
}

interface NuGetConfiguration {
  packageSources: NuGetPackageSources[] | NuGetPackageSources
  packageSourceCredentials?:
    | NuGetPackageSourceCredentials[]
    | NuGetPackageSourceCredentials
  // Allow any other properties to preserve existing sections like activePackageSource
  [key: string]: any
}

interface NuGetConfigXml {
  configuration: NuGetConfiguration
}

/**
 * Adds or updates a NuGet package source in the NuGet.config file in the repo.
 * If NuGet.config does not exist, it will be created.
 */
export async function addOrUpdateNuGetConfigSource(
  config: NuGetSourceConfig
): Promise<NuGetConfigModificationResult> {
  const cwd = process.cwd()
  let nugetConfigPath: string | undefined

  core.info(`NuGet Config: Searching for NuGet.config files in ${cwd}`)
  core.info(
    `NuGet Config: Platform: ${process.platform}, Node version: ${process.version}`
  )

  // First, let's check if the exact file exists in root
  const exactRootPath = path.join(cwd, 'NuGet.config')
  const exactRootExists = fs.existsSync(exactRootPath)
  core.info(
    `NuGet Config: Direct check for ${exactRootPath}: ${exactRootExists ? 'EXISTS' : 'NOT FOUND'}`
  )

  // Find NuGet.config (root or subfolders) - try multiple case variations
  const searchPatterns = [
    '**/NuGet.config', // Standard case
    '**/nuget.config', // All lowercase
    '**/Nuget.config', // Only first letter uppercase
    '**/NUGET.CONFIG' // All uppercase
  ]

  let files: string[] = []
  for (const pattern of searchPatterns) {
    try {
      const found = await glob(pattern, {
        cwd,
        nodir: true,
        dot: false, // Don't include hidden files
        follow: true // Follow symbolic links
      })
      core.info(
        `NuGet Config: Pattern '${pattern}' found ${found.length} file(s): ${found.join(', ')}`
      )
      if (found.length > 0) {
        files = found
        break
      }
    } catch (error) {
      core.info(`NuGet Config: Error with pattern '${pattern}': ${error}`)
    }
  }

  if (files.length > 0) {
    nugetConfigPath = path.join(cwd, files[0])
    core.info(`NuGet Config: Using existing file: ${nugetConfigPath}`)
  } else {
    core.info(
      `NuGet Config: No existing NuGet.config files found with any pattern`
    )

    // Linux-specific debugging
    try {
      // Check if we can read the directory at all
      const dirStats = fs.statSync(cwd)
      core.info(
        `NuGet Config: Working directory stats - readable: ${dirStats.isDirectory()}, permissions: ${dirStats.mode}`
      )

      // Use fs.readdir to see what's actually in the root directory
      const rootContents = fs.readdirSync(cwd)
      core.info(
        `NuGet Config: Root directory contents (${rootContents.length} items): ${rootContents.slice(0, 20).join(', ')}${rootContents.length > 20 ? '...' : ''}`
      )

      // Look specifically for any files containing 'nuget' (case-insensitive)
      const nugetFiles = rootContents.filter((f) =>
        f.toLowerCase().includes('nuget')
      )
      if (nugetFiles.length > 0) {
        core.info(
          `NuGet Config: Files containing 'nuget' in root: ${nugetFiles.join(', ')}`
        )

        // Check permissions on these files
        for (const file of nugetFiles) {
          const filePath = path.join(cwd, file)
          try {
            const fileStats = fs.statSync(filePath)
            const isReadable =
              fs.constants && fileStats.mode & fs.constants.S_IRUSR
            core.info(
              `NuGet Config: File ${file} - size: ${fileStats.size}, readable: ${isReadable}, isFile: ${fileStats.isFile()}`
            )
          } catch (fileError) {
            core.info(`NuGet Config: Cannot stat file ${file}: ${fileError}`)
          }
        }
      }

      // Also try glob with more permissive options
      const allFiles = await glob('**/*', {
        cwd,
        nodir: true,
        dot: true,
        follow: true,
        maxDepth: 2 // Only go 2 levels deep for performance
      })
      const configFiles = allFiles.filter((f) =>
        f.toLowerCase().includes('nuget')
      )
      if (configFiles.length > 0) {
        core.info(
          `NuGet Config: NuGet-related files found with permissive glob: ${configFiles.join(', ')}`
        )
      }
    } catch (error) {
      core.info(`NuGet Config: Error during Linux-specific debugging: ${error}`)
    }

    nugetConfigPath = path.join(cwd, 'NuGet.config')
    core.info(`NuGet Config: Will create new file at: ${nugetConfigPath}`)
  }

  let nugetConfigXml: NuGetConfigXml = {
    configuration: { packageSources: { add: [] } }
  }
  let isNew = false
  if (fs.existsSync(nugetConfigPath)) {
    core.info(`NuGet Config: Reading existing file from ${nugetConfigPath}`)
    const xmlContent = fs.readFileSync(nugetConfigPath, 'utf8')
    core.debug(`NuGet Config: Original file content:\n${xmlContent}`)
    nugetConfigXml = (await xml2js.parseStringPromise(
      xmlContent
    )) as NuGetConfigXml
    core.debug(
      `NuGet Config: Parsed configuration sections: ${JSON.stringify(Object.keys(nugetConfigXml.configuration))}`
    )
  } else {
    core.info(`NuGet Config: Creating new file at ${nugetConfigPath}`)
    isNew = true
    nugetConfigXml = {
      configuration: {
        packageSources: {
          add: []
        }
      }
    }
  }

  // Ensure packageSources exists and normalize structure
  if (!nugetConfigXml.configuration.packageSources) {
    core.info(
      'NuGet Config: packageSources section not found, creating new one'
    )
    nugetConfigXml.configuration.packageSources = { add: [] }
  }

  core.debug(
    `NuGet Config: packageSources type is ${Array.isArray(nugetConfigXml.configuration.packageSources) ? 'array' : 'object'}`
  )
  core.debug(
    `NuGet Config: Full configuration structure: ${JSON.stringify(Object.keys(nugetConfigXml.configuration))}`
  )

  // Handle both array and object formats from xml2js
  let packageSources: NuGetPackageSources
  if (Array.isArray(nugetConfigXml.configuration.packageSources)) {
    // If it's an array, use the first element (should be the main packageSources)
    core.info(
      `NuGet Config: packageSources is array with ${nugetConfigXml.configuration.packageSources.length} elements`
    )
    packageSources = nugetConfigXml.configuration
      .packageSources[0] as NuGetPackageSources
  } else {
    // If it's a single object, use it directly
    core.info('NuGet Config: packageSources is single object')
    packageSources = nugetConfigXml.configuration
      .packageSources as NuGetPackageSources
  }

  // Ensure the add array exists
  if (!packageSources.add) {
    core.info(
      'NuGet Config: add array not found in packageSources, creating new one'
    )
    packageSources.add = []
  }

  core.info(
    `NuGet Config: Found ${packageSources.add.length} existing package sources`
  )
  if (packageSources.add.length > 0) {
    const existingKeys = packageSources.add.map((s) => s.$.key)
    core.info(`NuGet Config: Existing source keys: ${existingKeys.join(', ')}`)
  }

  // Ensure add is an array (xml2js might return a single object if there's only one source)
  if (!Array.isArray(packageSources.add)) {
    core.info('NuGet Config: Converting single add object to array')
    packageSources.add = [packageSources.add]
  }

  const sources = packageSources.add

  // Add or update the source
  const existingSource = sources.find((s) => s.$.key === config.name)
  if (existingSource) {
    core.info(
      `NuGet Config: Updating existing source '${config.name}' from '${existingSource.$.value}' to '${config.source}'`
    )
    existingSource.$.value = config.source
  } else {
    core.info(
      `NuGet Config: Adding new source '${config.name}' with value '${config.source}'`
    )
    sources.push({
      $: {
        key: config.name,
        value: config.source
      }
    })
  }

  core.info(
    `NuGet Config: Total package sources after modification: ${sources.length}`
  )
  core.debug(
    `NuGet Config: All source keys after modification: ${sources.map((s) => s.$.key).join(', ')}`
  )

  // Handle credentials
  if (config.username && config.password) {
    if (!nugetConfigXml.configuration.packageSourceCredentials) {
      nugetConfigXml.configuration.packageSourceCredentials = {}
    }

    // Handle both array and object formats from xml2js
    let credentialsSection: NuGetPackageSourceCredentials
    if (Array.isArray(nugetConfigXml.configuration.packageSourceCredentials)) {
      credentialsSection = nugetConfigXml.configuration
        .packageSourceCredentials[0] as NuGetPackageSourceCredentials
    } else {
      credentialsSection = nugetConfigXml.configuration
        .packageSourceCredentials as NuGetPackageSourceCredentials
    }

    if (!credentialsSection[config.name]) {
      credentialsSection[config.name] = [{ add: [] }]
    }

    const credentialsList = credentialsSection[config.name][0].add

    // Update or add username
    const usernameEntry = credentialsList.find((c) => c.$.key === 'Username')
    if (usernameEntry) {
      usernameEntry.$.value = config.username
    } else {
      credentialsList.push({
        $: {
          key: 'Username',
          value: config.username
        }
      })
    }

    // Update or add password
    const passwordEntry = credentialsList.find(
      (c) => c.$.key === 'ClearTextPassword'
    )
    if (passwordEntry) {
      passwordEntry.$.value = config.password
    } else {
      credentialsList.push({
        $: {
          key: 'ClearTextPassword',
          value: config.password
        }
      })
    }
  }

  // Write back the NuGet.config with XML declaration
  core.debug(
    `NuGet Config: Final configuration sections before building XML: ${JSON.stringify(Object.keys(nugetConfigXml.configuration))}`
  )
  const builder = new xml2js.Builder({
    headless: false,
    xmldec: { version: '1.0', encoding: 'utf-8' },
    renderOpts: { pretty: true }
  })
  const newXml = builder.buildObject(nugetConfigXml)
  core.info(`NuGet Config: Writing updated configuration to ${nugetConfigPath}`)
  core.debug(`NuGet Config: Final XML content:\n${newXml}`)
  fs.writeFileSync(nugetConfigPath, newXml, 'utf8')

  return {
    success: true,
    message: isNew
      ? `Created new NuGet.config and added source '${config.name}'.`
      : `Updated NuGet.config and added/updated source '${config.name}'.`,
    nugetConfigPath
  }
}
