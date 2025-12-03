# Copilot Instructions for Umbraco Cloud Deployment Action

## Project Overview

This is a GitHub Action (Node.js/TypeScript) for orchestrating deployments to
Umbraco Cloud. It provides a unified CI/CD entry point for deploying code and
content changes across Umbraco Cloud environments (Development → Staging →
Production).

**What it does**: Automates the Umbraco Cloud deployment workflow by handling
artifact management, deployment orchestration, status monitoring, and content
synchronization through the Umbraco Cloud REST API.

**Key Pattern**: Command-dispatcher architecture - `main.ts` routes to action
handlers in `src/actions/` based on the `action` input parameter. Each action
handles a specific deployment operation: `start-deployment`, `check-status`,
`add-artifact`, `get-changes`, `apply-patch`.

**Umbraco Context**: Umbraco Cloud is a managed hosting platform where
deployments flow from Development → Staging → Production environments. Code
changes (`.cloudsource` artifacts) are packaged, uploaded, and deployed via the
API. The action automates CI/CD by eliminating manual Cloud Portal steps.

## Architecture

### Core Components

1. **API Layer** (`src/api/umbraco-cloud-api.ts`)

   - Single class `UmbracoCloudAPI` wrapping Umbraco Cloud REST endpoints (v2
     API)
   - Handles authentication via `Umbraco-Cloud-Api-Key` header
   - **Resilience features**:
     - Rate limiting: Exponential backoff with max 3 retries for 429 responses
       (extracts retry-after from headers)
     - Environment alias case-sensitivity: Automatic fallback to lowercase if
       API rejects uppercase
     - Network errors: Wrapped with operation context for debugging
   - **Core methods**:
     - `startDeployment(request: DeploymentRequest): Promise<string>` -
       Initiates deployment, returns deploymentId
     - `checkDeploymentStatus(deploymentId: string): Promise<DeploymentResponse>` -
       Fetches deployment state
     - `uploadArtifact(filePath: string, ...): Promise<ArtifactResponse>` -
       Uploads `.cloudsource` zip files
     - `getChangesById(deploymentId: string, targetAlias: string): Promise<ChangesResponse>` -
       Retrieves diff/patch
     - `applyPatch(changeId: string, targetAlias: string): Promise<void>` -
       Applies content changes

2. **Action Handlers** (`src/actions/`)

   - **`start-deployment.ts`**:
     - Validates `artifactId` and `targetEnvironmentAlias` inputs
     - Calls `api.startDeployment()` with deployment config (build/restore
       flags, skip version check)
     - Invokes `pollDeploymentStatus()` to await completion (blocking operation)
     - Sets GitHub output: `deploymentId`
   - **`check-status.ts`**:
     - Monitors existing deployment via `deploymentId`
     - Polls until `Completed` or `Failed` state
     - On success: Retrieves changes and optionally creates PR with diff
     - Handles "updating marker" errors (site blocked during Umbraco version
       upgrades)
     - Outputs: `deploymentState`, `deploymentStatus`, optional `pullRequestUrl`
   - **`add-artifact.ts`**:
     - Packages `.cloudsource` zip from `filePath` input
     - Removes excluded paths (`.git/`, `.github/` by default) to reduce upload
       size
     - Optionally modifies NuGet.config if custom package sources provided
     - Uploads with retry logic (configurable retries, timeouts)
     - Outputs: `artifactId`, `fileName`, `blobUrl`
   - **`get-changes.ts`**:
     - Retrieves diff between deployment and target environment
     - Returns patch/changeset as JSON output
   - **`apply-patch.ts`**:
     - Applies content changes identified by `changeId`
     - Used for non-code content syncs
   - Each handler validates inputs via `validateRequiredInputs()` and returns
     `ActionOutputs`

3. **Input/Output Management** (`src/main.ts`)

   - `getActionInputs()`: Parses GitHub Action inputs (via `@actions/core`) into
     `ActionInputs` type
   - Type-safe conversion:
     - String inputs: `core.getInput('name')`
     - Boolean inputs: `core.getBooleanInput('name')` (parses "true"/"false")
     - Integer inputs: `parseInt(core.getInput('name'), 10)` for timeouts,
       retries
   - Default fallbacks: Base URL, timeouts, excluded paths defined here
   - Input relay flow: `action.yml` defines available inputs →
     `getActionInputs()` parses → `main.ts` routes to handlers

