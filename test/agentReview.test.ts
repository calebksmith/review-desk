import { describe, expect, it } from 'vitest';
import { findingsFor, findingsPath, parseFindings, reviewPrompt } from '../src/agentReview';
import { SampleSource } from '../src/sample';

let n = 0;
const id = () => `x${++n}`;

describe('review with agent', () => {
  it('names a findings file per PR, and reads the PR back from it', () => {
    expect(findingsPath('acme/storefront', 102)).toBe('.review-desk/acme-storefront-102.json');
    expect(findingsFor('/repo/.review-desk/acme-storefront-102.json')).toEqual({ repo: 'acme/storefront', number: 102 });
    expect(findingsFor('/repo/.review-desk/notes.txt')).toBeNull();
  });

  it('asks for an adversarial review that skips what Codex already flagged', async () => {
    const pr = await new SampleSource('team').getPr('acme/storefront', 102, null);
    const prompt = reviewPrompt(pr, '/repo/.review-desk/acme-storefront-102.json');
    expect(prompt).toContain('Don’t change any code.');
    expect(prompt).toContain('- src/server/routes/login.ts:2 P1 Failed logins aren’t rate-limited');
    expect(prompt).toContain('write your findings as JSON to /repo/.review-desk/acme-storefront-102.json');
    expect(reviewPrompt(pr, null)).toContain('reply with your findings as JSON');
  });

  it('turns findings into agent drafts, dropping anything not on this PR’s files', async () => {
    const pr = await new SampleSource('team').getPr('acme/storefront', 102, null);
    const drafts = parseFindings([
      { path: 'src/server/routes/login.ts', line: 3, severity: 1, title: 'Session fixation', body: 'Rotate the session id after login.' },
      { path: 'src/elsewhere.ts', line: 1, severity: 0, title: 'Not in this PR' },
      { path: 'src/server/routes/login.ts', line: 'x', severity: 9, body: 'No line or severity' },
      'junk',
    ], pr, id);
    expect(drafts).toEqual([
      { id: 'x1', path: 'src/server/routes/login.ts', line: 3, side: 'RIGHT', body: '**P1** Session fixation\n\nRotate the session id after login.', from: 'agent', severity: 1 },
      { id: 'x2', path: 'src/server/routes/login.ts', line: null, side: 'RIGHT', body: 'No line or severity', from: 'agent', severity: null },
    ]);
    expect(parseFindings({ findings: [] }, pr, id)).toEqual([]);
    expect(parseFindings('nope', pr, id)).toEqual([]);
  });
});
