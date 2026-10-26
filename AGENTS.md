# Ghost repository conventions

## Project and repository

- This is the `dsh-ghost` DSH plugin; display name: DSH / DeepSeek Harness Agent-Ghost.
- The user requested a public GitHub repository named `dsh-deepseek-harness-agent-ghost` under `fantasysummer01-bit` and asked that subsequent updates be published to the same repository.
- Once configured, use the existing `origin` for future updates. Do not create replacement repositories or change the remote without the user's request.
- For authorized development updates: run the relevant tests, update CHANGELOG/version when appropriate, commit and push the completed change to this same repository. Report failures and pending publication accurately. Do not force-push.

## Safety and compatibility

- Keep Ghost state independent of DSH and model providers. Never describe state continuity as proof of subjective consciousness.
- Capture is off by default. Do not import chat history, change user credentials/configuration, or enable capture without an explicit user action.
- Never commit runtime databases, memory exports, profile backups, credentials, environment files or logs. Check staged files before every push.
- Follow the user's instruction to preserve active DSH tasks. Do not terminate or restart DSH while other tasks are active without renewed authorization.
- Preserve the distinction between original user text, model output, inferred information and explicitly approved state changes.
- Public source availability does not authorize a license change; preserve `UNLICENSED` unless the user chooses a license.

## Validation and release

- `npm run check` and `npm test` cover the portable baseline. With no `DSH_SDK_ROOT`, two real SDK/HTTP tests are explicitly skipped; do not report them as passed.
- `scripts/Test-Desktop.ps1` runs the full local SDK suite using Desktop's bundled Node. It must not stop the interactive application or use production credentials.
- Keep real renderer validation, isolated SDK/HTTP tests and preview fixtures clearly distinguished in documentation.
- Build packages with `node scripts/pack.mjs`; release only the plugin package, never the entire `artifacts/` folder.