4. **Polling & Status Management** (`src/utils/deployment-polling.ts`)

   - `pollDeploymentStatus()` continuous loop with configurable interval
     (default 25s) and max duration (default 15min)
   - Polls `/v2/projects/{projectId}/deployments/{deploymentId}` endpoint
   - Handles transient errors: 401 (auth), 404 (not found), network timeouts
     with retries
   - Emits real-time status messages from Umbraco: deployment state, phase
     names, progress
   - Detects blocking errors: "updating marker" (site locked during version
     upgrades)
   - Supports conditional requests via `lastModifiedUtc` query param to optimize
     API calls

5. **Type System** (`src/types/index.ts`)
   - `ActionInputs`: All possible action parameters (32+ fields)
     - Deployment: `artifactId`, `targetEnvironmentAlias`, `commitMessage`,
       `skipVersionCheck`
     - Polling: `deploymentId`, `timeoutSeconds`
     - Artifact: `filePath`, `version`, `description`, `uploadRetries`,
       `uploadRetryDelay`, `uploadTimeout`
     - NuGet: `nugetSourceName`, `nugetSourceUrl`, `nugetSourceUsername`,
       `nugetSourcePassword`
     - GitHub: `baseBranch`, excluded paths
   - `DeploymentResponse`: Flexible schema supporting both old/new Umbraco API
     formats
     - Primary fields: `deploymentId`, `deploymentState` (or aliases `id`,
       `state`)
     - Status messages: `deploymentStatusMessages[].message` for real-time
       feedback
     - Timestamps: `createdUtc`, `completedUtc`, `modifiedUtc`
   - `ArtifactResponse`, `ChangesResponse`, `DeploymentListResponse`: Typed API
     responses

### Data Flow Diagram

**Start Deployment Workflow**:

```
GitHub Action Inputs (action.yml)
  ↓ getActionInputs() [main.ts] → type-safe ActionInputs object
  ↓ handleStartDeployment() [actions/start-deployment.ts]
  ├─ Validates: artifactId, targetEnvironmentAlias required
  ├─ POST /v2/projects/{projectId}/deployments [api/umbraco-cloud-api.ts]
  │  └─ Sends: { artifactId, targetEnvironmentAlias, commitMessage, noBuildAndRestore, skipVersionCheck }
  │  └─ Returns: deploymentId
  ├─ pollDeploymentStatus() [utils/deployment-polling.ts]
  │  └─ GET /v2/projects/{projectId}/deployments/{deploymentId} [interval: 25s, timeout: 900s]
  │  └─ Loops until state === 'Completed' || 'Failed' || timeout exceeded
  │  └─ Emits status logs every iteration
  └─ core.setOutput('deploymentId', deploymentId) → GitHub outputs

GitHub Actions workflow continues with deployment outputs available
```

**Artifact Upload Workflow**:

```
add-artifact action
  ├─ Validate: filePath required
  ├─ Load .cloudsource zip from filePath
  ├─ Remove excluded paths (.git/, .github/) to reduce size
  ├─ Modify NuGet.config (if nugetSource* inputs provided)
  ├─ POST /v2/projects/{projectId}/artifacts [multipart/form-data] [with retries]
  │  └─ Retries: up to N attempts with exponential backoff
  │  └─ Timeout: per-request timeout (default 60s per upload attempt)
  └─ core.setOutput('artifactId', response.artifactId)

artifactId then used in subsequent start-deployment action
```

## Development Workflows

### Build & Package

- **`npm run package`**: Compiles TypeScript (tsconfig.json) → bundles with
  Rollup (`rollup.config.ts`) → outputs `dist/index.js`
  - Input: `src/index.ts` (simple entry point importing `main.js`)
  - Output: `dist/index.js` (minified ESM with sourcemaps)
  - **Critical**: GitHub Actions runtime executes this bundled file, not
    TypeScript directly
  - Plugins: typescript, node-resolve, commonjs, json (for NuGet XML parsing)
