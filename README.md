# Review Desk

A VS Code panel for reviewing pull requests that coding agents wrote. It puts what changed, what the checks found, and what's left for you in one place beside the code.

This is phase 1 of five: a read-only review panel on GitHub data. The agent steps from the [prototype](https://claude.ai/artifact/7obfCnVbNN1h7bRwmHMvpn) (rule-by-rule agent review, fix rounds, rule updates) come in later phases.

## What it does today

- **Review queue:** open and recently merged PRs, filtered by Needs you, Approved and Merged, sorted by what needs you first.
- **Checks:** every check run on the latest commit, failures first, with a link to each log.
- **Your review:** the PR's description, its changed files with a Viewed checkbox each, and the diff. Viewed state is GitHub's own, so it matches github.com.
- **New commits since you looked:** when the agent pushes after you opened a PR, a banner names the files and shows only what changed since.
- **Approve and Merge** from the header. Merge asks before it runs and uses the repo's allowed merge method.

## Try it

```sh
npm install
npm run build
```

Then press F5 in VS Code to open an Extension Development Host, and run **Review Desk: Open** from the Command Palette. It signs in with your GitHub account in VS Code and reviews the `origin` repo of the open folder.

**Review Desk: Open with sample data** works without GitHub. To see the UI in a browser instead, run `npm run preview` and open `.preview/index.html` (add `?theme=dark` for dark).

To install it as a normal extension, run `npm run package` and install the `.vsix` with **Extensions: Install from VSIX…**.

## Settings

| Setting | What it does |
| --- | --- |
| `reviewDesk.repository` | Review this `owner/name` instead of the open folder's remote |
| `reviewDesk.label` | Only show PRs with this label, such as `review-desk` |

## How it's built

The extension host talks to GitHub; the webview only renders. `src/controller.ts` holds the review state with no VS Code imports, so the same code runs in the extension, the tests and the browser preview.

| Path | What it is |
| --- | --- |
| `src/extension.ts` | Commands, GitHub sign-in, the webview panel |
| `src/github.ts` | GitHub REST and GraphQL calls |
| `src/controller.ts` | Review state and the messages the webview sends |
| `src/protocol.ts` | Types shared by the host and the webview |
| `src/sample.ts` | Sample PRs for demos and tests |
| `webview/` | The panel's UI, styled from the VS Code theme |

`npm test` runs the unit tests; `npm run typecheck` checks both halves.
