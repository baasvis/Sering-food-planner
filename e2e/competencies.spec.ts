import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { loginAsDev } from './helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Competencies (the "Training" module) — peer-teaching grid.
//
// The grid only has a tappable cell where a person row crosses a chunk column.
// Chunks come from Notion (there is no in-app create path), so this suite seeds
// one fixture chunk straight into the test DB. People and teaching events ARE
// created through the UI by the tests below — that is the flow under test.
//
// A standalone PrismaClient is used (not lib/db's shared client): the app runs
// as a separate `npm run preview` process, so the spec only needs the DB for
// fixture setup/teardown. playwright.config.ts has already pointed DATABASE_URL
// at the test DB by the time this module loads.
// ─────────────────────────────────────────────────────────────────────────────

const prisma = new PrismaClient();

const RUN = Date.now();
const CHUNK_ID = `e2e-comp-chunk-${RUN}`;
const CHUNK_NAME = `E2E Comp Chunk ${RUN}`;
// People are created through the UI, which assigns random IDs — so test people
// are swept by name prefix, not ID.
const PERSON_PREFIX = 'e2e-comp-';

// Open the Training module from the nav and wait for its screen-load fetch.
async function openTrainingModule(page: Page): Promise<void> {
  const load = page.waitForResponse(
    (r) => r.url().includes('/api/competencies') && r.request().method() === 'GET',
  );
  await page.locator('.nav-btn[data-screen="competencies"]').click();
  await load;
  await expect(page.getByRole('heading', { name: 'Training', exact: true })).toBeVisible();
}

// Add a staff member through the kiosk "+ Add a name" control. Returns the
// new person's server-assigned id so callers can target grid cells precisely.
async function addPerson(page: Page, name: string): Promise<string> {
  await page.getByTestId('comp-add-person').click();
  await expect(page.getByTestId('comp-add-modal')).toBeVisible();
  await page.fill('#comp-person-name', name);
  const saved = page.waitForResponse(
    (r) => r.url().includes('/api/competencies/people') && r.request().method() === 'POST',
  );
  await page.getByTestId('comp-add-modal').getByRole('button', { name: 'Add', exact: true }).click();
  const id = (await (await saved).json()).id as string;
  // Wait until the grid re-render lands. submitCompAddPerson() closes the
  // modal, then awaits renderCompetencies() — callers read module state (e.g.
  // the log modal's teacher picker) that is only fresh once that repaint runs.
  await expect(page.locator(`.comp-rowhead[data-person="${id}"]`)).toBeVisible();
  return id;
}

test.describe('Competencies', () => {
  test.beforeAll(async () => {
    await prisma.chunk.create({
      data: {
        id: CHUNK_ID,
        name: CHUNK_NAME,
        station: 'E2E Station',
        type: 'practical',
        goal: 'A fixture chunk for the e2e suite.',
        teachingGuide:
          '## Getting started\nWalk through the basics.\n\n## Wrapping up\nClean down the station.',
      },
    });
  });

  test.afterAll(async () => {
    // FK order: teaching_events reference chunks + people (ON DELETE RESTRICT),
    // so events go first. Prefix-matched so a crashed run's leftovers are swept
    // too.
    await prisma.teachingEvent.deleteMany({ where: { chunkId: { startsWith: 'e2e-comp-chunk-' } } });
    const people = await prisma.person.findMany({ where: { name: { startsWith: PERSON_PREFIX } } });
    const ids = people.map((p) => p.id);
    if (ids.length) {
      await prisma.teachingEvent.deleteMany({
        where: { OR: [{ teacherId: { in: ids } }, { learnerId: { in: ids } }] },
      });
      await prisma.person.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.chunk.deleteMany({ where: { id: { startsWith: 'e2e-comp-chunk-' } } });
    await prisma.$disconnect();
  });

  test('logs a teaching from the grid and shows it in the ledger', async ({ page }) => {
    await loginAsDev(page);
    await openTrainingModule(page);

    const learner = `${PERSON_PREFIX}learner-${RUN}`;
    const teacher = `${PERSON_PREFIX}teacher-${RUN}`;
    const learnerId = await addPerson(page, learner);
    const teacherId = await addPerson(page, teacher);

    // A grid cell = learner row × chunk column, addressed by the two ids.
    const cellSelector = `[data-testid="comp-cell"][data-learner="${learnerId}"][data-chunk="${CHUNK_ID}"]`;
    await expect(page.locator(cellSelector)).toBeVisible();
    await expect(page.locator(cellSelector)).toHaveText('—'); // never taught yet

    // Tapping the cell opens the log modal with learner + chunk pre-filled.
    await page.locator(cellSelector).click();
    await expect(page.getByTestId('comp-log-modal')).toBeVisible();

    // Pick the teacher, then log it.
    await page.locator(`[data-testid="comp-teacher-btn"][data-teacher="${teacherId}"]`).click();
    const logged = page.waitForResponse(
      (r) => r.url().includes('/api/competencies/events') && r.request().method() === 'POST',
    );
    await page.getByTestId('comp-log-submit').click();
    await logged;

    // The cell flips to "today" and the teaching tops the recent-logged list.
    await expect(page.getByTestId('comp-log-modal')).toBeHidden();
    await expect(page.locator(cellSelector)).toHaveText('today');
    const topRow = page.getByTestId('comp-ledger-row').first();
    await expect(topRow).toContainText(teacher);
    await expect(topRow).toContainText(learner);
  });

  test('drills into person detail, chunk detail and the admin view', async ({ page }) => {
    await loginAsDev(page);
    await openTrainingModule(page);

    const person = `${PERSON_PREFIX}solo-${RUN}`;
    const personId = await addPerson(page, person);

    // Person detail — tapping a row header opens their history.
    await page.locator(`.comp-rowhead[data-person="${personId}"]`).click();
    await expect(page.getByRole('heading', { name: person })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Not yet' })).toBeVisible();
    await page.getByRole('button', { name: /Grid/ }).click();

    // Chunk detail — tapping a column header opens the teaching guide.
    await page.locator(`[data-testid="comp-chunkhead"][data-chunk="${CHUNK_ID}"]`).click();
    await expect(page.getByTestId('comp-chunk-detail')).toBeVisible();
    await expect(page.getByTestId('comp-guide-section').first()).toBeVisible();
    await page.getByRole('button', { name: /Grid/ }).click();

    // Admin view — visible because the dev-mode user is a staff-lead
    // (STAFF_LEAD_EMAILS is set for the e2e server in playwright.config.ts).
    await page.getByTestId('comp-admin-btn').click();
    await expect(page.getByTestId('comp-sync-btn')).toBeVisible();
    await expect(page.locator('.comp-admin-name', { hasText: person })).toBeVisible();
  });
});