- **`npm run package:watch`**: Watches for changes in `src/`, rebuilds
  `dist/index.js` on save
  - Useful during active development to validate bundling
- **`npm run bundle`**: Runs format:write → package (prettier + rollup)
- **Must run before committing**: `npm run all` executes: format:write → lint →
  test → coverage → package
  - Ensures code style, no errors, test pass, coverage tracked, and distribution
    is up-to-date

### Testing Strategy

- **Framework**: Jest with TypeScript preset (`ts-jest`)
- **Config** (`jest.config.js`):
  - ESM preset for modern JavaScript modules
  - `moduleNameMapper`: Strips `.js` extensions to match ESM imports (required
    for ts-jest)
  - `testEnvironment: 'node'` for testing GitHub Actions context
  - `collectCoverageFrom: ['src/**/*.ts']` tracks coverage badge
- **Run tests**: `npm test` (sets `NODE_OPTIONS=--experimental-vm-modules` for
  native ESM)
- **Coverage badge**: `npm run coverage` generates `badges/coverage.svg` using
  `make-coverage-badge`
- **Test files**: Located in `__tests__/` matching pattern `*.test.ts`
  - `main.test.ts`: Tests `getActionInputs()` parsing, action routing
  - `add-artifact.test.ts`: Tests zip manipulation, path exclusion, NuGet config
    modifications
  - `deployment-polling.test.ts`: Tests status polling loop, state transitions,
    error handling
  - `utils/nuget-config.test.ts`: Tests XML parsing and modification
  - `github/pull-request.test.ts`: Tests PR creation with diffs

### Testing Patterns & Mock Strategy

- **Input Simulation**: Mock GitHub Action inputs via `process.env.INPUT_*` (not
  `@actions/core` directly)
  - Example: Set `process.env.INPUT_PROJECTID = 'test-id'` →
    `core.getInput('projectId')` returns `'test-id'`
  - Helper function (from `main.test.ts`):
    ```typescript
    function defineEnv(
      inputs: Record<string, string | number | boolean | undefined>
    ) {
      for (const [key, value] of Object.entries(inputs)) {
        process.env[`INPUT_${key.toUpperCase()}`] = value?.toString()
      }
    }
    ```
  - Why: GitHub Actions reads `action.yml` inputs → sets environment variables →
    `@actions/core` reads them
- **API Mocking**: Mock `fetch()` globally or use `__fixtures__/` with canned
  responses
  - Example fixtures: `__fixtures__/core.ts` (mock deployment responses),
    `__fixtures__/wait.ts` (mock timers)
- **File I/O Testing**: Use temporary directories or in-memory zip operations
  (JSZip)
- **beforeEach cleanup**: Reset `process.env` keys starting with `INPUT_`
  between tests to prevent cross-test pollution

### Code Quality

- **Linting**: ESLint with flat config (`eslint.config.mjs`)
  - `npm run lint` checks `src/`, `__tests__/`, and config files
  - Enforces: no unused variables, proper async/await, consistent imports
- **Formatting**: Prettier
  - `npm run format:check` validates formatting
  - `npm run format:write` auto-fixes formatting (applied in `npm run bundle`)
  - Respects `.prettierrc` for code style (indentation, quotes, line length)
- **Local testing**: `npm run local-action`
  - Uses `@github/local-action` to test bundled action in local environment
  - Requires `.env` file with inputs: `INPUT_PROJECTID=...`, `INPUT_APIKEY=...`,
    `INPUT_ACTION=...`
  - Simulates GitHub Actions runtime without CI/CD

## Project Conventions

### Error Handling & Resilience Patterns

1. **Rate Limiting (429 Too Many Requests)**

   - **Location**: `UmbracoCloudAPI.retryWithRateLimit()` method
   - **Strategy**: Exponential backoff with max 3 retries
     - Attempt 1: Wait 1s, then retry
     - Attempt 2: Wait 2s, then retry
     - Attempt 3: Wait 4s, then retry
     - Attempt 4: Throw error to workflow
   - **Smart parsing**: Extracts `Retry-After` header from 429 response if
     available
   - **When it happens**: Umbraco Cloud API has rate limits; automated workflows
     can trigger this
   - **Logging**: `core.info()` emits retry attempt count and wait duration

