import * as xml2js from 'xml2js'
import * as core from '@actions/core'
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
  add?: NuGetXmlAttribute[]
  [key: string]: unknown
}

interface NuGetCredentialEntry {
  add?: NuGetXmlAttribute[]
  [key: string]: unknown
}

interface NuGetPackageSourceCredentials {
  [sourceName: string]: NuGetCredentialEntry[]
}

interface NuGetConfiguration {
  packageSources?: NuGetPackageSources[] | NuGetPackageSources | string
  packageSourceCredentials?:
    | NuGetPackageSourceCredentials[]
    | NuGetPackageSourceCredentials
    | string
  // Allow any other properties to preserve existing sections like activePackageSource
  [key: string]: unknown
}

interface NuGetConfigXml {
  configuration: NuGetConfiguration | string
}

/**
 * Encodes a string as an XML local name the same way .NET's
 * XmlConvert.EncodeLocalName does (which NuGet uses for credential element
 * names): characters that are not valid in an XML name are written as
 * _xHHHH_. A leading character that is not a valid name start character
 * (e.g. a digit) is also encoded. A literal "_x" that looks like an escape
 * sequence has its underscore escaped so the value round-trips.
 */
export function encodeXmlLocalName(name: string): string {
  // XML 1.0 (5th edition) NameStartChar / NameChar ranges (BMP only)
  const nameStartRanges: Array<[number, number]> = [
    [0x41, 0x5a], // A-Z
    [0x5f, 0x5f], // _
    [0x61, 0x7a], // a-z
    [0xc0, 0xd6],
    [0xd8, 0xf6],
    [0xf8, 0x2ff],
    [0x370, 0x37d],
    [0x37f, 0x1fff],
    [0x200c, 0x200d],
    [0x2070, 0x218f],
    [0x2c00, 0x2fef],
    [0x3001, 0xd7ff],
    [0xf900, 0xfdcf],
    [0xfdf0, 0xfffd]
  ]
  const nameExtraRanges: Array<[number, number]> = [
    [0x2d, 0x2e], // - .
    [0x30, 0x39], // 0-9
    [0xb7, 0xb7],
    [0x300, 0x36f],
    [0x203f, 0x2040]
  ]
  const inRanges = (code: number, ranges: Array<[number, number]>): boolean =>
    ranges.some(([lo, hi]) => code >= lo && code <= hi)
  const isNameStartChar = (c: string): boolean =>
    inRanges(c.charCodeAt(0), nameStartRanges)
  const isNameChar = (c: string): boolean =>
    isNameStartChar(c) || inRanges(c.charCodeAt(0), nameExtraRanges)
  const hex = (c: string): string =>
    c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')

  let result = ''
  for (let i = 0; i < name.length; i++) {
    const c = name[i]
    // Escape an underscore that would otherwise be read as an escape sequence
    if (c === '_' && /^_x[0-9A-Fa-f]{4}_/.test(name.substring(i))) {
      result += '_x005F_'
      continue
    }
    const valid = i === 0 ? isNameStartChar(c) : isNameChar(c)
    result += valid ? c : `_x${hex(c)}_`
  }
  return result
}

function isEnvironmentVariableReference(value: string): boolean {
  return /^%[^%\s]+%$/.test(value)
}

// xml2js (default explicitArray) always yields arrays for child elements, so a
// missing element is the only non-array case.
function toArray<T>(value: T[] | undefined): T[] {
  return value ?? []
}

/**
 * Adds or updates a NuGet package source in NuGet.config XML content.
 * This is a pure function: it does not touch the file system.
 *
 * @param config - The NuGet source configuration
 * @param existingXmlContent - The existing NuGet.config XML content, if any
 * @returns The result and the updated XML content
 */
