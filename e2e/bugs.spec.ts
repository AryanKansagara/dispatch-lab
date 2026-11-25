import { test, expect, orders, paidOrders, couriers, ONE_COURIER, open, tab, load, metric, expectRefused, stored, ordersBox } from './fixtures.ts'
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

test('#8 a run without deliveries has no per-delivery figures', async ({ page }) => {
  await load(page, orders('a,100,10,20,10.01,20,10'), couriers('C1,0,50,10,20'), 'a=greedy.50.50.0&b=batch.50.50.0&cmp=1')
  await expect(metric(page, 'Never delivered')).toHaveText('100%')
  await expect(page.locator('.verdict')).not.toContainText(/NaN|Infinity/, { timeout: 3_000 })
  await expect(page.locator('.verdict')).toContainText('Neither strategy delivered anything (0 of 1)')
  for (const row of ['Courier minutes per delivery', 'Miles per delivery', 'Platform cost per delivery', 'Pay per active hour']) {
    for (const col of [0, 1, 2]) await expect(metric(page, row, col)).toHaveText('n/a')
  }
  await expect(page.getByRole('img', { name: /^Trade-off shape: efficiency n\/a/ })).toHaveCount(2)
  await expect(page.locator('main')).not.toContainText(/NaN|Infinity/)
  await page.getByLabel('Compare side by side').uncheck()
  await expect(page.locator('.verdict')).toContainText('delivered nothing (0 of 1)')
  // The sweep: no frontier, and no free-looking zeros.
  await tab(page, 'Sweep')
  await expect(page.getByText('No setting delivered an order')).toBeVisible({ timeout: 60_000 })
  await page.getByText('View as a table').click()
  const row = page.locator('.table-details tbody tr').first()
  await expect(row.locator('td').nth(1)).toHaveText('n/a')
  await expect(row.locator('td').nth(5)).toHaveText('n/a')
  await expect(page.locator('.table-details tbody')).not.toContainText(/Yes|NaN|Infinity/)
})

test('#8 one strategy delivering and the other not is not a comparison', async ({ page }) => {
  const two = orders('a,1,10.02,20,10.03,20,5', 'b,1,10.02,20,10.03,20,5')
  await load(page, two, couriers('C1,0,2,10,20'), 'a=greedy.50.50.0&b=optimizer.100.50.0&cmp=1')
  await expect(page.locator('.verdict')).toContainText('B (Optimizer, batching 100) delivered nothing, while A delivered 1 of 2')
  await expect(metric(page, 'Courier minutes per delivery')).toHaveText(/^\d+\.\d$/)
  await expect(metric(page, 'Courier minutes per delivery', 1)).toHaveText('n/a')
  await expect(metric(page, 'Courier minutes per delivery', 2)).toHaveText('n/a')
  await expect(page.locator('main')).not.toContainText(/NaN|Infinity/)
  await tab(page, 'Sweep')
  await page.getByRole('slider', { name: 'Days per point' }).fill('1')
  await expect(page.getByText(/Not shown, delivered nothing: batching .*100/)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('button', { name: /^Apply batching weight 100\./ })).toHaveCount(0)
  await expect(page.locator('main')).not.toContainText(/NaN|Infinity/)
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

test('#11 a dataset that cannot be saved does not bring the old one back', async ({ page }) => {
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
  await expect(metric(page, 'Never delivered')).toHaveText('0%')
  expect(await stored(page)).toBeNull()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'No dataset loaded yet' })).toBeVisible()
  await expect(page.locator('.verdict')).toHaveCount(0)
  await tab(page, 'Your data')
  await expect(page.getByText('Loaded', { exact: true })).toHaveCount(0)
})

test('#11 a dataset that fits is still saved, also after one that did not', async ({ page }) => {
  await load(page, orders('old,1,10,20,10.01,20,10'), ONE_COURIER)
  await expect(page.locator('.verdict')).toBeVisible()
  await page.evaluate(() => {
    const set = Storage.prototype.setItem
    Storage.prototype.setItem = function (k, v) {
      if (k === 'dispatch-lab-dataset' && v.includes('toobig')) throw new DOMException('full', 'QuotaExceededError')
      set.call(this, k, v)
    }
  })
  for (const id of ['toobig', 'small']) {
    await tab(page, 'Your data')
    await ordersBox(page).fill(orders(`${id},1,10,20,10.01,20,10`))
    await page.getByRole('button', { name: 'Load and replay' }).click()
    await expect(page.locator('.verdict')).toBeVisible()
  }
  await page.reload()
  await expect(page.locator('.verdict')).toBeVisible()
  expect((await stored(page))!.orders.map(o => o.id)).toEqual(['small'])
})

test.fail('#12 a share link pasted into the open tab applies', async ({ page }) => {
  await open(page, 'seed=5&cmp=0')
  await expect(page.locator('.verdict')).toBeVisible()
  await page.evaluate(() => { location.hash = 's=rain&city=grid&seed=99' })
  await expect(page.locator('.seed input')).toHaveValue('99', { timeout: 3_000 })
})