2. **Environment Alias Case-Sensitivity**

   - **Problem**: Umbraco Cloud API is case-sensitive for environment aliases
     (e.g., `staging` vs `Staging`)
   - **Solution**: `retryWithLowercaseEnvironmentAlias()` wrapper in API layer
   - **Flow**: If initial request fails with "No environments matches the
     provided alias", automatically retry with lowercase
   - **Example**: User provides `Staging` → first call fails → automatically
     retries with `staging`
   - **Logging**: Emits info log when fallback occurs so users understand what
     happened

3. **API Error Wrapping**

   - All API calls wrapped with operation context: operation name, details
   - Example:
     `Error in checkDeploymentStatus (retry with lowercase): <error message>`
   - Enables debugging by showing which operation failed and what retry strategy
     was attempted

4. **Polling Resilience**
   - Network errors during polling don't fail immediately; logged as warnings
     and retry next interval
   - 401/404 errors don't fail immediately; often transient during deployment
   - Only fails after max duration exceeded (default 900s / 15 minutes) or
     terminal state reached

### Input Validation & Type Conversion

1. **Per-Action Validation**

   - Each action calls `validateRequiredInputs(inputs, ['field1', 'field2'])` at
     start
   - Throws error if required fields are missing, preventing API calls with
     incomplete data
   - Example (`start-deployment.ts`):
     ```typescript
     validateRequiredInputs(inputs, ['artifactId', 'targetEnvironmentAlias'])
     ```

2. **Type-Safe Input Parsing** (`src/main.ts`)

   - String inputs: `core.getInput('name', { required: true })`
   - Boolean inputs: `core.getBooleanInput('name')` (parses GitHub's
     "true"/"false")
   - Integer inputs: `parseInt(core.getInput('name') || 'defaultValue', 10)`
   - Defaults: Base URL, timeouts, excluded paths set here to avoid null checks
     throughout codebase
   - Example:
     ```typescript
     timeoutSeconds: parseInt(core.getInput('timeoutSeconds') || '1200', 10)
     uploadRetries: parseInt(core.getInput('upload-retries') || '3', 10)
     ```

3. **Input Naming Convention**
   - `action.yml` uses kebab-case: `upload-retries`, `upload-retry-delay`,
     `target-environment-alias`
   - `getActionInputs()` converts to camelCase: `uploadRetries`,
     `uploadRetryDelay`, `targetEnvironmentAlias`
   - Reason: YAML convention vs JavaScript convention

### GitHub Action Integration Practices

1. **Logging via @actions/core**

   - `core.info(message)`: Informational logs visible in workflow (deployment
     progress, retries)
   - `core.debug(message)`: Debug logs (only visible with `--debug` flag)
   - `core.warning(message)`: Warnings (highlighted in workflow, non-fatal)
   - `core.error(message)`: Error details (context before `core.setFailed()`)
   - `core.setFailed(message)`: Fail the entire action step
   - **Never use `console.log()`**: Won't appear in GitHub Actions UI

2. **Output Management**

   - Set outputs via `core.setOutput(key, value)` → accessible to downstream
     steps as `steps.<step-id>.outputs.<key>`
   - Example: `core.setOutput('deploymentId', id)` → use as
     `${{ steps.deploy.outputs.deploymentId }}` in workflow
   - Large outputs (e.g., deployment status): Stringify JSON
     `JSON.stringify(status)` to avoid multi-line issues

3. **Environment Access**
   - GitHub provides context via `@actions/github`: `github.context` has repo,
     ref, actor, payload
   - Used in `check-status.ts` to create PRs with deployment results
   - OAuth token available via `github.context.token` for authenticated API
     calls

### ESM Module & Import Conventions

1. **File Extensions Required**

   - All imports include `.js` extension (ESM specification requirement)
   - `import { Foo } from '../api/module.js'` ✓
   - `import { Foo } from '../api/module'` ✗ (fails at runtime)
   - Reason: TypeScript compiles to JavaScript; Jest's `moduleNameMapper`
     rewrites imports, but source must be correct

