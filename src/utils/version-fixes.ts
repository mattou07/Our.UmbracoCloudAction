import * as core from '@actions/core'
import * as fs from 'fs'
import * as path from 'path'

/** A package version Umbraco Cloud runs, to be set in a project file. */
export interface VersionFix {
  name: string
  /** The Cloud version to set. */
  version: string
  /** Project file path relative to the repository root. */
  file: string
}

export interface AppliedVersionFix {
  name: string
  file: string
  from: string
  to: string
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const VERSION_PATTERN =
  /^\d+(\.\d+){1,3}(-[0-9A-Za-z][0-9A-Za-z.-]*)?(\+[0-9A-Za-z.-]+)?$/
const FILE_PATTERN = /\.(csproj|props|targets)$/i
const DRIVE_PATTERN = /^[A-Za-z]:/
const TAG_PATTERN = /<(?:PackageReference|PackageVersion)\b[^>]*>/gi
const INCLUDE_PATTERN = /\bInclude\s*=\s*(["'])(.*?)\1/i
const VERSION_ATTR_PATTERN = /(\bVersion\s*=\s*)(["'])(.*?)\2/i

/**
 * Validates one fix and resolves its file inside the workspace. The values
 * come from Cloud message text, so they are untrusted. Returns the absolute
 * path, or a reason the fix was rejected.
 */
function resolveTarget(
  workspaceDir: string,
  fix: VersionFix
): { target: string } | { reason: string } {
  if (!NAME_PATTERN.test(fix.name)) {
    return { reason: 'invalid package name' }
  }
  if (!VERSION_PATTERN.test(fix.version)) {
    return { reason: 'invalid version' }
  }

  const file = fix.file.replace(/\\/g, '/')
  if (
    file.startsWith('/') ||
    DRIVE_PATTERN.test(file) ||
    !FILE_PATTERN.test(file)
  ) {
    return {
      reason: 'file must be a relative .csproj, .props or .targets path'
    }
  }

  const target = path.resolve(workspaceDir, file)
  const relative = path.relative(workspaceDir, target)
  if (
    file.split('/').includes('..') ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    return { reason: 'file is outside the repository' }
  }
  return { target }
}

/** Replaces the Version attribute of matching tags; returns the old values. */
function bumpVersions(
  content: string,
  name: string,
  version: string
): { content: string; matched: number; previous: string[] } {
  let matched = 0
  const previous: string[] = []
  const updated = content.replace(TAG_PATTERN, (tag) => {
    const include = INCLUDE_PATTERN.exec(tag)
    if (!include || include[2].toLowerCase() !== name.toLowerCase()) {
      return tag
    }
    const versionAttr = VERSION_ATTR_PATTERN.exec(tag)
    if (!versionAttr) {
      return tag
    }
    matched++
    if (versionAttr[3] === version) {
      return tag
    }
    previous.push(versionAttr[3])
    return tag.replace(
      VERSION_ATTR_PATTERN,
      (_all, prefix: string, quote: string) =>
        `${prefix}${quote}${version}${quote}`
    )
  })
  return { content: updated, matched, previous }
}

/**
 * Raises package versions in project files to the versions Umbraco Cloud
 * runs. Only the Version attribute of matching PackageReference/PackageVersion
 * tags is touched; BOM, line endings and everything else are kept. Invalid
 * fixes are skipped with a warning, never thrown.
 */
export function applyVersionFixes(
  workspaceDir: string,
  fixes: VersionFix[]
): AppliedVersionFix[] {
  const applied: AppliedVersionFix[] = []

  for (const fix of fixes) {
    const label = `${fix.name} (${fix.file})`
    const resolved = resolveTarget(workspaceDir, fix)
    if ('reason' in resolved) {
      core.warning(`Skipping version fix for ${label}: ${resolved.reason}.`)
      continue
    }
    const { target } = resolved

    let stat: fs.Stats
    try {
      stat = fs.lstatSync(target)
    } catch {
      core.warning(`Skipping version fix for ${label}: file does not exist.`)
      continue
    }
    if (stat.isSymbolicLink()) {
      core.warning(`Skipping version fix for ${label}: file is a symlink.`)
      continue
    }

    const original = fs.readFileSync(target, 'utf8')
    const result = bumpVersions(original, fix.name, fix.version)
    if (result.matched === 0) {
      core.warning(
        `Could not find a PackageReference with a Version attribute for ${label}; the version may be set in a <Version> element or another file.`
      )
      continue
    }
    if (result.previous.length === 0) {
      continue
    }

    fs.writeFileSync(target, result.content, 'utf8')
    for (const from of result.previous) {
      core.info(`- ${fix.name}: ${from} → ${fix.version} (${fix.file})`)
      applied.push({
        name: fix.name,
        file: fix.file,
        from,
        to: fix.version
      })
    }
  }

  return applied
}
