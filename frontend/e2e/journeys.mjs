/**
 * End-to-end journeys through the real UI against the real backend.
 *
 * The unit and backtest layers prove the engine decides correctly. This layer proves the decision
 * survives the trip to the screen — which is where the abstain was previously being thrown away.
 *
 * Prerequisites (see e2e/README.md):
 *   backend   mvn -B spring-boot:run          in spring-backend/   -> 127.0.0.1:8080
 *   frontend  python3 -m http.server 4173     in frontend/         -> 127.0.0.1:4173
 *
 * Run: node frontend/e2e/journeys.mjs
 */
import { chromium } from 'playwright';

const APP = process.env.RECALL_APP_URL || 'http://127.0.0.1:4173/';
const BACKEND = process.env.RECALL_BACKEND_URL || 'http://127.0.0.1:8080';
const DEAD_BACKEND = 'http://127.0.0.1:9';

const results = [];
let failures = 0;

function check(name, condition, detail = '') {
  const ok = !!condition;
  if (!ok) failures++;
  results.push(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n          ${detail}` : ''}`);
}

/** A corpus of SQL incidents, all resolved the same way. */
const SQL_CORPUS = [
  {
    id: 'SEED-1', adoId: 'SEED-1', title: 'SQL deadlock during checkout',
    description: 'Deadlock victim error 1205 on concurrent order writes',
    severity: 'high', system: 'SQL Server 2019', resolvedPatch: 'patch_deadlock_retry',
    resolutionDescription: 'Added retry with backoff around the transaction', outcome: 'resolved',
  },
  {
    id: 'SEED-2', adoId: 'SEED-2', title: 'Order writes deadlocking under load',
    description: 'Lock contention between writers, error 1205 raised repeatedly',
    severity: 'high', system: 'SQL Server 2019', resolvedPatch: 'patch_deadlock_retry',
    resolutionDescription: 'Retry with backoff, consistent lock ordering', outcome: 'resolved',
  },
  {
    id: 'SEED-3', adoId: 'SEED-3', title: 'Billing transaction chosen as deadlock victim',
    description: 'Error 1205 during concurrent ledger and invoice updates',
    severity: 'critical', system: 'SQL Server 2019', resolvedPatch: 'patch_deadlock_retry',
    resolutionDescription: 'Backoff and retry on the writer', outcome: 'resolved',
  },
];

const XSS_PAYLOAD = '<img src=x onerror="window.__xss=true">';

async function seed(page, { corpus, backendUrl, backendEnabled = true }) {
  await page.evaluate(({ corpus, backendUrl, backendEnabled }) => {
    localStorage.clear();
    sessionStorage.clear();

    TicketIntegrations.createOrUpdateProfile({
      provider: 'azure',
      name: 'E2E',
      config: { orgUrl: 'https://dev.azure.com/e2e', project: 'Demo', pat: 'e2e-fake-pat' },
    });
    const profile = TicketIntegrations.listProfiles()[0];
    TicketIntegrations.setActiveProfile(profile.id);

    TrainingStore.clear();
    corpus.forEach(t => TrainingStore.add(t));

    RecommendationSettings.save({ backendEnabled, backendUrl, backendTopK: 5 });
  }, { corpus, backendUrl, backendEnabled });

  await page.reload({ waitUntil: 'networkidle' });
}

async function submitIncident(page, { title, description, severity = 'high', system = '' }) {
  await page.fill('#title', title);
  await page.fill('#description', description);
  await page.selectOption('#severity', severity).catch(() => {});
  if (system) await page.selectOption('#system', system).catch(() => {});
  await page.click('#analyze-btn');
  await page.waitForSelector('#tab-results.active', { timeout: 20000 });
  await page.waitForTimeout(400); // let the render settle
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();

const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));