2. **Path Styles**

   - Relative paths from current file: `./file.js`, `../api/module.js`
   - Absolute paths: Avoid (use relative instead)
   - Example structure:
     ```
     src/actions/start-deployment.ts
       ├─ import { UmbracoCloudAPI } from '../api/umbraco-cloud-api.js'
       ├─ import { ActionInputs } from '../types/index.js'
       └─ import { pollDeploymentStatus } from '../utils/deployment-polling.js'
     ```

3. **Type Imports**
   - Import types alongside values from `types/index.ts`
   - Example: `import { ActionInputs, ActionOutputs } from '../types/index.js'`

### File Organization Patterns

1. **Actions are Async Handlers**

   - Location: `src/actions/<action-name>.ts`
   - Signature:
     `export async function handle<ActionName>(api: UmbracoCloudAPI, inputs: ActionInputs): Promise<ActionOutputs>`
   - Steps: Validate → Call API → Set outputs → Return outputs
   - Dispatch: Called from `main.ts` based on `action` input parameter

2. **Utilities are Reusable Functions**

   - `deployment-polling.ts`: Long-running loop, shared by multiple actions
   - `nuget-config.ts`: XML parsing/modification, specific to artifact uploads
   - `helpers.ts`: Git validation, input validation helpers
   - `pull-request.ts`: GitHub PR creation with diffs (used by check-status)

3. **API Class is Single Responsibility**
   - All HTTP calls to Umbraco Cloud go through `UmbracoCloudAPI` class
   - Encapsulates authentication, retry logic, error handling
   - Methods are low-level (direct API endpoints), not action-specific
   - Reduces duplication of retry/auth logic across actions

## Key Files & Their Purposes

| File                              | Purpose                         | Key Exports                                                               |
| --------------------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| `src/index.ts`                    | Entry point for bundler         | Imports and runs `main.js`                                                |
| `src/main.ts`                     | Action dispatcher               | `getActionInputs()`, `run()`                                              |
| `src/api/umbraco-cloud-api.ts`    | Umbraco Cloud REST client       | `UmbracoCloudAPI` class with retry/case-sensitivity logic                 |
| `src/actions/start-deployment.ts` | Start deployment handler        | `handleStartDeployment()`                                                 |
| `src/actions/check-status.ts`     | Monitor deployment status       | `handleCheckStatus()`, PR creation logic                                  |
| `src/actions/add-artifact.ts`     | Upload `.cloudsource` artifacts | `handleAddArtifact()`, path exclusion, NuGet config modification          |
| `src/actions/get-changes.ts`      | Retrieve deployment diffs       | `handleGetChanges()`                                                      |
| `src/actions/apply-patch.ts`      | Apply content patches           | `handleApplyPatch()`                                                      |
| `src/types/index.ts`              | TypeScript interfaces           | `ActionInputs`, `ActionOutputs`, `DeploymentResponse`, `ArtifactResponse` |
| `src/utils/deployment-polling.ts` | Status polling loop             | `pollDeploymentStatus()`, handles state transitions & blocking errors     |
| `src/utils/nuget-config.ts`       | NuGet config modification       | `addOrUpdateNuGetConfigSource()`, XML parsing/serialization               |
| `src/utils/helpers.ts`            | Shared utilities                | `validateRequiredInputs()`, `validateGitRepository()`, `sleep()`          |
| `src/github/pull-request.ts`      | GitHub PR creation              | `createPullRequestWithPatch()`, authentication via token                  |
| `action.yml`                      | GitHub Action metadata          | Defines all inputs/outputs, descriptions, branding                        |
| `rollup.config.ts`                | Build bundler config            | Bundles `src/index.ts` → `dist/index.js`                                  |
| `jest.config.js`                  | Test runner configuration       | ESM preset, module name mapping, coverage collection                      |
| `tsconfig.json`                   | TypeScript configuration        | ESM modules, output to `dist/`                                            |
| `eslint.config.mjs`               | Linter configuration            | Flat config format, enforces best practices                               |
| `.prettierrc`                     | Code formatter config           | Code style (indentation, quotes, line length)                             |
| `__tests__/*.test.ts`             | Unit & integration tests        | Mock inputs, API responses, file operations                               |
| `__fixtures__/`                   | Test data & mocks               | Sample API responses, mock utilities                                      |
| `dist/index.js`                   | **GitHub-executed file**        | Bundled, minified output (auto-generated by `npm run package`)            |

