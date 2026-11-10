import type { CheckRun, ConversationItem, Reviewer } from './protocol';
import { ago, fail, file, pass, running, say, sized, type SamplePr, type SeedSummary } from './sample-kit';

// A team: several developers, an agent and Dependabot on one storefront app, one approval required to merge,
// and two stacks (a chain four deep, and a base with two PRs on it). The viewer is calebksmith, the lead.
// Everything here is made up.

const ci = (): CheckRun[] => [pass('Lint', 'GitHub Actions'), pass('Types', 'GitHub Actions'), pass('Tests', 'GitHub Actions'), pass('Preview', 'Vercel', 'Preview ready')];
const req = (...logins: string[]): Reviewer[] => logins.map((login) => ({ login, state: 'requested' }));
const rev = (login: string, state: Reviewer['state']): Reviewer => ({ login, state });

interface Spec {
  n: number; title: string; author: string; min: number; head: string; base?: string;
  reviewers?: Reviewer[]; myReview?: SeedSummary['myReview']; draft?: boolean; merged?: boolean;
  checks?: CheckRun[]; conflicts?: boolean; behind?: boolean; threads?: number;
  body: string; path: string; patch: string[]; conversation?: ConversationItem[];
}

function pr(s: Spec): SamplePr {
  const checkRuns = s.checks ?? ci();
  const failed = checkRuns.filter((c) => c.conclusion === 'failure').length;
  const pending = checkRuns.filter((c) => c.status !== 'completed').length;
  return {
    summary: {
      number: s.n, title: s.title, author: s.author, url: 'https://github.com', additions: 0, deletions: 0, updatedAt: ago(s.min),
      headSha: (s.n * 2654435761 >>> 0).toString(16).padStart(8, '0').slice(0, 7), isDraft: !!s.draft, state: s.merged ? 'merged' : 'open',
      labels: [], myReview: s.myReview ?? null,
      checks: { passed: checkRuns.length - failed - pending, failed, pending, total: checkRuns.length },
      mergeable: s.conflicts ? false : s.merged ? null : true,
      mergeState: s.conflicts ? 'dirty' : s.behind ? 'behind' : s.merged ? 'unknown' : failed ? 'unstable' : 'clean',
      unresolvedThreads: s.threads ?? 0,
    },
    files: [file(s.path, s.patch.join('\n'))],
    checkRuns,
    body: s.body,
    bodyHtml: `<p>${s.body}</p>`,
    conversation: s.conversation ?? [],
    headRef: s.head,
    base: s.base,
    reviewers: s.reviewers ?? [],
  };
}

