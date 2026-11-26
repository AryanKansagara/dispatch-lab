import { readFileSync } from 'node:fs'
import { test as base, expect, type Page } from '@playwright/test'

/** The only other hosts the page asks for by itself: web fonts in index.html, answered with an empty stylesheet. */
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com'])

export const test = base.extend<{ external: string[] }>({
  external: async ({}, use) => { await use([]) },

  // Only the app is reachable: any other host fails the test, and so does any uncaught page error.
  context: async ({ context, baseURL, external }, use) => {
    const errors: string[] = []
    const origin = new URL(baseURL!).origin
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin === origin) return route.continue()
      if (FONT_HOSTS.has(url.host)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' })
      external.push(url.host)
      return route.abort('blockedbyclient')
    })
    context.on('weberror', e => errors.push(String(e.error())))
    await use(context)
    expect(errors, 'uncaught page errors').toEqual([])
    expect(external, 'requests to hosts other than the app').toEqual([])
  },
})

export { expect }

export const fixtureFile = (name: string) => readFileSync(new URL(`../src/engine/fixtures/${name}`, import.meta.url), 'utf8')

export const ORDER_HEAD = 'id,created,store_lat,store_lng,customer_lat,customer_lng,prep'
export const COURIER_HEAD = 'courier_id,shift_start,shift_end,start_lat,start_lng'
export const orders = (...rows: string[]) => [ORDER_HEAD, ...rows].join('\n')
export const paidOrders = (...rows: string[]) => [`${ORDER_HEAD},payout`, ...rows].join('\n')
export const couriers = (...rows: string[]) => [COURIER_HEAD, ...rows].join('\n')
export const ONE_COURIER = couriers('C1,0,60,10,20')

/** Opens the tool on the fictional city, which needs no map file. */
export const open = (page: Page, hash = '') => page.goto(`/app#city=grid&s=lunch&${hash}`)

export const tab = (page: Page, name: 'Replay' | 'Experiment' | 'Sweep' | 'Your data') =>
  page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name }).click()

export const ordersBox = (page: Page) => page.getByLabel('Orders, paste CSV or JSON')
export const couriersBox = (page: Page) => page.getByLabel('Couriers (optional), paste CSV or JSON')

/** Pastes a dataset on the data tab and presses load, with strategy A greedy and comparison off unless told otherwise. */
export async function load(page: Page, ordersText: string, couriersText = '', hash = 'a=greedy.50.50.0&cmp=0') {
  await open(page, `tab=data&${hash}`)
  await ordersBox(page).fill(ordersText)
  if (couriersText) await couriersBox(page).fill(couriersText)
  await page.getByRole('button', { name: 'Load and replay' }).click()
}

/** A cell of the replay table: column 0 is A, 1 is B, 2 is the comparison. */
export const metric = (page: Page, label: string, col = 0) =>
  page.locator('table.metrics tbody tr', { has: page.getByRole('rowheader', { name: label, exact: true }) }).locator('td').nth(col)

/** A load that must not produce a result: a message, no saved data and no replay. */
export async function expectRefused(page: Page, message: RegExp) {
  await expect(page.getByRole('alert')).toContainText(message)
  await expect(page.locator('.verdict')).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('dispatch-lab-dataset'))).toBeNull()
}

/** Orders now in the loaded dataset. */
export const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('dispatch-lab-dataset') ?? 'null') as null | {
  orders: { id: string; createdAt: number; prepMin: number; payout?: number; store: { lat: number; lng: number } }[]
  couriers: { id: string; shiftStart: number; shiftEnd: number }[]
})