## Integration Points & External Dependencies

### Umbraco Cloud API (https://api.cloud.umbraco.com)

**Authentication**: All requests include header
`Umbraco-Cloud-Api-Key: <apiKey>`

**Endpoints Used**:

- **Deployments**:
  - `POST /v2/projects/{projectId}/deployments` - Start deployment
  - `GET /v2/projects/{projectId}/deployments/{deploymentId}` - Check status
    (polled continuously)
  - `GET /v2/projects/{projectId}/deployments/{deploymentId}/changes` - Retrieve
    diff
- **Artifacts**:
  - `POST /v2/projects/{projectId}/artifacts` - Upload `.cloudsource` zip
- **Patches**:
  - `POST /v2/projects/{projectId}/environments/{environmentAlias}/changes/{changeId}/apply` -
    Apply patch
- **Schema Variations**: API supports both old/new response formats (e.g., `id`
  vs `deploymentId`)

**Rate Limiting**: Returns 429 with `Retry-After` header; action implements
exponential backoff

### GitHub Actions Runtime

**Input Interface** (`action.yml` → process.env → `@actions/core`):

- Inputs defined in `action.yml` become environment variables (`INPUT_<NAME>`)
- `@actions/core` reads and parses them
- Action validates inputs before API calls

**Output Interface** (via `core.setOutput()`):

- Outputs accessible in workflow as `${{ steps.<step-id>.outputs.<key> }}`
- Large outputs: JSON-stringify to avoid multi-line parsing issues

**Logging** (via `@actions/core`):

- `core.info()` → visible in workflow logs
- `core.debug()` → only with `--debug` flag
- `core.warning()` → highlighted in workflow
- `core.error()` → context before failure

**Context** (via `@actions/github`):

- `github.context`: Repository, ref, actor, pull request details
- `github.context.token`: OAuth token for authenticated API calls (used for PR
  creation)

### GitHub API (for PR Creation)

**Authenticated via**: `github.context.token` (default
`${{ secrets.GITHUB_TOKEN }}`)

**Used by**: `check-status.ts` to create pull requests with deployment diffs

- `POST /repos/{owner}/{repo}/pulls` - Create PR with patch content as body

### NuGet Package Sources (Optional)

**Configuration**: Modified in artifact's `NuGet.config` before upload

- **Inputs**: `nuget-source-name`, `nuget-source-url`, `nuget-source-username`,
  `nuget-source-password`
- **Processing**: `addOrUpdateNuGetConfigSource()` parses XML, modifies
  `<packageSources>` section
- **Passed to Umbraco**: Included in uploaded `.cloudsource` artifact
- **Usage**: Umbraco Cloud uses these sources during deployment build/restore

### File System I/O

**Artifact Upload** (`add-artifact.ts`):

- Reads `.cloudsource` zip from `filePath` input
- Uses JSZip library to manipulate zip contents in memory
- Removes excluded paths to reduce upload size

**Git Operations** (`utils/helpers.ts`):

- Validates `.git` directory exists in workspace
- Used to ensure repository context for deployments

## Umbraco Cloud Deployment Context

### Environment Flow

```
Development → Staging → Production
```

- Code/content changes deployed from dev → staging → production
- Each environment has alias (e.g., `dev`, `staging`, `prod`) for API references
- Deployments are environment-to-environment operations

### Artifact Types

- **`.cloudsource`**: ZIP file containing code/config changes (C# projects,
  config files, custom code)
- Standard Umbraco artifact format for CI/CD

### Deployment States

- `Pending` - Queued, waiting to start
- `InProgress` - Currently deploying
- `Completed` - Successfully finished
- `Failed` - Deployment error (check status messages for reason)

### Blocking Conditions

- **"Updating Marker"**: Site is locked during Umbraco version upgrades;
  deployment cannot proceed until upgrade completes
  - Detected in polling: Check `deploymentStatusMessages` for "updating" keyword
  - Action detects this and fails with helpful message instead of timing out

### Schema Flexibility

Umbraco API sometimes returns `deploymentId` vs `id`, `deploymentState` vs
`state` depending on version

