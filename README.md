# Our Umbraco Cloud Action

:warning: This action is in Testing phase and not ready for Production websites. :warning:


This aims to be a comprehensive GitHub Action for deploying to Umbraco Cloud with full deployment management capabilities. Based on the [documentation](https://docs.umbraco.com/umbraco-cloud/build-and-customize-your-solution/handle-deployments-and-environments/umbraco-cicd/umbracocloudapi).

This action is currently in testing phase with bugs being worked out as I go.

## Feature set

- **Upload Artifacts**: Upload deployment artifacts to Umbraco Cloud
- **Start Deployments**: Initiate deployments to any Umbraco Cloud environments
- **Monitor Deployment Status**: Monitor the logs of the deployment process in your workflow
- **Automatic PR creation**: Retrieve and apply changes between environments with pull requests
- **Built in Git ignore replacement**: Action will automatically look for .cloud_gitignore and replace all .gitignore files in the artifact sent to cloud


## Small features
- **Environment casing retry**: If the Environment Alias is accidentally defined with casing and fails. The action will retry with lowercase (Live => live)

## Error Handling

The action provides comprehensive error handling:

- **API Errors**: Detailed error messages from Umbraco Cloud API
- **Timeout Handling**: Configurable timeouts for long-running operations
- **File Validation**: Checks for file existence before upload
- **Status Validation**: Validates deployment states and fails appropriately

## Inputs

| Input                    | Description                                                                 | Required | Default                          |
|--------------------------|-----------------------------------------------------------------------------|----------|-----------------------------------|
| `projectId`              | The Umbraco Cloud project ID                                                | Yes      | -                                 |
| `apiKey`                 | The Umbraco Cloud API key                                                   | Yes      | -                                 |
| `action`                 | The action to perform (`start-deployment`, `check-status`, `add-artifact`, `get-changes`, `get-latest-changes`, `apply-patch`) | Yes      | `start-deployment`                |
| `artifactId`             | The artifact ID for deployment (required for `start-deployment`)            | No       | -                                 |
| `targetEnvironmentAlias` | The target environment alias (required for several actions)                 | No       | -                                 |
| `commitMessage`          | Custom commit message for the deployment                                    | No       | `Deployment from GitHub Actions`  |
| `noBuildAndRestore`      | Skip build and restore steps                                                | No       | `false`                           |
| `skipVersionCheck`       | Skip version check                                                          | No       | `false`                           |
| `deploymentId`           | The deployment ID (required for some actions)                               | No       | -                                 |
| `timeoutSeconds`         | Timeout in seconds for status checks                                        | No       | `1200`                            |
| `filePath`               | Path to the file to upload as artifact (required for `add-artifact`)        | Yes/No   | -                                 |
| `description`            | Description for the artifact                                                | No       | -                                 |
| `version`                | Version for the artifact                                                    | No       | -                                 |
| `baseUrl`                | Base URL for Umbraco Cloud API                                              | No       | `https://api.cloud.umbraco.com`   |
| `base-branch`            | Base branch for pull request creation (defaults to main)                    | No       | `*main`                            |
| `upload-retries`         | Number of retry attempts for artifact upload                                | No       | `3`                               |
| `upload-retry-delay`     | Base delay in milliseconds between upload retries                           | No       | `10000`                           |
| `upload-timeout`         | Timeout in milliseconds for artifact upload                                 | No       | `60000`                           |
| `nuget-source-name`      | Name for the NuGet package source (optional for `add-artifact`)             | No       | -                                 |
| `nuget-source-url`       | URL for the NuGet package source (optional for `add-artifact`)              | No       | -                                 |
| `nuget-source-username`  | Username for NuGet package source authentication (optional for `add-artifact`)| No      | -                                 |
| `nuget-source-password`  | Password for NuGet package source authentication (optional for `add-artifact`)| No      | -                                 |

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

### 1. Upload Artifact (`add-artifact`)

Uploads a file as a deployment artifact to Umbraco Cloud.

```yaml
    - name: Download artifact
      uses: actions/download-artifact@v4
      with:
        name: your-cloud-artifact-${{ github.run_number }}

    - name: Upload Deployment Artifact
      id: upload-artifact
      uses: mattou07/Our.UmbracoCloudAction@main
      with:
        projectId: ${{ secrets.UMBRACO_CLOUD_PROJECT_ID }}
        apiKey: ${{ secrets.UMBRACO_CLOUD_API_KEY }}
        action: add-artifact
        filePath: './cloudsite.zip' #Expects a zip of the full solution
        description: 'Website deployment package' #Description for this artifact
        version: '1.0.0'
        nuget-source-name: 'github' #Name of the nuget source for the NuGet.config fule
        nuget-source-url: ${{ vars.CRUMPLED_PACKAGE_FEED_URL }} #Url for private nuget feed
        nuget-source-username: ${{ secrets.NUGET_USERNAME_GITHUB }} #Credentials
        nuget-source-password: '%Cloud_Secret_PACKAGE_VIEW_TOKEN%' # Use '%YourSecretInCloudName% to reference a secret in Umbraco Cloud to avoid having passwords in artifacts
```

### 2. Start Deployment (`start-deployment`)

Initiates a new deployment to Umbraco Cloud until completion or timeout.

```yaml
    - name: Start Umbraco Cloud Deployment
      id: start-deployment
      uses: mattou07/Our.UmbracoCloudAction@main
      with:
        projectId: ${{ secrets.UMBRACO_CLOUD_PROJECT_ID }}
        apiKey: ${{ secrets.UMBRACO_CLOUD_API_KEY }}
        action: start-deployment
        artifactId: ${{ steps.upload-artifact.outputs.artifactId }} #The artifact Id from step 1. Ensure the id step one matches here
        noBuildAndRestore: false #Speeds up the deployment by telling Umbraco to not rebuild everything
        skipVersionCheck: false
        targetEnvironmentAlias: 'development' #Or live if you are feeling brave or have starter
```

### 3. Check Deployment Status (`check-status`)

Obtains the status of the deployment.

```yaml
    - name: Check Deployment Status
      uses: mattou07/Our.UmbracoCloudAction@refactor-into-modules
      with:
        projectId: ${{ secrets.UMBRACO_CLOUD_PROJECT_ID }}
        apiKey: ${{ secrets.UMBRACO_CLOUD_API_KEY }}
        action: check-status
        deploymentId: ${{ steps.start-deployment.outputs.deploymentId }}
        timeoutSeconds: 1800
        targetEnvironmentAlias: 'live'
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

name: Build and deploy to Umbraco Cloud

on:
  push:
    branches: [ main ]
  workflow_dispatch:
    
env:
  PATH_TO_FRONTEND: ${{ vars.PATH_TO_FRONTEND }}
  PACKAGE_FEED_URL: ${{ vars.PACKAGE_FEED_URL }}
      
jobs:
  setup:
    name: Setup
    runs-on: ubuntu-latest
    outputs:
      artifact-prefix: ${{ steps.set-artifact-prefix.outputs.ARTIFACT_PREFIX }}
      dotnet-base-path: ${{ steps.get-base-path.outputs.PATH_TO_BASE }}
      cloudsource-artifact: ${{ steps.set-artifact-prefix.outputs.ARTIFACT_PREFIX }}.cloudsource-${{ github.run_number }}

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Set Artifact Key Prefix
        id: set-artifact-prefix
        env:
          REPO_NAME: ${{ github.event.repository.name }}
        run: |
          typeset -l output
          output=${REPO_NAME// /_}
          echo "$output"
          echo "ARTIFACT_PREFIX=$output" >> "$GITHUB_OUTPUT"

      - name: Determine Commit Timestamp
        id: committimestamp
        shell: bash
        run: |
            timestamp=$(git log -1 --format=%cd --date=format:%Y%m%dh%H%M%S)
            echo "COMMIT_TIMESTAMP=$timestamp" >> $GITHUB_OUTPUT

      - name: Get DotNet Base Project Path
        id: get-base-path
        shell: bash
        run: |
          pathToBase=$(grep -oP 'base = "\K[^"]+' ${{ github.workspace }}/.umbraco)
          echo "PATH_TO_BASE=$pathToBase" >> $GITHUB_OUTPUT

  build-fe:
    name: Build front end
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node.js environment
        uses: actions/setup-node@v4
        with:
            node-version: 20.9.0
            cache: 'npm'
            cache-dependency-path: '${{env.PATH_TO_FRONTEND}}/package-lock.json'

      - name: Install dependencies
        working-directory: ./${{env.PATH_TO_FRONTEND}}
        run: npm ci

      - name: Run WebPack
        working-directory: ./${{env.PATH_TO_FRONTEND}}
        run: npm run build:prod

      - name: Zip artifact for deployment
        working-directory: ${{ needs.setup.outputs.dotnet-base-path }}
        shell: bash
        run: |
          mkdir output
          cp -r ./wwwroot ./output
          cp -r ./Webpack ./output
          cd output
          zip ./frontend.zip ./ -r

      - name: Create artifact
        uses: actions/upload-artifact@v4
        with:
          name: ${{ needs.setup.outputs.artifact-prefix }}.frontend-${{ github.run_number }}
          path: ${{ needs.setup.outputs.dotnet-base-path }}/output/frontend.zip
          retention-days: 5

  build-be:
    name: Build and test back end
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Add GitHub Package Registry
        run: dotnet nuget add source --username USERNAME --password ${{ secrets.GITHUB_TOKEN }} --store-password-in-clear-text --name github ${{env.PACKAGE_FEED_URL}}

      - name: Cache NuGet
        id: nuget-packages
        uses: actions/cache@v4
        with:
          path: ~/.nuget/packages
          key: nuget-cache-${{ runner.os }}-nuget-${{ hashFiles('**/*.csproj*') }}
          restore-keys: |
            nuget-cache-${{ runner.os }}-nuget-

      - name: Setup .Net
        uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '8.0.x'
                
      - name: Build
        run: dotnet build ${{ needs.setup.outputs.dotnet-base-path }} --configuration Release

      - name: Wait for Frontend
        uses: yogeshlonkar/wait-for-jobs@v0
        with:
          jobs: 'Build front end'

      - name: Download Website artifact
        uses: actions/download-artifact@v4
        with:
          name: ${{ needs.setup.outputs.artifact-prefix }}.frontend-${{ github.run_number }}
          path: ${{ github.workspace }}/built_frontend

      - name: Combine files
        shell: bash
        run: |
          unzip -o -d ${{ needs.setup.outputs.dotnet-base-path }} ${{ github.workspace }}/built_frontend/frontend.zip
          rm ${{ github.workspace }}/built_frontend/frontend.zip

      - name: Zip solution for deployment
        working-directory: ${{ github.workspace }}/
        run: zip ${{ github.workspace }}/cloudsite.zip ./ -r

      - name: Upload Cloud Source Artifact
        id: upload-solution
        uses: actions/upload-artifact@v4
        with:
          name: final-cloudsource-${{ github.run_number }}
          path: ${{ github.workspace }}/cloudsite.zip
          retention-days: 1

  publish:
    name: Publish to Umbraco Cloud
    needs: [setup,build-be]
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - name: Download artifact
        uses: actions/download-artifact@v4
        with:
          name: final-cloudsource-${{ github.run_number }}

      - name: Upload Deployment Artifact
        id: upload-artifact
        uses: mattou07/Our.UmbracoCloudAction@main
        with:
          projectId: ${{ secrets.UMBRACO_CLOUD_PROJECT_ID }}
          apiKey: ${{ secrets.UMBRACO_CLOUD_API_KEY }}
          action: add-artifact
          filePath: './cloudsite.zip'
          description: 'Website deployment package'
          version: '1.0.0'
          nuget-source-name: 'github'
          nuget-source-url: ${{ vars.CRUMPLED_PACKAGE_FEED_URL }}
          nuget-source-username: ${{ secrets.NUGET_USERNAME_GITHUB }}
          nuget-source-password: '%CRUMPLED_PACKAGE_VIEW_TOKEN%'

      # Optional debugging
      # - name: Debug artifactId output
      #   run: echo "artifactId is ${{ steps.upload-artifact.outputs.artifactId }}"

      # - name: Debug Cloud Source Artifact
      #   id: upload-solution-debug
      #   uses: actions/upload-artifact@v4
      #   with:
      #     name: final-cloudsource-debug-${{ github.run_number }}
      #     path: ${{ github.workspace }}/cloudsite.zip
      #     retention-days: 1

      - name: Start Umbraco Cloud Deployment
        id: start-deployment
        uses: mattou07/Our.UmbracoCloudAction@main
        with:
          projectId: ${{ secrets.UMBRACO_CLOUD_PROJECT_ID }}
          apiKey: ${{ secrets.UMBRACO_CLOUD_API_KEY }}
          action: start-deployment
          artifactId: ${{ steps.upload-artifact.outputs.artifactId }}
          noBuildAndRestore: false
          skipVersionCheck: false
          targetEnvironmentAlias: 'live' #Example is for a site on Starter. Change this otherwise!!

      - name: Check Deployment Status
        uses: mattou07/Our.UmbracoCloudAction@main
        with:
          projectId: ${{ secrets.UMBRACO_CLOUD_PROJECT_ID }}
          apiKey: ${{ secrets.UMBRACO_CLOUD_API_KEY }}
          action: check-status
          deploymentId: ${{ steps.start-deployment.outputs.deploymentId }}
          timeoutSeconds: 1800
          targetEnvironmentAlias: 'live' #Example is for a site on Starter. Change this otherwise!!
```

## Advanced Usage

### Conditional Deployments

```yaml
- name: Deploy to production (manual approval)
  if:
    github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'
  uses: mattou07/Our.UmbracoCloudAction@main
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
      environment: [development,staging]
  uses: mattou07/Our.UmbracoCloudAction@main
  with:
    projectId: ${{ secrets.UMBRACO_CLOUD_PROJECT_ID }}
    apiKey: ${{ secrets.UMBRACO_CLOUD_API_KEY }}
    action: start-deployment
    artifactId: ${{ steps.upload-artifact.outputs.artifactId }}
    targetEnvironmentAlias: ${{ matrix.environment }}
    commitMessage:
      'Deploy to ${{ matrix.environment }} - ${{ github.run_number }}'
```



## Development

This project is based on the Typescript template from [Github](https://github.com/actions/typescript-action). More details on how to use the template are in their README.

### Building

Install the dependencies
```bash
npm install
```

Build the bundle
```bash
npm run bundle
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

1. Create an issue first! Depending on your circumstance your contribution might only be ideal for your usecase only. 
2. Fork the repository
3. Create a feature branch
4. Make your changes
5. Add tests
6. Submit a pull request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details. Feel free to fork and use it for your usecases.

## Support

For issues and questions about this Action, please use the [GitHub Issues](https://github.com/mattou07/Our.UmbracoCloudAction/issues) page.

Use at your own risk, avoid deploying to `live` environments directly to avoid outages. Please use [Umbraco Cloud support](https://umbraco.com/products/support/) if you have issues with your site.
