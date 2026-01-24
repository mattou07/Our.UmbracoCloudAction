# Our Umbraco Cloud Action

This aims to be a comprehensive package for deploying to Umbraco Cloud API CI/CD with full
deployment management capabilities. Based on the scripts from the
[documentation](https://docs.umbraco.com/umbraco-cloud/build-and-customize-your-solution/handle-deployments-and-environments/umbraco-cicd/umbracocloudapi).

The purpose is to have one centralised place to faciliate deployments without
needing to copy scripts across your various Cloud Projects with a high feature
set out of the box!

## Quick Start

Use the following full YAML snippet below to get started. Everyone builds
differently so pick and choose what you need from the snippet. However to
minimise issues try not to change the Build or Publish sections too much!

Comments have been added to help you pick and choose.

```yaml
name: Build and deploy to Umbraco Cloud Staging

# Tell Github to cancel an active build if a new commit is added
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}

# Only run this build if this branch is pushed too or if its manually triggered
on:
  push:
    branches: ['release/cloud-production']
  workflow_dispatch:

# Needed to generate PR's
env:
  GH_TOKEN: ${{ github.token }}

jobs:
  setup:
    name: Setup
    runs-on: ubuntu-latest
    outputs:
      artifact-prefix: ${{ steps.set-artifact-prefix.outputs.ARTIFACT_PREFIX }}
      dotnet-base-path: ${{ steps.get-base-path.outputs.PATH_TO_BASE }}
      cloudsource-artifact:
        ${{ steps.set-artifact-prefix.outputs.ARTIFACT_PREFIX }}.cloudsource-${{
        github.run_number }}
      # Remove semver if you remove git version steps
      semver: ${{ steps.gitversion.outputs.semVer }}
      commit-timestamp: ${{ steps.committimestamp.outputs.COMMIT_TIMESTAMP }}

    steps:
      # Don't remove
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

      #=============================================================
      # Optional: GitVersion can be tricky to get right its used to automate semver

      - name: Install GitVersion
        uses: gittools/actions/gitversion/setup@v3.1.1
        with:
          versionSpec: '5.x'

      - name: Determine Version
        id: gitversion
        uses: gittools/actions/gitversion/execute@v3.1.1

      - name: Determine Commit Timestamp
        id: committimestamp
        shell: bash
        run: |
          timestamp=$(git log -1 --format=%cd --date=format:%Y%m%dh%H%M%S)
          echo "COMMIT_TIMESTAMP=$timestamp" >> $GITHUB_OUTPUT

      #=============================================================

      # Don't remove this is used to determine the .NET project path from the .umbraco file
      - name: Get DotNet Base Project Path
        id: get-base-path
        shell: bash
        run: |
          pathToBase=$(grep -oP 'base = "\K[^"]+' ${{ github.Workspace }}/.umbraco)
          echo "PATH_TO_BASE=$pathToBase" >> $GITHUB_OUTPUT

  build-fe:
    # Update where necessary this is very dependant on how your Front End build is configured

    name: Build and test front end
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node.js environment
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'npm'
          cache-dependency-path: '${{vars.PATH_TO_FRONTEND}}/package-lock.json'

      - name: Install dependencies
        working-directory: ./${{vars.PATH_TO_FRONTEND}}
        run: npm ci

      - name: Run WebPack
        working-directory: ./${{vars.PATH_TO_FRONTEND}}
        run: npm run build:cloud

      - name: Zip artifact for deployment
        working-directory: ${{needs.setup.outputs.dotnet-base-path}}
        shell: bash
        run: |
          mkdir output
          cp -r ./wwwroot ./output
          cp -r ./Webpack ./output
          cd output
          zip ./frontend.zip ./ -r

      #This is used in the backend build process to merge compiled frontend and backend code together
      - name: Create artifact
        uses: actions/upload-artifact@v4
        with:
          name:
            ${{ needs.setup.outputs.artifact-prefix }}.frontend-${{
            github.run_number }}
          path: |
            ${{needs.setup.outputs.dotnet-base-path}}/output/frontend.zip
          retention-days: 5

  build-be:
    name: Build and test back end
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      # Used for Github private nuget feed access during the build process
      - name: Add GitHub Package Registry
        run: |
          dotnet nuget add source --username USERNAME --password ${{ secrets.GITHUB_TOKEN }} --store-password-in-clear-text --name github ${{vars.CRUMPLED_PACKAGE_FEED_URL}}

      - name: Cache NuGet
        id: nuget-packages
        uses: actions/cache@v4
        with:
          path: ~/.nuget/packages
          key:
            nuget-cache-${{ runner.os }}-nuget-${{ hashFiles('**/*.csproj*') }}
          restore-keys: |
            nuget-cache-${{ runner.os }}-nuget-

      - name: Setup .Net
        uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '9.0.x'

      - name: Install Dependencies
        run: dotnet restore ${{ needs.setup.outputs.dotnet-base-path }}

      - name: Build
        run:
          dotnet build ${{ needs.setup.outputs.dotnet-base-path }}
          --configuration Release --no-restore

      # Dependant on how you build your front end. This Action will wait for the Front end build to finish before continuing
      # Most cases the Front end build will finish before .NET build
      - name: Wait for Frontend
        uses: yogeshlonkar/wait-for-jobs@v0
        with:
          jobs: 'Build and test front end'

      - name: Download Frontend artifact
        uses: actions/download-artifact@v4
        with:
          name:
            ${{ needs.setup.outputs.artifact-prefix }}.frontend-${{
            github.run_number }}
          path: ${{ github.workspace }}/built_frontend

      # Combine front end files with Umbraco
      - name: Combine files
        shell: bash
        run: |
          unzip -o -d ${{ needs.setup.outputs.dotnet-base-path }} ${{ github.workspace }}/built_frontend/frontend.zip
          rm ${{ github.workspace }}/built_frontend/frontend.zip

      # Clean out node_modules folders since RCL's are more in use
      - name: Clear NPM Modules
        shell: bash
        run: find . -name "node_modules" -type d -prune -exec rm -rf '{}' +

      #Important to keep as is, to ensure the action has the correct structure when loading the zip
      - name: Zip solution for deployment
        working-directory: ${{ github.workspace }}/
        run: zip ${{ github.workspace }}/cloudsite.zip ./ -r

      - name: Upload Cloud Source Artifact
        id: upload-solution
        uses: actions/upload-artifact@v4
        with:
          name: final-website-cloudsource-${{ github.run_number }}
          path: ${{ github.workspace }}/cloudsite.zip
          retention-days: 1

  #Avoid changing this section too much
  publish:
    name: Publish to Umbraco Cloud
    needs: [setup, build-fe, build-be]
    runs-on: ubuntu-latest
    steps:
      - name: Download artifact
        uses: actions/download-artifact@v4
        with:
          name: final-website-cloudsource-${{ github.run_number }}

      # This step will modify and upload the cloudsource zip to Umbraco Cloud
      - name: Upload Deployment Artifact
        id: upload-artifact
        uses: mattou07/Our.UmbracoCloudAction@main
        with:
          projectId: ${{ vars.UMBRACO_CLOUD_PROJECT_ID }}
          apiKey: ${{ secrets.UMBRACO_CLOUD_API_KEY }}
          filePath: './cloudsite.zip'
          description: 'Website deployment package'
          version: ${{ needs.setup.outputs.semver }}
          #==============================================================================
          # Declare a single private nuget feed here. Multiple private feeds are not supported - yet.
          nuget-source-name: 'github'
          nuget-source-url: ${{ vars.PACKAGE_FEED_URL }}
          #This can be left as is for Github Private feeds
          nuget-source-username: 'USERNAME'
          #Here we are using secrets set on Umbraco Cloud - Create a secret called PACKAGE_VIEW_TOKEN with a PAT token inside with read access to packages
          nuget-source-password: '%PACKAGE_VIEW_TOKEN%'
          #==============================================================================
          #Option to remove items in the zip file. This keeps the Umbraco Cloud repo clean. Typical things to remove are RCL bin or obj folders and unbuilt front end files such as sass.
          excluded-paths: '.git/,.github/,src/Client.RCLProject/bin,src/Client.RCLProject/obj,src/Client.FrontEnd'
          #Possible alias are: dev, stage or live
          targetEnvironmentAlias: 'dev'
          noBuildAndRestore: false
          skipVersionCheck: false
          timeoutSeconds: 3200
```

## Feature set

- **Built with Flexible Environments in mind**: Use this action utilse the v2
  API for separate deployment processes between your flexbible environment and
  the mainline (Stage and Prod).
- **Automatic PR creation**: Retrieve and apply changes from Umbraco Cloud
  between repos with automated pull requests
- **Private Nuget Feed Injection**: NuGet.Config is searched and your private
  feed is injected into the config.
- **Built-in Git ignore replacement**: Action will automatically look for
  .cloud_gitignore and replace all .gitignore files in the artifact sent to
  cloud

## Small features

- **Environment casing retry**: If the Environment Alias is accidentally defined
  with casing and fails. The action will retry with lowercase (Live => live)

## Error Handling

The action attempts to handle most common errors during a build process and
continue if possible:

- **API Errors**: Detailed error messages from Umbraco Cloud API
- **Timeout Handling**: Configurable timeouts for long-running operations and
  retries
- **Status Validation**: Validates deployment states and fails appropriately

## Inputs

| Input                    | Description                                                            | Required | Default                          |
| ------------------------ | ---------------------------------------------------------------------- | -------- | -------------------------------- |
| `projectId`              | The Umbraco Cloud project ID                                           | Yes      | -                                |
| `apiKey`                 | The Umbraco Cloud API key                                              | Yes      | -                                |
| `filePath`               | Path to the .cloudsource ZIP file to upload and deploy                 | Yes      | -                                |
| `targetEnvironmentAlias` | The target environment alias to deploy to (e.g., dev, staging, prod)   | Yes      | -                                |
| `commitMessage`          | Commit message for the deployment                                      | No       | `Deployment from GitHub Actions` |
| `noBuildAndRestore`      | Skip build and restore steps                                           | No       | `false`                          |
| `skipVersionCheck`       | Skip version check                                                     | No       | `false`                          |
| `timeoutSeconds`         | Timeout in seconds for deployment status checks                        | No       | `1200`                           |
| `description`            | Description for the artifact                                           | No       | -                                |
| `version`                | Version for the artifact                                               | No       | -                                |
| `baseUrl`                | Base URL for Umbraco Cloud API                                         | No       | `https://api.cloud.umbraco.com`  |
| `base-branch`            | Base branch for pull request creation                                  | No       | `main`                           |
| `upload-retries`         | Number of retry attempts for artifact upload                           | No       | `3`                              |
| `upload-retry-delay`     | Base delay in milliseconds between upload retries                      | No       | `10000`                          |
| `upload-timeout`         | Timeout in milliseconds for artifact upload                            | No       | `60000`                          |
| `nuget-source-name`      | Name for the NuGet package source                                      | No       | -                                |
| `nuget-source-url`       | URL for the NuGet package source                                       | No       | -                                |
| `nuget-source-username`  | Username for NuGet package source authentication                       | No       | -                                |
| `nuget-source-password`  | Password for NuGet package source authentication                       | No       | -                                |
| `excluded-paths`         | Comma-separated list of paths to exclude from artifact (e.g., ".git/") | No       | `.git/,.github/`                 |

## Outputs

| Output                           | Description                                                    |
| -------------------------------- | -------------------------------------------------------------- |
| `artifactId`                     | The artifact ID returned from the upload step                  |
| `deploymentId`                   | The deployment ID returned from the deployment step            |
| `deploymentState`                | The final deployment state (Completed, Failed, etc.)           |
| `deploymentStatus`               | The full deployment status response as JSON                    |
| `changes`                        | The changes (diff/patch) from the deployment                   |
| `latest-completed-deployment-id` | The latest completed deployment ID (when deployment fails)     |
| `pr-url`                         | The URL of the created pull request (when deployment fails)    |
| `pr-number`                      | The number of the created pull request (when deployment fails) |
| `nuget-source-status`            | Status of NuGet package source injection into artifact         |

## Contributing

Thank you for getting this far and considering contributing to the project!

To contribute:

1. Create an issue first! Depending on your circumstance your contribution might
   only be ideal for your usecase only.
2. Fork the repository
3. Create a feature branch
4. Make your changes
5. Test your changes by updating your
   `uses: (github-user)/Our.UmbracoCloudAction@feature-branch` for your cloud
   project
6. Submit a pull request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file
for details. Feel free to fork and use it for your usecases. Adding a credit
back to this repository is apperciated.

## Support

Please use [Umbraco Cloud support](https://umbraco.com/products/support/) if you
have issues with your site.

For only issues and questions about this Action, please use
[GitHub Issues](https://github.com/mattou07/Our.UmbracoCloudAction/issues) page.

This action has been tested with various Cloud Projects types and has been used
for Production sites. If possible avoid deploying to `live` environments
directly to avoid outages, unless you are on starter as there is no other
option.

Made with :heart: & with help from Github Copilot :robot: at
[Crumpled Dog](https://www.crumpled-dog.com/) :dog:
