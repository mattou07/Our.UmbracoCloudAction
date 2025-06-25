# Umbraco Cloud Deployment Action

A comprehensive GitHub Action for deploying to Umbraco Cloud with full
deployment management capabilities.

## Features

- **Start Deployments**: Initiate deployments to Umbraco Cloud environments
- **Monitor Deployment Status**: Check deployment progress with timeout support
- **Upload Artifacts**: Upload deployment artifacts to Umbraco Cloud
- **Manage Changes**: Retrieve and apply changes between environments
- **Full API Coverage**: Complete implementation of Umbraco Cloud API v2

## Inputs

| Input                    | Description                            | Required | Default                          |
| ------------------------ | -------------------------------------- | -------- | -------------------------------- |
| `projectId`              | The Umbraco Cloud project ID           | Yes      | -                                |
| `apiKey`                 | The Umbraco Cloud API key              | Yes      | -                                |
| `action`                 | The action to perform                  | Yes      | `start-deployment`               |
| `artifactId`             | The artifact ID for deployment         | No\*     | -                                |
| `targetEnvironmentAlias` | The target environment alias           | No\*     | -                                |
| `commitMessage`          | Commit message for the deployment      | No       | `Deployment from GitHub Actions` |
| `noBuildAndRestore`      | Skip build and restore steps           | No       | `false`                          |
| `skipVersionCheck`       | Skip version check                     | No       | `false`                          |
| `deploymentId`           | The deployment ID                      | No\*     | -                                |
| `timeoutSeconds`         | Timeout in seconds for status checks   | No       | `1200`                           |
| `filePath`               | Path to the file to upload as artifact | No\*     | -                                |
| `description`            | Description for the artifact           | No       | -                                |
| `version`                | Version for the artifact               | No       | -                                |
| `changeId`               | The change ID                          | No\*     | -                                |
| `baseUrl`                | Base URL for Umbraco Cloud API         | No       | `https://api.cloud.umbraco.com`  |

\*Required for specific actions

## Outputs

| Output             | Description                                      |
| ------------------ | ------------------------------------------------ |
| `deploymentId`     | The deployment ID returned from start-deployment |
| `artifactId`       | The artifact ID returned from add-artifact       |
| `deploymentState`  | The current deployment state                     |
| `deploymentStatus` | The deployment status response                   |
| `changes`          | The changes returned from get-changes            |

## Actions

### 1. Start Deployment (`start-deployment`)

Initiates a new deployment to Umbraco Cloud.

```yaml
- name: Start Umbraco Cloud Deployment
  uses: your-org/umbraco-cloud-deployment-action@v1
  with:
    projectId: ${{ secrets.UMBRACO_CLOUD_PROJECT_ID }}
    apiKey: ${{ secrets.UMBRACO_CLOUD_API_KEY }}
    action: start-deployment
    artifactId: ${{ steps.upload-artifact.outputs.artifactId }}
    targetEnvironmentAlias: 'staging'
    commitMessage: 'Deploy from GitHub Actions - ${{ github.run_number }}'
    noBuildAndRestore: false
    skipVersionCheck: false
```

### 2. Check Deployment Status (`check-status`)

Monitors deployment progress until completion or timeout.

```yaml
- name: Check Deployment Status
  uses: your-org/umbraco-cloud-deployment-action@v1
  with:
    projectId: ${{ secrets.UMBRACO_CLOUD_PROJECT_ID }}
    apiKey: ${{ secrets.UMBRACO_CLOUD_API_KEY }}
    action: check-status
    deploymentId: ${{ steps.start-deployment.outputs.deploymentId }}
    timeoutSeconds: 1800
```

### 3. Upload Artifact (`add-artifact`)

Uploads a file as a deployment artifact to Umbraco Cloud.

```yaml
- name: Upload Deployment Artifact
  uses: your-org/umbraco-cloud-deployment-action@v1
  with:
    projectId: ${{ secrets.UMBRACO_CLOUD_PROJECT_ID }}
    apiKey: ${{ secrets.UMBRACO_CLOUD_API_KEY }}
    action: add-artifact
    filePath: './dist/website.zip'
    description: 'Website deployment package'
    version: '1.0.0'
```

### 4. Get Changes (`get-changes`)

Retrieves changes for a specific change ID.

```yaml
- name: Get Changes
  uses: your-org/umbraco-cloud-deployment-action@v1
  with:
    projectId: ${{ secrets.UMBRACO_CLOUD_PROJECT_ID }}
    apiKey: ${{ secrets.UMBRACO_CLOUD_API_KEY }}
    action: get-changes
    changeId: 'your-change-id'
```

