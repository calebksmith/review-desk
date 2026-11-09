import type { DiffLine } from './protocol';

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Turns a GitHub file patch into display lines. Unchanged lines that the patch
 * leaves out become one 'gap' row between hunks, so the reader knows code was skipped.
 */
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let seenHunk = false;
  for (const raw of patch.split('\n')) {
    const h = HUNK.exec(raw);
    if (h) {
      const oldStart = Number(h[1]);
      const newStart = Number(h[3]);
      const hidden = seenHunk ? newStart - newNo : newStart - 1;
      if (hidden > 0) out.push({ kind: 'gap', hidden });
      oldNo = oldStart;
      newNo = newStart;
      seenHunk = true;
      continue;
    }
    if (!seenHunk || raw.startsWith('\\')) continue;
    const mark = raw[0];
    const text = raw.slice(1);
    if (mark === '+') out.push({ kind: 'add', oldNo: null, newNo: newNo++, text });
    else if (mark === '-') out.push({ kind: 'del', oldNo: oldNo++, newNo: null, text });
    else if (mark === ' ' || raw === '') out.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text });
  }
  // A trailing empty line from the final newline is not part of the file.
  const last = out.at(-1);
  if (last && last.kind === 'ctx' && last.text === '' ) out.pop();
  return out;
}
