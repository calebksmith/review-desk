# Review Desk

A VS Code panel for reviewing pull requests that coding agents wrote. It puts what changed, what the checks found, and what's left for you in one place beside the code.

This is phase 1 of five: a read-only review panel on GitHub data. The agent steps from the [prototype](https://claude.ai/artifact/7obfCnVbNN1h7bRwmHMvpn) (rule-by-rule agent review, fix rounds, rule updates) come in later phases.

## What it does today

- **Review queue:** open and recently merged PRs, filtered by Needs you, Approved and Merged, sorted by what needs you first.
- **Dependabot updates in one click:** when Dependabot PRs have no conflicts and every check passed, **Merge N Dependabot updates** in the queue approves and merges them one at a time. Each is re-checked before its turn, since merging one can make the next conflict. Any that GitHub refuses, for example because the repo needs another approval, are skipped with GitHub's reason. Ones with failing checks stay in the queue for you to open.
- **Checks:** every check run and commit status (Vercel, for one) on the latest commit, failures first, with a link to each log. A failed GitHub Actions job names the step that failed and shows the error lines from its log.
- **Review with agent:** in Files changed, hands your agent an adversarial review of the PR: what it says it does, what Codex already flagged (so it isn't repeated), and what automated review misses. When the repo is open in VS Code, the agent writes its findings to `.review-desk/` (added to the repo's local git excludes, never its `.gitignore`), and they appear as drafts marked **From your agent** at their lines, for you to keep, edit or delete before your review is sent.
- **Fix with agent:** on any failing check, hands the failure to your AI agent as a ready prompt: the PR, the branch, the failed step, the error lines, and a plan that works in a separate worktree and asks before pushing. It opens a new Claude Code session if Claude Code is installed, otherwise VS Code's chat in agent mode, otherwise copies the prompt. The prompt is filled in, not sent.
- **Three pages, like GitHub's tabs:** **Overview** (the description in full, then the conversation, then a comment box), **Checks**, and **Files changed** (the diff at full height, with a Viewed checkbox for each file; Viewed state is GitHub's own). A PR opens on Overview the first time or when there are new comments, otherwise on Files changed. Keys 1, 2, 3 switch.
- **Conversation:** comments, reviews and comments on lines of code, oldest first like GitHub, with what's new since you last looked marked and one click to jump to it. A comment on a line of code opens that file, and an unresolved one has **Fix with agent**, so review findings (Codex's included) go to your agent like a failing check.
- **Comments:** post a comment from the Conversation tab (⌘Enter sends). Comments you post often, like `@codex review`, can be one-click buttons that show when that reviewer last replied; see `reviewDesk.commentActions`.
- **Close or ignore** a Dependabot PR from its Checks page: posts the Dependabot command you pick, such as ignoring the new major version, and Dependabot closes the PR.
- **New commits since you looked:** when the agent pushes after you opened a PR, a banner names the files and shows only what changed since.
- **Approve and Merge** from the header, beside one line that says what needs attention ("1 check failing +1") or that the PR is ready. Click that line for the merge checklist, in GitHub's order: approval, checks, conflicts, base branch, open threads, each with its fix. Merge is GitHub's **Squash and merge ▾**, with the method in its dropdown; it asks before it runs and takes you back to the queue. While a check fails it reads **Merge anyway** and names the failing checks. Conflicts block a merge and show a bar with **Fix with agent**.

## Try it

```sh
npm install
npm run build
```

Then press F5 in VS Code to open an Extension Development Host. Click the Review Desk icon in the left rail: the **Pull requests** list groups PRs by what they need, with a badge for how many need you, and marks the one open in the panel. Click one to open it in the full panel, or run **Review Desk: Open review queue** from the Command Palette. The list's title bar has Open review queue, Refresh and Switch repository; the Needs you group offers the one-click Dependabot merge when updates qualify. It signs in with your GitHub account in VS Code and reviews the open folder's GitHub repo. If several folders are open, it asks which repo to review and remembers your choice for that workspace. ## Everything in one view

By default Review Desk shows **everything that involves you** across GitHub: PRs you opened, were asked to review, reviewed, commented on or were mentioned in, plus recently merged ones. Add repos to `reviewDesk.repositories` to see every open PR in them too. With several repos in view, rows show their repo and a repo filter appears, and the sidebar groups PRs by repo (repos with the most of your turn first; repos with no PRs left out). To look at one repo, click the scope at the top of the queue or the repo icon in the sidebar, or run **Review Desk: Choose what to review**, and pick an open folder's repo or type any `owner/name`.

**Review Desk: Open with sample data** works without GitHub, and **Open with team sample data** shows a team: several developers, an agent and Dependabot, one approval required to merge, and two stacks of PRs. To see the UI in a browser instead, run `npm run preview` and open `.preview/index.html` (add `?theme=dark` for dark, `?sample=team` for the team).

To install it as a normal extension, run `npm run package` and install the `.vsix` with **Extensions: Install from VSIX…**.

## Reviewing

