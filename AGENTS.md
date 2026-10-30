# Rules for agents working on Review Desk

## Product
- The panel helps a person decide on a PR an agent wrote. Every screen says what the reviewer needs to know and what to do next.
- One primary button per screen. A status is never styled as a button.
- Use plain names people recognize ("Medal name", not "medal label"). Show visuals before text; add text only for what a visual can't carry.
- Sample content stays generic. Never use code, names or data from an employer's repos.

## Code
- The webview only renders. GitHub calls and state live in the extension host; `src/controller.ts` must not import `vscode`.
- Types the host and webview share go in `src/protocol.ts`.
- Colors come from VS Code theme variables in `webview/styles.css`; no hard-coded colors outside the fallbacks there.
- New logic gets a test in `test/`. `npm run typecheck`, `npm test` and `npm run build` must pass before a PR.
- Never log or display a GitHub token.
