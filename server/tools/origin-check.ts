/**
 * Ask a deployment what it renders, rather than what its files contain.
 *
 * A check that searches a bundle for a string answers a question one layer
 * away from the question that it means. A template builds the buttons on the
 * payer screen, so `Level M` never exists as text in the artifact. A search for
 * it therefore calls a working deployment broken.
 *
 * This opens the page in a browser and asks the document. No template can fool
 * a rendered check, and it answers in one step.
 *
 * It asks the deployment which commit it serves before it asks anything else.
 * That question has one answer. Two people therefore cannot reach opposite
 * conclusions from it, as they can from a search through a bundle.
 *
 *   CHROME_PATH=/path/to/chrome ORIGIN=https://senet.hoodrun.io \
 *     EXPECT_COMMIT=$(git rev-parse HEAD) \
 *     npm run origin-check --workspace @senet/server
 */
import { launch } from 'puppeteer-core';

/** How long the check waits for the page to settle. */
const STEP_TIMEOUT_MS = 60_000;

/**
 * What a deployment must render before the device session can run.
 *
 * Each row is a question about the document. A template that builds a label
 * at run time answers it as truly as a literal in the source.
 */
const REQUIRED = [
  { what: 'the account screen', selector: '#screen-account' },
  { what: 'the payer screen', selector: '#screen-payer' },
  { what: 'the merchant screen', selector: '#screen-merchant' },
  { what: 'the button that mints', selector: '#payer-mint' },
  { what: 'the button that scans', selector: '#merchant-scan' },
  { what: 'the three banner facts', selector: '#fact-device, #fact-service, #fact-ledger' },
] as const;

/** The placeholder that a checkout carries in place of a real commit. */
const PLACEHOLDER = 'PLACEHOLDER';

/** What a release says about itself. */
interface Release {
  readonly commit: string;
  readonly release: string;
  readonly publishedAt: string;
}

/** Read a string field out of a value of unknown shape. */
function field(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`the release identity carries no ${key}`);
  }
  return value;
}

/**
 * Ask the deployment which commit it serves.
 *
 * A content search cannot tell a build that is missing something from a build
 * that has not landed yet. This question can, because a release states its own
 * identity rather than leaving a reader to infer one.
 */
async function readRelease(origin: string): Promise<Release> {
  const response = await fetch(`${origin}/release.json`);
  if (!response.ok) {
    throw new Error(`${origin} serves no release identity: it answered ${response.status}`);
  }
  const parsed: unknown = await response.json();
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the release identity is not a JSON object');
  }
  const fields: Record<string, unknown> = { ...parsed };
  const release = {
    commit: field(fields, 'commit'),
    release: field(fields, 'release'),
    publishedAt: field(fields, 'publishedAt'),
  };
  if (release.commit.includes(PLACEHOLDER)) {
    throw new Error('this deployment came from a working tree rather than from an export');
  }
  return release;
}

/** Read a variable that the check cannot run without. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set, and the check needs it`);
  }
  return value;
}

async function main(): Promise<void> {
  const origin = required('ORIGIN');
  const browser = await launch({
    executablePath: required('CHROME_PATH'),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const release = await readRelease(origin);
    console.log(`commit     ${release.commit}`);
    console.log(`release    ${release.release}, published ${release.publishedAt}`);
    const expected = process.env['EXPECT_COMMIT'];
    if (expected !== undefined && expected !== '' && expected !== release.commit) {
      throw new Error(
        `this deployment serves ${release.commit} and the check expected ${expected}`,
      );
    }

    const page = await browser.newPage();
    await page.goto(origin, { waitUntil: 'load', timeout: STEP_TIMEOUT_MS });

    const missing: string[] = [];
    for (const row of REQUIRED) {
      const found = await page.$(row.selector);
      console.log(`${found === null ? 'missing' : 'present'}    ${row.what}`);
      if (found === null) missing.push(row.what);
    }

    // The level control appears only after a mint, and a mint needs an account.
    // This asks whether the build knows how to draw one. A registration here
    // would leave an account that nobody can ever use.
    const drawsLevels = await page.evaluate(() => {
      const styles = Array.from(document.styleSheets);
      return styles.some((sheet) => {
        try {
          return Array.from(sheet.cssRules).some((rule) => rule.cssText.includes('levels-button'));
        } catch {
          // A browser refuses a stylesheet from another origin. This deployment
          // serves its own, so that case is not this one.
          return false;
        }
      });
    });
    console.log(`${drawsLevels ? 'present' : 'missing'}    the level control's styles`);
    if (!drawsLevels) missing.push("the level control's styles");

    console.log(`\norigin     ${origin}`);
    if (missing.length > 0) {
      throw new Error(`this deployment renders no ${missing.join(', no ')}`);
    }
    console.log('this deployment carries everything that the device session needs');
  } finally {
    await browser.close();
  }
}

await main();