### 5. Apply Patch (`apply-patch`)

Applies a patch to a target environment.

```yaml
- name: Apply Patch
  uses: your-org/umbraco-cloud-deployment-action@v1
  with:
    projectId: ${{ secrets.UMBRACO_CLOUD_PROJECT_ID }}
    apiKey: ${{ secrets.UMBRACO_CLOUD_API_KEY }}
    action: apply-patch
    changeId: 'your-change-id'
    targetEnvironmentAlias: 'production'
```

## Complete Workflow Example

Here's a complete workflow that demonstrates a typical deployment process:

```yaml
name: Deploy to Umbraco Cloud

on:
  push:
    branches: [main]
  workflow_dispatch:

env:
  UMBRACO_CLOUD_PROJECT_ID: ${{ secrets.UMBRACO_CLOUD_PROJECT_ID }}
  UMBRACO_CLOUD_API_KEY: ${{ secrets.UMBRACO_CLOUD_API_KEY }}

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Build project
        run: npm run build

      - name: Create deployment package
        run: |
          zip -r dist/website.zip dist/ -x "*.git*" "node_modules/*"

      - name: Upload artifact to Umbraco Cloud
        id: upload-artifact
        uses: your-org/umbraco-cloud-deployment-action@v1
        with:
          projectId: ${{ env.UMBRACO_CLOUD_PROJECT_ID }}
          apiKey: ${{ env.UMBRACO_CLOUD_API_KEY }}
          action: add-artifact
          filePath: './dist/website.zip'
          description:
            'Deployment from GitHub Actions - ${{ github.run_number }}'
          version: '${{ github.sha }}'

      - name: Start deployment to staging
        id: start-deployment
        uses: your-org/umbraco-cloud-deployment-action@v1
        with:
          projectId: ${{ env.UMBRACO_CLOUD_PROJECT_ID }}
          apiKey: ${{ env.UMBRACO_CLOUD_API_KEY }}
          action: start-deployment
          artifactId: ${{ steps.upload-artifact.outputs.artifactId }}
          targetEnvironmentAlias: 'staging'
          commitMessage: 'Deploy to staging - ${{ github.run_number }}'

      - name: Wait for deployment to complete
        uses: your-org/umbraco-cloud-deployment-action@v1
        with:
          projectId: ${{ env.UMBRACO_CLOUD_PROJECT_ID }}
          apiKey: ${{ env.UMBRACO_CLOUD_API_KEY }}
          action: check-status
          deploymentId: ${{ steps.start-deployment.outputs.deploymentId }}
          timeoutSeconds: 1800
```

## Advanced Usage

### Conditional Deployments

```yaml
- name: Deploy to production (manual approval)
  if:
    github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'
  uses: your-org/umbraco-cloud-deployment-action@v1
  with:
    projectId: ${{ secrets.UMBRACO_CLOUD_PROJECT_ID }}
    apiKey: ${{ secrets.UMBRACO_CLOUD_API_KEY }}
    action: start-deployment
    artifactId: ${{ steps.upload-artifact.outputs.artifactId }}
    targetEnvironmentAlias: 'production'
    commitMessage: 'Production deployment - ${{ github.run_number }}'
```

### Multi-Environment Deployment

```yaml
- name: Deploy to multiple environments
  strategy:
    matrix:
      environment: [staging, production]
  uses: your-org/umbraco-cloud-deployment-action@v1
  with:
    projectId: ${{ secrets.UMBRACO_CLOUD_PROJECT_ID }}
    apiKey: ${{ secrets.UMBRACO_CLOUD_API_KEY }}
    action: start-deployment
    artifactId: ${{ steps.upload-artifact.outputs.artifactId }}
    targetEnvironmentAlias: ${{ matrix.environment }}
    commitMessage:
      'Deploy to ${{ matrix.environment }} - ${{ github.run_number }}'
```

## Error Handling

The action provides comprehensive error handling:

- **API Errors**: Detailed error messages from Umbraco Cloud API
- **Timeout Handling**: Configurable timeouts for long-running operations
- **File Validation**: Checks for file existence before upload
- **Status Validation**: Validates deployment states and fails appropriately

## Development

### Building

```bash
npm install
npm run package
```

### Testing

```bash
npm test
```

### Local Development

```bash
npm run local-action
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file
for details.

## Support

For issues and questions, please use the
[GitHub Issues](https://github.com/your-org/umbraco-cloud-deployment-action/issues)
page.
