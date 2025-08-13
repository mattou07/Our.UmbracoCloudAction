export interface DeploymentRequest {
  targetEnvironmentAlias: string
  artifactId: string
  commitMessage: string
  noBuildAndRestore: boolean
  skipVersionCheck: boolean
}

export interface DeploymentResponse {
  deploymentId: string
  deploymentState: string
  modifiedUtc: string
  deploymentStatusMessages: Array<{
    timestampUtc: string
    message: string
  }>
  // Additional properties for compatibility
  id?: string
  projectId?: string
  targetEnvironmentAlias?: string
  state?: string
  createdUtc?: string
  completedUtc?: string
  statusMessages?: Array<{
    timestampUtc: string
    message: string
  }>
  [key: string]: unknown // Allow additional properties
}

// Full deployment status response (when needed)
export interface DeploymentStatus extends DeploymentResponse {
  id: string
  projectId: string
  targetEnvironmentAlias: string
  state: string
  createdUtc: string
}

export interface ArtifactResponse {
  artifactId: string
  fileName: string
  blobUrl: string
  filesize: number
  createdUtc: string
  description: string
  version: string
}

export interface ChangesResponse {
  changes: string // diff/patch text
}

export interface NuGetSourceConfig {
  name: string
  source: string
  username?: string
  password?: string
}

export interface NuGetConfigModificationResult {
  success: boolean
  message: string
  nugetConfigPath?: string
}

export interface DeploymentListResponse {
  projectId: string
  data: Array<{
    id: string
    artifactId: string | null
    targetEnvironmentAlias: string | null
    state: string
    createdUtc: string
    modifiedUtc: string
    completedUtc: string
  }>
  totalItems: number
  skippedItems: number
  takenItems: number
}

export interface ActionInputs {
  projectId: string
  apiKey: string
  action: string
  artifactId?: string
  targetEnvironmentAlias?: string
  commitMessage?: string
  noBuildAndRestore?: boolean
  skipVersionCheck?: boolean
  deploymentId?: string
  timeoutSeconds?: number
  filePath?: string
  description?: string
  version?: string
  changeId?: string
  baseUrl?: string
  baseBranch?: string
  uploadRetries?: number
  uploadRetryDelay?: number
  uploadTimeout?: number
  nugetSourceName?: string
  nugetSourceUrl?: string
  nugetSourceUsername?: string
  nugetSourcePassword?: string
  excludedPaths?: string
}

export interface ActionOutputs {
  deploymentId?: string
  artifactId?: string
  deploymentState?: string
  deploymentStatus?: string
  changes?: string
  latestCompletedDeploymentId?: string
  prUrl?: string
  prNumber?: string
  nugetSourceStatus?: string
}

export interface PullRequestInfo {
  url: string
  number: number
}