export function teamSeed(): SamplePr[] {
  return sized([
    // Stack A, marco: session store → login API → login form → remember me (a chain, bottom first).
    pr({ n: 101, title: 'Add a session store', author: 'marco', min: 60 * 20, head: 'marco/session-store', reviewers: [rev('dana', 'approved')],
      body: 'Stores sessions in Redis with a 30-day expiry. The login work stacked on this needs it.',
      path: 'src/server/session.ts', patch: ['@@ -0,0 +1,4 @@', '+export async function createSession(userId: string) {', '+  const id = randomId()', '+  await redis.set(`session:${id}`, userId, { ex: 60 * 60 * 24 * 30 })', '+}'] }),
    pr({ n: 102, title: 'Add the login API', author: 'marco', min: 60 * 6, head: 'marco/login-api', base: 'marco/session-store', reviewers: req('calebksmith'),
      body: 'POST /api/login checks the password and starts a session. Stacked on #101.',
      path: 'src/server/routes/login.ts', patch: ['@@ -0,0 +1,4 @@', '+export async function login(req: Request) {', '+  const user = await verifyPassword(await req.json())', '+  return startSession(user.id)', '+}'] }),
    pr({ n: 103, title: 'Build the login form', author: 'marco', min: 90, head: 'marco/login-form', base: 'marco/login-api', reviewers: [...req('calebksmith'), rev('priya', 'commented')],
      checks: [pass('Lint', 'GitHub Actions'), pass('Types', 'GitHub Actions'), running('Tests', 'GitHub Actions'), pass('Preview', 'Vercel', 'Preview ready')],
      body: 'The sign-in page, with errors under each field. Stacked on #102.',
      path: 'src/app/login/page.tsx', patch: ['@@ -0,0 +1,3 @@', '+export default function LoginPage() {', '+  return <LoginForm onSubmit={signIn} />', '+}'],
      conversation: [{ kind: 'review', verdict: 'commented', comment: say('priya', 70, '<p>Can the error for a wrong password say which field to fix?</p>') }] }),
    pr({ n: 104, title: 'Remember me on this device', author: 'marco', min: 40, head: 'marco/remember-me', base: 'marco/login-form', draft: true,
      body: 'Keeps you signed in for 30 days when you tick the box. Stacked on #103.',
      path: 'src/app/login/LoginForm.tsx', patch: ['@@ -12,2 +12,3 @@', '   <PasswordField />', '+  <Checkbox name="remember">Remember me on this device</Checkbox>', '   <SubmitButton />'] }),

    // Stack B, priya: a billing service with two PRs built on it (a fork).
    pr({ n: 110, title: 'Extract the billing service', author: 'priya', min: 60 * 26, head: 'priya/billing-service', myReview: 'changes_requested', threads: 1,
      body: 'Moves billing out of the checkout handler into its own module, so invoices and metering can build on it.',
      path: 'src/server/billing/index.ts', patch: ['@@ -0,0 +1,3 @@', '+export class Billing {', '+  constructor(private readonly db: Db) {}', '+}'],
      conversation: [
        { kind: 'review', verdict: 'changes_requested', comment: say('calebksmith', 60 * 22, '<p>The tax rounding moved with it, but the tests for it didn’t. Please bring those over.</p>') },
        { kind: 'thread', id: 'T_110_1', path: 'src/server/billing/index.ts', line: 2, resolved: false, outdated: false, comments: [say('calebksmith', 60 * 22, '<p>Inject the clock too, so the invoice dates are testable.</p>')] },
      ] }),
    pr({ n: 111, title: 'Generate invoice PDFs', author: 'priya', min: 60 * 9, head: 'priya/invoice-pdfs', base: 'priya/billing-service', reviewers: req('sam'),
      body: 'Renders an invoice as a PDF from the billing service. Stacked on #110.',
      path: 'src/server/billing/invoice.ts', patch: ['@@ -0,0 +1,3 @@', '+export async function invoicePdf(id: string) {', '+  return renderPdf(<Invoice data={await billing.invoice(id)} />)', '+}'] }),
    pr({ n: 112, title: 'Meter API usage', author: 'priya', min: 60 * 3, head: 'priya/usage-metering', base: 'priya/billing-service', reviewers: req('calebksmith'),
      checks: [pass('Lint', 'GitHub Actions'), pass('Types', 'GitHub Actions'), fail('Tests', 'GitHub Actions', 'Run tests', ['FAIL  src/server/billing/meter.test.ts > counts calls per key', 'AssertionError: expected 3 to be 2', 'Tests  1 failed | 41 passed (42)']), pass('Preview', 'Vercel', 'Preview ready')],
      body: 'Counts API calls per key per day, for usage billing. Stacked on #110.',
      path: 'src/server/billing/meter.ts', patch: ['@@ -0,0 +1,3 @@', '+export async function meter(key: string) {', '+  await redis.incr(`usage:${key}:${today()}`)', '+}'] }),

    // Single PRs from the rest of the team.
    pr({ n: 120, title: 'Fix the flaky timezone test', author: 'sam', min: 50, head: 'sam/flaky-tz-test', reviewers: [rev('dana', 'approved')],
      body: 'Pins the test clock to UTC so it passes in every timezone.',
      path: 'src/lib/dates.test.ts', patch: ['@@ -3,2 +3,3 @@', ' describe("formatDate", () => {', '+  beforeEach(() => vi.setSystemTime(new Date("2026-01-01T00:00:00Z")))', '   it("formats a date", () => {'] }),
    pr({ n: 121, title: 'Upgrade to Node 22', author: 'dana', min: 60 * 30, head: 'dana/node-22', reviewers: req('calebksmith', 'sam'), conflicts: true,
      body: 'Moves CI, the Dockerfile and .nvmrc to Node 22.',
      path: '.nvmrc', patch: ['@@ -1 +1 @@', '-20', '+22'] }),
    pr({ n: 122, title: 'Rework the site navigation', author: 'calebksmith', min: 60 * 4, head: 'calebksmith/nav', reviewers: req('priya'),
      body: 'One menu for desktop and mobile, with the cart count in the header.',
      path: 'src/components/Nav.tsx', patch: ['@@ -8,3 +8,3 @@', ' export function Nav() {', '-  return isMobile ? <MobileMenu /> : <DesktopMenu />', '+  return <Menu cartCount={useCart().count} />', ' }'] }),
    pr({ n: 123, title: 'Cache product images', author: 'calebksmith', min: 60 * 2, head: 'calebksmith/image-cache', reviewers: [rev('marco', 'approved')],
      body: 'Serves product images through the CDN with a week-long cache.',
      path: 'next.config.ts', patch: ['@@ -4,2 +4,3 @@', ' images: {', '+  minimumCacheTTL: 60 * 60 * 24 * 7,', '   remotePatterns: [{ hostname: "cdn.example.com" }],'] }),
    pr({ n: 124, title: 'Tidy the checkout copy', author: 'calebksmith', min: 60 * 8, head: 'calebksmith/checkout-copy', reviewers: [rev('dana', 'changes_requested')],
      body: 'Shorter button labels and one voice across checkout.',
      path: 'src/app/checkout/copy.ts', patch: ['@@ -1,2 +1,2 @@', '-export const PAY = "Proceed to payment"', '+export const PAY = "Pay now"', ' export const BACK = "Back to cart"'],
      conversation: [{ kind: 'review', verdict: 'changes_requested', comment: say('dana', 60 * 7, '<p>“Pay now” needs the amount in it for the accessibility audit, like “Pay $42.00”.</p>') }] }),
    pr({ n: 125, title: 'Add alt text to product images', author: 'claude', min: 25, head: 'claude/product-alt-text',
      body: 'Every product image gets alt text from its product name and colour.',
      path: 'src/components/ProductImage.tsx', patch: ['@@ -5,2 +5,2 @@', ' export function ProductImage({ product }: Props) {', '-  return <img src={product.image} />', '+  return <img src={product.image} alt={`${product.name} in ${product.colour}`} />'] }),
    pr({ n: 126, title: 'Speed up product search', author: 'sam', min: 60 * 12, head: 'sam/search-index', reviewers: req('calebksmith'), behind: true,
      body: 'Adds a trigram index so search by name is fast past 10,000 products.',
      path: 'db/migrations/0042_search_index.sql', patch: ['@@ -0,0 +1 @@', '+CREATE INDEX products_name_trgm ON products USING gin (name gin_trgm_ops);'] }),
    pr({ n: 127, title: 'Bump vite from 6.3.1 to 6.3.5', author: 'dependabot', min: 60 * 5, head: 'dependabot/npm_and_yarn/vite-6.3.5',
      body: 'Bumps vite from 6.3.1 to 6.3.5.',
      path: 'package-lock.json', patch: ['@@ -4120,3 +4120,3 @@', '     "node_modules/vite": {', '-      "version": "6.3.1",', '+      "version": "6.3.5",'] }),

    // Merged recently.
    pr({ n: 100, title: 'Cache dependencies in CI', author: 'dana', min: 60 * 28, head: 'dana/ci-cache', merged: true, reviewers: [rev('calebksmith', 'approved')],
      body: 'Caches node_modules between CI runs.',
      path: '.github/workflows/ci.yml', patch: ['@@ -12,2 +12,3 @@', '       - uses: actions/setup-node@v4', '+        with: { cache: npm }', '       - run: npm ci'] }),
  ]);
}