export async function addOrUpdateNuGetConfigSource(
  config: NuGetSourceConfig,
  existingXmlContent?: string
): Promise<NuGetConfigModificationResult & { xmlContent: string }> {
  let nugetConfigXml: NuGetConfigXml
  let isNew = false

  if (existingXmlContent && existingXmlContent.trim()) {
    nugetConfigXml = (await xml2js.parseStringPromise(
      existingXmlContent
    )) as NuGetConfigXml
    if (!nugetConfigXml || nugetConfigXml.configuration === undefined) {
      throw new Error(
        'Existing NuGet.config does not have a <configuration> root element'
      )
    }
  } else {
    core.info('NuGet Config: No existing NuGet.config content, creating new')
    isNew = true
    nugetConfigXml = { configuration: {} }
  }

  // An empty <configuration/> element is parsed as an empty string
  if (typeof nugetConfigXml.configuration !== 'object') {
    nugetConfigXml.configuration = {}
  }
  const configuration = nugetConfigXml.configuration

  // Ensure packageSources exists and normalise structure
  if (
    !configuration.packageSources ||
    typeof configuration.packageSources !== 'object'
  ) {
    configuration.packageSources = { add: [] }
  }

  let packageSources: NuGetPackageSources
  if (Array.isArray(configuration.packageSources)) {
    if (
      !configuration.packageSources[0] ||
      typeof configuration.packageSources[0] !== 'object'
    ) {
      configuration.packageSources[0] = { add: [] }
    }
    packageSources = configuration.packageSources[0]
  } else {
    packageSources = configuration.packageSources
  }

  const sources = toArray(packageSources.add)
  packageSources.add = sources

  if (sources.length > 0) {
    core.info(
      `NuGet Config: Existing source keys: ${sources.map((s) => s.$.key).join(', ')}`
    )
  }

  const existingSource = sources.find((s) => s.$.key === config.name)
  if (existingSource) {
    core.info(
      `NuGet Config: Updating existing source '${config.name}' to '${config.source}'`
    )
    existingSource.$.value = config.source
  } else {
    core.info(
      `NuGet Config: Adding new source '${config.name}' with value '${config.source}'`
    )
    sources.push({ $: { key: config.name, value: config.source } })
  }

  // Handle credentials
  if (config.username && config.password) {
    if (!isEnvironmentVariableReference(config.password)) {
      core.warning(
        `NuGet Config: A clear-text password was provided for source '${config.name}'. ` +
          'It will be written to NuGet.config and committed to the Umbraco Cloud git repository. ' +
          'Consider storing the password as an Umbraco Cloud secret and passing a reference to it ' +
          'in the form %SECRET_NAME% instead.'
      )
    }

    if (
      !configuration.packageSourceCredentials ||
      typeof configuration.packageSourceCredentials !== 'object'
    ) {
      configuration.packageSourceCredentials = {}
    }

    let credentialsSection: NuGetPackageSourceCredentials
    if (Array.isArray(configuration.packageSourceCredentials)) {
      if (
        !configuration.packageSourceCredentials[0] ||
        typeof configuration.packageSourceCredentials[0] !== 'object'
      ) {
        configuration.packageSourceCredentials[0] = {}
      }
      credentialsSection = configuration.packageSourceCredentials[0]
    } else {
      credentialsSection = configuration.packageSourceCredentials
    }

    const elementName = encodeXmlLocalName(config.name)
    let entries = toArray(credentialsSection[elementName])
    if (entries.length === 0 || typeof entries[0] !== 'object') {
      entries = [{ add: [] }]
    }
    credentialsSection[elementName] = entries

    const credentialsList = toArray(entries[0].add)
    entries[0].add = credentialsList

    const setCredential = (key: string, value: string): void => {
      const entry = credentialsList.find((c) => c.$.key === key)
      if (entry) {
        entry.$.value = value
      } else {
        credentialsList.push({ $: { key, value } })
      }
    }
    setCredential('Username', config.username)
    setCredential('ClearTextPassword', config.password)
  }

  const builder = new xml2js.Builder({
    headless: false,
    xmldec: { version: '1.0', encoding: 'utf-8' },
    renderOpts: { pretty: true }
  })
  const newXml = builder.buildObject(nugetConfigXml)
  core.info(
    `NuGet Config: Generated configuration with sources: ${sources.map((s) => s.$.key).join(', ')}`
  )

  return {
    success: true,
    message: isNew
      ? `Created new NuGet.config and added source '${config.name}'.`
      : `Updated NuGet.config and added/updated source '${config.name}'.`,
    xmlContent: newXml
  }
}