try {
  await page.goto(APP, { waitUntil: 'networkidle' });

  // ─────────────────────────────────────────────────────────────
  // 1. The corpus has an answer -> a fix is recommended.
  // ─────────────────────────────────────────────────────────────
  await seed(page, { corpus: SQL_CORPUS, backendUrl: BACKEND });
  await submitIncident(page, {
    title: 'SQL deadlock in the checkout path',
    description: 'Deadlock victim error 1205 raised on concurrent order writes under load',
    severity: 'high',
  });

  const recommended = await page.locator('.patch-card').count();
  const promptOnMatch = await page.locator('.resolution-prompt').count();
  check('matching incident shows a recommended fix', recommended > 0, `patch cards: ${recommended}`);
  check('matching incident does not ask for a fix', promptOnMatch === 0);

  // ─────────────────────────────────────────────────────────────
  // 2. The corpus has no answer -> ask, never guess.
  //    This is the regression that mattered: an abstain used to cascade to the
  //    local engine, which produced a confident recommendation anyway.
  // ─────────────────────────────────────────────────────────────
  await seed(page, { corpus: SQL_CORPUS, backendUrl: BACKEND });
  await submitIncident(page, {
    title: 'Kubernetes ingress pods evicted during node drain',
    description: 'Ingress controller pods restart in a loop while draining a node, readiness probes flapping',
    severity: 'high',
  });

  const guessed = await page.locator('.patch-card').count();
  const askedForFix = await page.locator('.resolution-prompt').count();
  check('unrelated incident shows NO recommended fix', guessed === 0, `patch cards: ${guessed}`);
  check('unrelated incident asks the engineer to record the fix', askedForFix === 1);

  const engineBadge = await page.locator('.engine-badge').first().innerText().catch(() => '');
  check('abstain is attributed to the backend, not a fallback engine',
    /backend/i.test(engineBadge), `badge: "${engineBadge}"`);

  // The prompt must lead somewhere useful. Guarded so that a missing prompt reports as one
  // failed check rather than aborting every check after it.
  if (askedForFix === 1) {
    await page.click('#record-resolution-btn');
    await page.waitForTimeout(300);
    const onTrainTab = await page.locator('#tab-train.active').count();
    check('"Record the fix" opens the training tab', onTrainTab === 1);
  } else {
    check('"Record the fix" opens the training tab', false, 'prompt was never rendered');
  }

  // ─────────────────────────────────────────────────────────────
  // 3. Backend unreachable -> this IS allowed to fall back.
  //    Proves the distinction: an abstain is an answer, a failure is not.
  // ─────────────────────────────────────────────────────────────
  await seed(page, { corpus: SQL_CORPUS, backendUrl: DEAD_BACKEND });
  await submitIncident(page, {
    title: 'SQL deadlock in the checkout path',
    description: 'Deadlock victim error 1205 raised on concurrent order writes under load',
    severity: 'high',
  });

  const fallbackCards = await page.locator('.patch-card').count();
  const fallbackBadge = await page.locator('.engine-badge').first().innerText().catch(() => '');
  check('unreachable backend still produces a local answer', fallbackCards > 0,
    `patch cards: ${fallbackCards}`);
  check('local fallback is labelled as such, not as the backend',
    !/backend/i.test(fallbackBadge), `badge: "${fallbackBadge}"`);

  // ─────────────────────────────────────────────────────────────
  // 4. Ticket text is attacker-controlled. It must render as text.
  // ─────────────────────────────────────────────────────────────
  const hostileCorpus = SQL_CORPUS.map((t, i) => ({
    ...t,
    id: `XSS-${i}`, adoId: `XSS-${i}`,
    title: `${t.title} ${XSS_PAYLOAD}`,
    description: `${t.description} ${XSS_PAYLOAD}`,
    resolutionDescription: `${t.resolutionDescription} ${XSS_PAYLOAD}`,
  }));

  await seed(page, { corpus: hostileCorpus, backendUrl: BACKEND });
  await submitIncident(page, {
    title: 'SQL deadlock in the checkout path',
    description: 'Deadlock victim error 1205 raised on concurrent order writes under load',
    severity: 'high',
  });

  const xssFired = await page.evaluate(() => window.__xss === true);
  const injectedImg = await page.locator('#results-panel img[src="x"]').count();
  check('markup in ticket text does not execute', xssFired === false);
  check('markup in ticket text is not injected as an element', injectedImg === 0,
    `injected <img>: ${injectedImg}`);

  // ─────────────────────────────────────────────────────────────
  // 5. The measurement loop: a decision, a real outcome, a live KPI.
  //    Without this the dashboard is decoration — accuracy can only be
  //    measured if outcomes make it back to the decision that caused them.
  // ─────────────────────────────────────────────────────────────
  await seed(page, { corpus: SQL_CORPUS, backendUrl: BACKEND });

  const before = await page.evaluate(async url => {
    const r = await fetch(`${url}/v1/metrics`);
    return r.json();
  }, BACKEND);

  await submitIncident(page, {
    title: 'SQL deadlock in the checkout path',
    description: 'Deadlock victim error 1205 raised on concurrent order writes under load',
    severity: 'high',
  });

  const decisionId = await page.evaluate(() => {
    const history = JSON.parse(localStorage.getItem(
      Object.keys(localStorage).find(k => k.endsWith('_history'))) || '[]');
    return history[0]?.decisionId || '';
  });
  check('the recommendation carries a decisionId to measure against', !!decisionId,
    `decisionId: "${decisionId}"`);

  // "Mark resolved" is the engineer naming what actually fixed it — the strongest label there is.
  const resolveBtn = page.locator('[data-patch][data-ticket]').first();
  const hasResolve = await resolveBtn.count();
  if (hasResolve) {
    await resolveBtn.click();
    await page.waitForTimeout(600);
  }

  const after = await page.evaluate(async url => {
    const r = await fetch(`${url}/v1/metrics`);
    return r.json();
  }, BACKEND);

  check('the decision reached the backend decision log',
    after.decisions > before.decisions,
    `decisions ${before.decisions} -> ${after.decisions}`);
  check('resolving the incident reported an outcome back',
    after.labelledDecisions > before.labelledDecisions,
    `labelled ${before.labelledDecisions} -> ${after.labelledDecisions}`);
  check('a label the engineer took from our suggestion is flagged as circular',
    (after.caveats || []).some(c => c.includes('circular')),
    `caveats: ${JSON.stringify(after.caveats)}`);

  // The dashboard must show the caveats, not just the flattering headline number.
  await page.click('[data-tab="analytics"]');
  await page.waitForTimeout(900);
  const kpiShown = await page.locator('#live-kpi-body .live-kpi-metric').count();
  const caveatsShown = await page.locator('#live-kpi-body .live-kpi-caveats li').count();
  check('the analytics tab shows measured KPIs', kpiShown > 0, `metric tiles: ${kpiShown}`);
  check('the dashboard shows the caveats alongside the numbers', caveatsShown > 0,
    `caveat items: ${caveatsShown}`);

  check('no uncaught page errors across all journeys', pageErrors.length === 0,
    pageErrors.join('\n          '));
} catch (err) {
  failures++;
  results.push(`  FAIL  harness error\n          ${err && err.stack ? err.stack : err}`);
} finally {
  await browser.close();
}

console.log('\n=== Recall end-to-end journeys ===========================\n');
console.log(results.join('\n'));
console.log(`\n  ${results.length - failures}/${results.length} checks passed`);
console.log('\n==========================================================\n');
process.exit(failures === 0 ? 0 : 1);