- **Status card** at the top of Overview, and in the header's status popover: what the PR needs and whose turn it is, then Checks, Findings, Comments and Approvals as bars of one piece per item (a lock marks parts that gate merging). Click one for its details: checks grouped failing, running, skipped and passed with Required marks, durations and Fix with agent; findings by severity; unresolved comments; reviewers. Conflicts, an out-of-date branch or a stacked PR below show underneath with their fix. A ready PR shows one line. Dependabot PRs show their compatibility score.
- **Required checks**: a failing required check blocks merging; failing optional checks allow Merge anyway.
- **Finish your review** from the header: Approve is one click; its ▾ opens a summary and GitHub's three verdicts (Comment, Approve, Request changes). Comments you've held back go with it ("Submit review · 3"). Approving with open P0/P1 findings asks first.
- **Comment on lines** in Files changed: hover a line for **+** (shift-click another for a range), then **Add to review** or **Comment now**. Held-back comments show at their lines as **Pending**.
- **Findings** (threads marked P0–P3, like Codex's) show at their lines with **Fix it**, **Ask the author** (a held-back reply), **Not an issue** (a held-back reply that resolves the thread when sent) and **Reply**. **]** and **[** step through open findings, most severe first.
- **Re-review**: a PR you requested changes on comes back to Your turn when the author pushes or asks again, with a "since your review" diff. Its conversation opens on **Mine**, and each thread you started says whether it was resolved, replied to, or is waiting.
- **Conversation filters** on Overview, like GitHub's: All, Unresolved, Mine. The PR's rail shows its reviewers and their state, labels, milestone and Linear issue.
- **Conflicts**: on a teammate's PR, **Ask them to resolve** fills in a comment for you to send (you can still approve the code); on Dependabot's, **Ask Dependabot to rebase**; on yours or an agent's, **Fix with agent**.
- **Keys**: c comments on the line under the pointer, r replies to the current finding, ] and [ move between findings, ⌘⇧Enter finishes the review.

## Staying current

Review Desk refreshes on its own while VS Code has focus and Review Desk is on screen: the open PR every minute (every 30 seconds while checks run or a reviewer you asked hasn't replied), the queue every 5 minutes, and anything older than a minute when you come back. A notice says what arrived ("Codex left 2 findings", "dana pushed new commits", "checks passed", "1 more PR is your turn"), and "Updated 2m ago" shows how fresh it is. The sidebar and panel share one queue load. Refreshing pauses when less than a fifth of GitHub's hourly allowance (5,000 points per user) is left; a queue load costs about 17 points for one repo and 48 for everything involving you.

## Teams and stacked PRs

- **Your PRs, review requests and everyone else's.** PRs you opened have their own group, saying what's next ("Waiting on priya", "Changes requested", "Ready to merge"). Needs you holds other people's PRs that need your review, with **Review requested** where you were asked by name. Waiting on others holds PRs assigned to someone else.
- **Required approvals.** The merge checklist says who approved and who's still asked, and Merge waits for the approvals GitHub requires. You can't approve your own PR, so it goes straight to Merge.
- **Stacks.** A PR whose base is another open PR's branch is stacked on it. **Stacks** in the queue draws each stack as a merge tree, like a git graph: newest PRs on top, each above the PR it builds on, forks in their own lanes, all flowing into the base branch, with the bottom PR marked **Merges first**. A stacked PR's rail shows its whole stack, its header links the PR below, and Merge waits until that one has merged.
- **Why it's your turn now.** Within Your turn, release blockers (labels in `reviewDesk.blockerLabels`, or hotfix branches) and releases due within two days come first, then PRs others wait on (stacked on it, or saying "Depends on #123"), then PRs in a release (a milestone or a `release/` base branch), then the rest, longest waiting first. Each row says why: Release blocker, Nov 14 release · due tomorrow, Blocks 2, 1 P1 open, Waiting 2d, No Codex review yet. Linear keys (from a linear.app link, the branch name or the title) show beside the author.
- **What's your turn comes first.** **All** is split into **Your turn** (reviews asked of you by name first, then your own PRs that need you, then PRs nobody was assigned), **Waiting on others** (dimmed: changes requested, other reviewers, other people's approved PRs, which their authors merge) and **Merged**. The sidebar badge counts Your turn.

## Settings

| Setting | What it does |
| --- | --- |
| `reviewDesk.repository` | Review only this `owner/name`. Empty means everything that involves you. **Choose what to review** updates it when it's set |
| `reviewDesk.repositories` | Repos to always show in full in the everything view |
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
| `src/scope.ts` | What the queue covers: one repo, or everything involving you plus repos in full |
| `src/stacks.ts` | Which PRs are stacked on which, and in what order they merge |
| `src/sidebar.ts` | How the sidebar groups and counts PRs |
| `src/sample.ts`, `src/sample-team.ts` | Sample PRs for demos and tests: solo, and a team |
| `webview/` | The panel's UI, styled from the VS Code theme |

`npm test` runs the unit tests; `npm run typecheck` checks both halves.
