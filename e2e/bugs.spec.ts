import { test, expect, orders, paidOrders, couriers, ONE_COURIER, open, tab, load, metric, expectRefused, stored, ordersBox } from './fixtures.ts'
import { overpass, searchCity, stub } from './osm.ts'

// Open bugs, pinned. Each becomes a normal test in the pull request that fixes it.

test.fail('#2 an experiment whose units all got one arm claims no result', async ({ page }) => {
  await open(page, 'seed=4&tab=experiment&a=greedy.50.50.0&b=batch.50.50.0&days=2&rg=1&w=120')
  const power = page.locator('.stat', { hasText: 'Switchback power' }).locator('b')
  await expect(power).toBeVisible({ timeout: 60_000 })
  await expect(power).toHaveText('n/a', { timeout: 3_000 })
})

test.fail('#3 skipped rows and the assumed fleet are reported beside the results', async ({ page }) => {
  await load(page, orders('a,1,10,20,10.01,20,10', 'b,nope,10,20,10.01,20,10'))
  await expect(page.locator('.verdict')).toBeVisible()
  await expect(page.getByText(/Order line 3: bad created time/)).toBeVisible({ timeout: 3_000 })
  await expect(page.getByText(/assumed fleet of 4/)).toBeVisible()
})

test('#4 dated orders with clock-time couriers are explained, not run', async ({ page }) => {
  await load(page, orders('a,2024-03-02T18:00:00Z,10,20,10.01,20,10'), couriers('C1,17:00,23:00,10,20'))
  await expectRefused(page, /Orders use dated times .* but couriers use clock times/)
})

test('#4 a saved dataset that cannot run is dropped instead of crashing every visit', async ({ page }) => {
  await page.goto('/docs')
  await page.evaluate(() => localStorage.setItem('dispatch-lab-dataset', JSON.stringify({
    name: 'Your data', synthetic: false,
    orders: [{ id: 'a', createdAt: 28489020, store: { lat: 10, lng: 20 }, customer: { lat: 10.01, lng: 20 }, prepMin: 10 }],
    couriers: [{ id: 'C1', shiftStart: 0, shiftEnd: 360, start: { lat: 10, lng: 20 } }],
  })))
  await page.goto('/app#s=custom&city=grid&cmp=0')
  await expect(page.getByRole('heading', { name: 'No dataset loaded yet' })).toBeVisible()
  expect(await stored(page)).toBeNull()
})

test('#5 a $8.25 payout is used as given', async ({ page }) => {
  await load(page, paidOrders('a,0,10,20,10.04,20,10,$8.25'), ONE_COURIER)
  await expect(metric(page, 'Platform cost per delivery')).toHaveText('$8.25')
})

test('#5 a payout that cannot be read whole is reported, not repriced', async ({ page }) => {
  await load(page, paidOrders('a,0,10,20,10.04,20,10,"8,25"'), ONE_COURIER)
  await expectRefused(page, /Order line 2: bad payout/)
})

test('#6 a decimal comma is not read as a date in 2001', async ({ page }) => {
  await load(page, orders('a,"4,5",10,20,10.01,20,10'), ONE_COURIER)
  await expectRefused(page, /Order line 2: bad created time/)
})

test('#6 dates that cannot be read are reported, not folded into one day', async ({ page }) => {
  const rows = ['3/19/2022', '3/20/2022', '3/21/2022'].map((d, i) => `${d},18:0${i},10,20,10.01,20,10`)
  await load(page, ['order_date,created,store_lat,store_lng,customer_lat,customer_lng,prep', ...rows].join('\n'))
  await expectRefused(page, /Order line 2: bad date.*Order line 3: bad date.*Order line 4: bad date/)
})

test('#7 an open quote is an error, not a shorter file', async ({ page }) => {
  await load(page, orders('a,1,10,20,10.01,20,10', 'b,2,10,20,10.01,20,"10', 'c,3,10,20,10.01,20,10'), ONE_COURIER)
  await expectRefused(page, /quote opened on line 3 is never closed/)
})

test('#7 shifted rows and entries that are not objects are reported', async ({ page }) => {
  await load(page, paidOrders('a,1,10,20,10.01,20,10,8,25'), ONE_COURIER)
  await expectRefused(page, /Order line 2: 9 values for 8 columns/)
  await ordersBox(page).fill('[null]')
  await page.getByRole('button', { name: 'Load and replay' }).click()
  await expectRefused(page, /Order line 2: not an object/)
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
