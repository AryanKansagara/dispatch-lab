import { test, expect, open } from './fixtures.ts'
import { overpass, searchCity, stub } from './osm.ts'

test('city search: a searched place loads once and is remembered', async ({ page }) => {
  const hits = await stub(page, [{ json: overpass() }])
  await open(page, 'cmp=0')
  await searchCity(page)
  await expect(page.locator('.verdict')).toBeVisible()
  await expect(page.getByText('Real streets, synthetic orders')).toBeVisible()
  await expect(page).toHaveURL(/city=%4050\.0000%2C10\.0000%2CTestville/)
  await page.reload()
  await expect(page.locator('.verdict')).toBeVisible()
  expect(hits).toHaveLength(1)
})

test('city search: a failing mirror is skipped for the next one', async ({ page }) => {
  const hits = await stub(page, [{ status: 504, json: {} }, { json: overpass() }])
  await open(page, 'cmp=0')
  await searchCity(page)
  await expect(page.locator('.verdict')).toBeVisible()
  expect(hits).toHaveLength(2)
})

test('city search: too few restaurants and busy servers say so, with a way out', async ({ page }) => {
  await stub(page, [{ json: overpass(5) }])
  await open(page, 'cmp=0')
  await searchCity(page)
  await expect(page.getByRole('alert')).toContainText('Only 5 restaurants are mapped within 3 km of Testville')
  await page.getByRole('button', { name: 'Use the fictional city' }).click()
  await expect(page.locator('.verdict')).toBeVisible()
  await page.unroute(/overpass/)
  await stub(page, [{ status: 429, json: {} }])
  await searchCity(page)
  await expect(page.getByRole('alert')).toContainText('servers are busy right now (HTTP 429)')
})
