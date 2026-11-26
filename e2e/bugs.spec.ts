import { test, expect, orders, paidOrders, couriers, ONE_COURIER, open, tab, load, metric, stored, ordersBox } from './fixtures.ts'
import { overpass, searchCity, stub } from './osm.ts'

// Open bugs, pinned. Each becomes a normal test in the pull request that fixes it.

test('#2 an experiment whose units all got one arm claims no result', async ({ page }) => {
  await open(page, 'seed=4&tab=experiment&a=greedy.50.50.0&b=batch.50.50.0&days=2&rg=1&w=120')
  const power = page.locator('.stat', { hasText: 'Switchback power' }).locator('b')
  await expect(power).toBeVisible({ timeout: 60_000 })
  await expect(power).toHaveText('n/a', { timeout: 3_000 })
})

test('#3 skipped rows and the assumed fleet are reported beside the results', async ({ page }) => {
  const report = page.getByRole('note', { name: 'Import report' })
  await load(page, orders('a,1,10,20,10.01,20,10', 'b,nope,10,20,10.01,20,10'))
  await expect(page.locator('.verdict')).toBeVisible()
  await expect(report).toContainText('Order line 3: bad created time')
  await expect(report).toContainText('assumed fleet of 4')
  // It stays with the data: after a reload, and on the other tabs that show results.
  await page.reload()
  await expect(report).toContainText('Order line 3')
  for (const name of ['Experiment', 'Sweep', 'Your data'] as const) {
    await tab(page, name)
    await expect(report).toContainText('Order line 3')
  }
  // A scenario is not about this file, and a clean file has nothing to report.
  await tab(page, 'Replay')
  await page.getByRole('button', { name: 'Lunch rush' }).click()
  await expect(report).toHaveCount(0)
  await page.goto('/')
  await load(page, orders('a,1,10,20,10.01,20,10'), ONE_COURIER)
  await expect(page.locator('.verdict')).toBeVisible()
  await expect(report).toHaveCount(0)
})

test.fail('#4 dated orders with clock-time couriers are explained, not run', async ({ page }) => {
  test.setTimeout(60_000)
  await load(page, orders('a,2024-03-02T18:00:00Z,10,20,10.01,20,10'), couriers('C1,17:00,23:00,10,20'))
  await expect(page.getByRole('alert')).toContainText(/clock/, { timeout: 10_000 })
})

test.fail('#5 a $8.25 payout is used as given', async ({ page }) => {
  await load(page, paidOrders('a,0,10,20,10.04,20,10,$8.25'), ONE_COURIER)
  await expect(metric(page, 'Platform cost per delivery')).toHaveText('$8.25', { timeout: 5_000 })
})

test.fail('#6 a decimal comma is not read as a date in 2001', async ({ page }) => {
  await load(page, orders('a,"4,5",10,20,10.01,20,10'), ONE_COURIER)
  await expect(page.getByRole('alert')).toContainText('Order line 2: bad created time', { timeout: 5_000 })
})

test.fail('#7 an open quote is an error, not a shorter file', async ({ page }) => {
  await load(page, orders('a,1,10,20,10.01,20,10', 'b,2,10,20,10.01,20,"10', 'c,3,10,20,10.01,20,10'), ONE_COURIER)
  await expect(page.getByRole('alert')).toContainText(/quote/, { timeout: 5_000 })
})

test.fail('#8 a run without deliveries has no per-delivery figures', async ({ page }) => {
  await load(page, orders('a,100,10,20,10.01,20,10'), couriers('C1,0,50,10,20'), 'a=greedy.50.50.0&b=batch.50.50.0&cmp=1')
  await expect(metric(page, 'Never delivered')).toHaveText('100%')
  await expect(page.locator('.verdict')).not.toContainText(/NaN|Infinity/, { timeout: 3_000 })
  await expect(metric(page, 'Courier minutes per delivery')).toHaveText('n/a')
})

test.fail('#9 a $0 order in a stack is shown as $0.00', async ({ page }) => {
  await load(page, paidOrders('a,0,10,20,10.02,20,5,0', 'b,0,10,20,10.02,20,5,12'), ONE_COURIER, 'a=batch.50.50.0&cmp=0')
  await expect(metric(page, 'Orders in stacks')).toHaveText('100%')
  await expect(metric(page, 'Worst-paid order in a stack')).toHaveText('$0.00', { timeout: 3_000 })
})

test.fail('#10 a timed-out OpenStreetMap answer is retried, not kept', async ({ page }) => {
  const hits = await stub(page, [{ json: { ...overpass(15), remark: 'runtime error: Query timed out in "query" at line 1 after 91 seconds.' } }, { json: overpass() }])
  await open(page, 'cmp=0')
  await searchCity(page)
  await expect(page.locator('.verdict')).toBeVisible()
  expect(hits).toHaveLength(2)
})

test.fail('#11 a dataset that cannot be saved does not bring the old one back', async ({ page }) => {
  await load(page, orders('old,1,10,20,10.01,20,10'), ONE_COURIER)
  await expect(page.locator('.verdict')).toBeVisible()
  await page.evaluate(() => {
    const set = Storage.prototype.setItem
    Storage.prototype.setItem = function (k, v) {
      if (k === 'dispatch-lab-dataset') throw new DOMException('full', 'QuotaExceededError')
      set.call(this, k, v)
    }
  })
  await tab(page, 'Your data')
  await ordersBox(page).fill(orders('new,1,10,20,10.01,20,10', 'new2,2,10,20,10.01,20,10'))
  await page.getByRole('button', { name: 'Load and replay' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'too big to remember' })).toBeVisible()
  expect(await stored(page)).toBeNull()
})

test.fail('#12 a share link pasted into the open tab applies', async ({ page }) => {
  await open(page, 'seed=5&cmp=0')
  await expect(page.locator('.verdict')).toBeVisible()
  await page.evaluate(() => { location.hash = 's=rain&city=grid&seed=99' })
  await expect(page.locator('.seed input')).toHaveValue('99', { timeout: 3_000 })
})
