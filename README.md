# Review Desk

A VS Code panel for reviewing pull requests that coding agents wrote. It puts what changed, what the checks found, and what's left for you in one place beside the code.

This is phase 1 of five: a read-only review panel on GitHub data. The agent steps from the [prototype](https://claude.ai/artifact/7obfCnVbNN1h7bRwmHMvpn) (rule-by-rule agent review, fix rounds, rule updates) come in later phases.

## What it does today

- **Review queue:** open and recently merged PRs, filtered by Needs you, Approved and Merged, sorted by what needs you first.
- **Dependabot updates in one click:** when Dependabot PRs have no conflicts and every check passed, **Merge N Dependabot updates** in the queue approves and merges them one at a time. Each is re-checked before its turn, since merging one can make the next conflict. Any that GitHub refuses, for example because the repo needs another approval, are skipped with GitHub's reason. Ones with failing checks stay in the queue for you to open.
- **Checks:** every check run and commit status (Vercel, for one) on the latest commit, failures first, with a link to each log. A failed GitHub Actions job names the step that failed and shows the error lines from its log.
- **Fix with agent:** on any failing check, hands the failure to your AI agent as a ready prompt: the PR, the branch, the failed step, the error lines, and a plan that works in a separate worktree and asks before pushing. It opens a new Claude Code session if Claude Code is installed, otherwise VS Code's chat in agent mode, otherwise copies the prompt. The prompt is filled in, not sent.
- **Your review:** the PR's description and conversation above its changed files, with a Viewed checkbox for each file, and the diff. Viewed state is GitHub's own, so it matches github.com.
- **Description and conversation:** the start of the description, formatted as on GitHub, with **Show full description** for the rest. The Conversation tab lists comments, reviews and comments on lines of code, newest first, marking what's new since you last looked. A comment on a line of code opens that file, and an unresolved one has **Fix with agent**, so review findings (Codex's included) go to your agent like a failing check.
- **Comments:** post a comment from the Conversation tab (⌘Enter sends). Comments you post often, like `@codex review`, can be one-click buttons that show when that reviewer last replied; see `reviewDesk.commentActions`.
- **Close or ignore** a Dependabot PR from its Checks page: posts the Dependabot command you pick, such as ignoring the new major version, and Dependabot closes the PR.
- **New commits since you looked:** when the agent pushes after you opened a PR, a banner names the files and shows only what changed since.
- **Approve and Merge** from the header. Merge asks before it runs, uses the repo's allowed merge method, and takes you back to the queue when it's done. While a check fails, the button reads **Merge anyway** and asks first, naming the failing checks. Conflicts block a merge.

## Try it

```sh
npm install
npm run build
```

Then press F5 in VS Code to open an Extension Development Host. Click the Review Desk icon in the left rail: the **Pull requests** list groups PRs by what they need, with a badge for how many need you. Click one to open it in the full panel, or run **Review Desk: Open review queue** from the Command Palette. It signs in with your GitHub account in VS Code and reviews the open folder's GitHub repo. If several folders are open, it asks which repo to review and remembers your choice for that workspace. To review a different one, run **Review Desk: Switch repository**: pick an open folder's repo or type any `owner/name`.

**Review Desk: Open with sample data** works without GitHub. To see the UI in a browser instead, run `npm run preview` and open `.preview/index.html` (add `?theme=dark` for dark).

To install it as a normal extension, run `npm run package` and install the `.vsix` with **Extensions: Install from VSIX…**.

## Settings

| Setting | What it does |
| --- | --- |
| `reviewDesk.repository` | Always review this `owner/name`. **Switch repository** updates it when it's set |
| `reviewDesk.label` | Only show PRs with this label, such as `review-desk` |
| `reviewDesk.commentActions` | One-click comments in the Conversation tab, such as `[{ "label": "Ask Codex to review", "comment": "@codex review", "reviewer": "chatgpt-codex-connector" }]` |
| `reviewDesk.agent` | Where **Fix with agent** sends a failure: `auto` (default), `claudeCode`, `chat` or `clipboard` |

## How it's built

The extension host talks to GitHub; the webview only renders. `src/controller.ts` holds the review state with no VS Code imports, so the same code runs in the extension, the tests and the browser preview.

| Path | What it is |
| --- | --- |
| `src/extension.ts` | Commands, GitHub sign-in, the webview panel |
| `src/github.ts` | GitHub REST and GraphQL calls |
| `src/controller.ts` | Review state and the messages the webview sends |
| `src/agent.ts` | The prompt **Fix with agent** gives your AI agent |
| `src/dependabot.ts` | The Dependabot commands behind **Close or ignore** |
| `src/conversation.ts` | A PR's comments, reviews and line threads as one timeline |
| `src/logs.ts` | The error lines from a failed GitHub Actions log |
| `src/repos.ts` | Which repo to review: the setting, your last pick, or the folders that are open |
| `src/protocol.ts` | Types shared by the host and the webview |
| `src/sidebar.ts` | How the sidebar groups and counts PRs |
| `src/sample.ts` | Sample PRs for demos and tests |
| `webview/` | The panel's UI, styled from the VS Code theme |

`npm test` runs the unit tests; `npm run typecheck` checks both halves.
