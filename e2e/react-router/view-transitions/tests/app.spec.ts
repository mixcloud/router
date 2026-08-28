import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/** One observed call to `document.startViewTransition`. */
type ViewTransitionRecord = {
  /** Transition types active on the document while the transition ran. */
  types: Array<string>
  /** Pseudo-elements the browser animated for the transition. */
  pseudos: Array<string>
}

declare global {
  interface Window {
    __viewTransitions: Array<ViewTransitionRecord>
  }
}

const KNOWN_TYPES = ['slide-left', 'slide-right', 'warp']

/**
 * Wrap `document.startViewTransition` before any app code runs, and sample the
 * live animations once the browser reports the transition as ready. Asserting
 * on the real API is the only way to tell a view transition apart from a plain
 * navigation that happens to end on the right page.
 */
async function recordViewTransitions(page: Page) {
  await page.addInitScript((knownTypes: Array<string>) => {
    window.__viewTransitions = []
    const original = document.startViewTransition?.bind(document)
    if (!original) {
      return
    }
    document.startViewTransition = ((...args: Array<any>) => {
      const record: ViewTransitionRecord = { types: [], pseudos: [] }
      window.__viewTransitions.push(record)
      const transition = original(...(args as [any]))
      transition.ready
        .then(() => {
          record.pseudos = document
            .getAnimations()
            .map((animation) => (animation.effect as any)?.pseudoElement)
            .filter((pseudo): pseudo is string => Boolean(pseudo))
          record.types = knownTypes.filter((type) =>
            document.documentElement.matches(
              `:active-view-transition-type(${type})`,
            ),
          )
        })
        .catch(() => {})
      return transition
    }) as typeof document.startViewTransition
  }, KNOWN_TYPES)
}

const getRecords = (page: Page) => page.evaluate(() => window.__viewTransitions)

test.beforeEach(async ({ page }) => {
  await recordViewTransitions(page)
  await page.goto('/')
})

test('a viewTransition navigation starts a real view transition', async ({
  page,
}) => {
  await page.getByRole('link', { name: 'Next Page' }).click()
  await expect(page.getByRole('heading')).toContainText(
    'This example demonstrates a variety of custom page transitions',
  )

  await expect.poll(async () => (await getRecords(page)).length).toBe(1)
})

test('the transition pairs the shared element across the navigation', async ({
  page,
}) => {
  await page.getByRole('link', { name: 'Next Page' }).click()

  await expect
    .poll(async () => (await getRecords(page))[0]?.pseudos ?? [])
    .toEqual(
      expect.arrayContaining([
        '::view-transition-group(main-content)',
        '::view-transition-old(main-content)',
        '::view-transition-new(main-content)',
      ]),
    )
})

test('the configured viewTransition types are applied to the document', async ({
  page,
}) => {
  const supportsTypes = await page.evaluate(() =>
    Boolean(
      window.CSS?.supports?.('selector(:active-view-transition-type(a))'),
    ),
  )
  test.skip(!supportsTypes, 'browser does not support view transition types')

  await page.getByRole('link', { name: 'Next Page' }).click()
  await expect
    .poll(async () => (await getRecords(page))[0]?.types ?? [])
    .toEqual(['slide-left'])

  await page.getByRole('link', { name: 'Previous Page' }).click()
  await expect
    .poll(async () => (await getRecords(page))[1]?.types ?? [])
    .toEqual(['slide-right'])
})
