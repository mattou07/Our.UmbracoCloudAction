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

  // Find NuGet.config (root or subfolders)
  const files = await glob('**/NuGet.config', { cwd, nodir: true })
  if (files.length > 0) {
    nugetConfigPath = path.join(cwd, files[0])
  } else {
    nugetConfigPath = path.join(cwd, 'NuGet.config')
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
