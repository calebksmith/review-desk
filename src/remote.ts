/** owner/name from a GitHub remote URL (https or ssh), or null for any other host. */
export function parseRemote(url: string): string | null {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}