- Action supports both via flexible `DeploymentResponse` interface
- Graceful handling of API changes without action redeployment

## Troubleshooting & Debugging Guide

### Common Patterns to Check

**Deployment Won't Start**:

1. Verify `artifactId` exists (check `add-artifact` action output)
2. Check `targetEnvironmentAlias` spelling (case-sensitive after first attempt)
3. Confirm API key has deploy permissions in Umbraco Cloud

**Polling Timeout (900s)**:

1. Check deployment state in Umbraco Cloud UI (may be stuck in `InProgress`)
2. Look for "updating marker" error in polling logs
3. Verify network connectivity during deployment

**Artifact Upload Fails**:

1. Check `.cloudsource` file size (large files may timeout)
2. Verify `excluded-paths` removes unnecessary folders (`.git/`,
   `node_modules/`)
3. Check NuGet.config modifications if custom sources provided

**API Authentication Errors**:

1. Verify API key is set correctly in GitHub Secrets
2. Check project ID matches Umbraco Cloud portal
3. Ensure API key has `projects.read` and `deployments.write` scopes

### Enable Debug Logging

- Run action with `--debug` flag: `ACTIONS_STEP_DEBUG=true`
- Emits `core.debug()` logs showing: API calls, retries, polling details
- Visible in GitHub Actions workflow logs

## Quick Reference Commands

```bash
# Development
npm test                    # Run Jest tests with coverage
npm run lint               # Check ESLint rules
npm run format:check       # Validate code formatting
npm run format:write       # Apply Prettier auto-fixes
npm run package            # Build distribution bundle
npm run package:watch      # Watch mode during development
npm run all                # Run all checks + build (pre-commit checklist)
npm run local-action       # Test action locally with .env file
npm run coverage           # Generate coverage badge

# Useful for Debugging
npm test -- --testNamePattern="keyword"  # Run specific test
npm test -- --verbose                    # Detailed test output
npm test -- --coverage                   # Coverage report
npm run lint -- --fix                    # Auto-fix linting issues
```

## Adding New Features

### Adding a New Action

1. **Create handler** in `src/actions/new-action.ts`:

   ```typescript
   export async function handleNewAction(
     api: UmbracoCloudAPI,
     inputs: ActionInputs
   ): Promise<ActionOutputs> {
     validateRequiredInputs(inputs, ['requiredField1', 'requiredField2'])
     // Implementation
     core.setOutput('result', value)
     return { result: value }
   }
   ```

2. **Add input to `action.yml`**:

   ```yaml
   new-action-input:
     description: 'Description here'
     required: true
   ```

3. **Add to ActionInputs type** in `src/types/index.ts`:

   ```typescript
   export interface ActionInputs {
     // existing fields...
     newActionInput?: string
   }
   ```

4. **Parse input** in `src/main.ts` `getActionInputs()`:

   ```typescript
   newActionInput: core.getInput('new-action-input'),
   ```

5. **Add route** in `src/main.ts` `run()` function:

   ```typescript
   case 'new-action':
     outputs = await handleNewAction(api, inputs)
     break
   ```

6. **Add tests** in `__tests__/new-action.test.ts`:

   - Test input validation
   - Test API interactions (mocked)
   - Test output structure

7. **Run pre-commit checklist**: `npm run all`

### Adding a New Utility

1. Create file in `src/utils/` with exported function(s)
2. Add comprehensive JSDoc comments
3. Add tests in `__tests__/utils/` matching utility name
4. Import in action handlers that use it
5. Example: `export function validateInput(value: string): boolean { ... }`

### Testing Best Practices

- Mock `@actions/core` by setting `process.env.INPUT_*` variables
- Mock API responses using `__fixtures__/` canned data
- Test error paths and edge cases
- Use descriptive test names:
  `describe('featureName', () => { test('should handle X when Y', ...) })`
- Maintain >80% coverage for new code

---

**To make productive changes**:

1. Start with the action/feature in `src/actions/` or `src/utils/`
2. Add types to `src/types/index.ts`
3. Add tests to `__tests__/` before or alongside implementation
4. Run `npm run all` to validate (format, lint, test, build)
5. Commit with meaningful message referencing the action/feature changed
