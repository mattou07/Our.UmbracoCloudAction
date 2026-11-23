# Our.UmbracoCloudAction

GitHub Action (TypeScript, ESM, Node 24) that deploys a zipped site to Umbraco
Cloud through the CI/CD Flow v2 API: upload artifact → start deployment → poll →
on failure, explain why and optionally open a fix PR with Cloud's git patch.

## Commands

| Task                             | Command                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| Install                          | `npm ci`                                                                                    |
| Tests + coverage (100% enforced) | `npm run ci-test`                                                                           |
| One test file                    | `npx cross-env NODE_OPTIONS=--experimental-vm-modules npx jest __tests__/path/file.test.ts` |
| Lint / format check              | `npm run lint` / `npm run format:check`                                                     |
| Format + rebuild `dist/`         | `npm run bundle`                                                                            |
| Run the action locally           | `npm run local-action`                                                                      |

`dist/` is committed and is what GitHub runs. After any change in `src/`, run
`npm run bundle` and commit `dist/` too, or the `check-dist` workflow fails.

## Layout

- `src/main.ts`: reads and validates inputs, runs the three steps.
- `src/actions/add-artifact.ts`: edits the zip in place (excluded paths,
  `.cloud_gitignore`, NuGet feed injection), requires a root `.umbraco`,
  uploads.
- `src/actions/start-deployment.ts`: starts the deployment; waits if another one
  is already running.
- `src/actions/check-status.ts`: polls, reports failures, decides on a fix PR.
- `src/api/umbraco-cloud-api.ts`: the only place that calls the Cloud API.
- `src/github/pull-request.ts`: applies Cloud's patch and opens the PR.
- `src/utils/version-fixes.ts`: validates package version fixes parsed from
  Cloud's downgrade message and edits `Version` attributes in project files.
- `src/utils/`: polling, API NDJSON log, NuGet.config XML, redaction, helpers.
- `__tests__/fixtures/umbraco-cloud-responses.ts`: Cloud responses used by
  tests.
- `action.yml`: inputs and outputs. Keep it, `README.md` and `.env.example` in
  step when an input changes.

## Running locally

1. `npm ci`
2. Copy `.env.example` to `.env` (gitignored) and fill it in. Inputs are
   `INPUT_<NAME>` with hyphens kept, e.g. `INPUT_EXCLUDED-PATHS`.
3. `npm run local-action` runs `src/main.ts` through `@github/local-action` with
   that `.env`. VS Code: the "Debug Action" launch config does the same.

Things that differ from a real runner:

- `local-action` exits 0 even when the action fails. Judge by `::error::` lines.
- On Node 25+, `@github/local-action` needs
  `NODE_OPTIONS=--no-experimental-strip-types` (the npm script sets it).
- With `INPUT_ENABLE-API-LOGGING=true`, create an `artifacts/` folder first or
  the local artifact stub crashes at the end. The log itself goes to the OS temp
  folder.
- The fix-PR step needs `GITHUB_REPOSITORY=owner/repo` and `INPUT_GITHUB-TOKEN`;
  without them it logs a warning and is skipped. With them it pushes a real
  branch and opens a real PR.

## Deploying to Umbraco Cloud from a local machine

This performs a real deployment. Use a project and environment meant for
testing.

1. In the Umbraco Cloud portal: Configuration → CI/CD Flow. Copy the project ID
   and create an API key.
2. Build a source zip of the site with a `.umbraco` file at its root. No
   `.git/`, no `bin/` or `obj/`, under 256 MB.
3. Set in `.env`:
   ```
   INPUT_PROJECTID=<project id>
   INPUT_APIKEY=<api key>
   INPUT_FILEPATH=./site.zip
   INPUT_TARGETENVIRONMENTALIAS=<environment alias>
   INPUT_ENABLE-API-LOGGING=false
   ```
   For a private NuGet feed also set `INPUT_NUGET-SOURCE-NAME`, `-URL`,
   `-USERNAME` and `-PASSWORD`. Use a `%SECRET_NAME%` reference to an Umbraco
   Cloud secret for the password, never a literal token.
4. Keep a copy of the zip: the action rewrites `INPUT_FILEPATH` in place.
5. `npm run local-action`

A deployment with no file changes completes in about a minute. Package versions
in the zip must not be lower than those running in Cloud, or Cloud rejects it;
the failure output lists the versions to raise.

## Rules for changes

- **Structure decides, text enriches.** Control flow uses HTTP status, the
  problem-details `type`, deployment state and `cloudRepositoryUpdated`. Cloud's
  message wording may change: text matching may only add detail and must fail
  safe (no PR, full details shown). Add a "wording changed" test for new
  text-based checks.
- **Coverage stays at 100%** (`jest.config.js` threshold). Remove unreachable
  code rather than adding `istanbul ignore`.
- **Tests are ESM.** Use `jest.unstable_mockModule(...)` then
  `await import(...)`; `jest.mock()` is a no-op here.
- **No real project data in the repo.** Fixtures, tests and docs must use
  placeholder project names, IDs, hosts and feeds. Never commit `.env`, site
  zips, API logs or anything captured from a real Cloud project.
- **Secrets:** call `core.setSecret` for new secret inputs; never log request
  headers; pass anything from Cloud through `redactSignedUrls` before it reaches
  a log, output or PR body.
- Don't commit or push unless asked.
