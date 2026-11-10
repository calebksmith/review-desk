// Finds why a GitHub Actions job failed, from its raw log.

const MAX_LINES = 12;
const MAX_WIDTH = 200;

/**
 * The lines that explain a failed job: the error lines from the step that failed, or its last lines
 * when none look like errors. Null when the log has no failure in it.
 */
export function logExcerpt(log: string): string[] | null {
  const lines = log.split(/\r?\n/).map(clean);
  // The runner ends a failed step with "##[error]Process completed with exit code N". Tools can
  // print their own ##[error] lines before it (tsc does, one per error), so look for that one first.
  let end = lines.findIndex((l) => /^##\[error\]Process completed with exit code/.test(l));
  if (end < 0) end = lines.findIndex((l) => l.startsWith('##[error]'));
  if (end < 0) return null;
  let start = end;
  while (start > 0 && !lines[start]!.startsWith('##[group]Run ')) start--;

  const body: string[] = [];
  let inHeader = start < end && lines[start]!.startsWith('##[group]');
  for (const line of lines.slice(start, end + 1)) {
    // Skip the step's header group: the command and its env, which the runner echoes.
    if (inHeader) { if (line.startsWith('##[endgroup]')) inHeader = false; continue; }
    if (line.startsWith('##[group]') || line.startsWith('##[endgroup]')) continue;
    const text = line.replace(/^##\[(error|warning)\]/, '').trimEnd();
    if (text.trim() && !/^Process completed with exit code/.test(text)) body.push(text);
  }
  const errors = body.filter((l) => /error|fail|✗|×|ERR!/i.test(l) && !/^npm error\s*$/.test(l));
  const picked = errors.length ? errors.slice(0, MAX_LINES) : body.slice(-MAX_LINES);
  return picked.length ? picked.map((l) => (l.length > MAX_WIDTH ? `${l.slice(0, MAX_WIDTH - 1)}…` : l)) : null;
}

/** Drops the runner's timestamp and terminal colors from a log line. */
function clean(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '');
}
