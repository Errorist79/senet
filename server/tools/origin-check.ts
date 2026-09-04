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
 *   CHROME_PATH=/path/to/chrome ORIGIN=https://senet.hoodrun.io \
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
