import { test, expect, fixtureFile, orders, paidOrders, couriers, ONE_COURIER, open, tab, load, metric, expectRefused, stored, ordersBox, couriersBox } from './fixtures.ts'

/*
 * Worked by hand. Store 10 N 20 E, customer 10.04 N 20 E: along a meridian, so the great circle is
 * 6371.0088 km x 0.04 x pi / 180 = 4.44780 km. Road factor 1.35 gives 6.00453 km = 3.73105 miles.
 * At 24 km/h that is 15.0113 min. The courier stands at the store. The order arrives at 0, is ready
 * at 10, takes 2 min to pick up (12.0), and is handed over 1.5 min after arriving: 28.5113 min.
 * Food waits 2 min on the shelf: 22 + 52 x exp(-0.035 x 2 - 0.02 x 16.5113) = 56.85 C.
 * Model pay: 2 + 0.70 x 3.73105 = 4.6117. Promise: 10 + 15.0113 + 2 + 1.5 + 14 = 42.5, so not late.
 */
const HAND = 'o1,0,10,20,10.04,20,10'

test('hand-worked run: one order, uploaded payout', async ({ page }) => {
  await load(page, paidOrders(`${HAND},9.50`), ONE_COURIER)
  await expect(metric(page, 'Delivery time, p50 (min)')).toHaveText('28.5')
  await expect(metric(page, 'Courier minutes per delivery')).toHaveText('28.5')
  await expect(metric(page, 'Miles per delivery')).toHaveText('3.73')
  // 28.5113 of 60 online minutes.
  await expect(metric(page, 'Courier utilization')).toHaveText('48%')
  await expect(metric(page, 'Platform cost per delivery')).toHaveText('$9.50')
  await expect(metric(page, 'Food wait after ready (min)')).toHaveText('2.0')
  await expect(metric(page, 'Temperature at the door')).toHaveText('56.8°C')
  await expect(metric(page, 'Late rate')).toHaveText('0%')
  await expect(metric(page, 'Never delivered')).toHaveText('0%')
  // 9.50 / (28.5113 / 60) and 9.50 / 1 h and 9.50 / 3.73105 miles.
  await expect(metric(page, 'Pay per active hour')).toHaveText('$19.99')
  await expect(metric(page, 'Pay per online hour')).toHaveText('$9.50')
  await expect(metric(page, 'Pay per mile')).toHaveText('$2.55')
  await expect(metric(page, 'Worst-paid order in a stack')).toHaveText('No stacks')
})

test('hand-worked run: without a payout the pay model prices the added miles', async ({ page }) => {
  await load(page, orders(HAND), ONE_COURIER)
  await expect(metric(page, 'Platform cost per delivery')).toHaveText('$4.61')
  await expect(metric(page, 'Pay per online hour')).toHaveText('$4.61')
  // At 12 km/h the drive doubles to 30.0227 min: 12 + 30.0227 + 1.5.
  await page.getByText('World settings').click()
  await page.getByLabel('Courier speed').fill('12')
  await expect(metric(page, 'Delivery time, p50 (min)')).toHaveText('43.5')
})

test('hand-worked stack: the second order to the same door earns only the $2 floor', async ({ page }) => {
  // Same store, same customer, both at minute 0. The second adds no miles: max(2, 2 + 0) = 2.
  await load(page, orders('a,0,10,20,10.04,20,10', 'b,0,10,20,10.04,20,10'), ONE_COURIER, 'a=batch.50.50.0&cmp=0')
  await expect(metric(page, 'Orders in stacks')).toHaveText('100%')
  await expect(metric(page, 'Worst-paid order in a stack')).toHaveText('$2.00')
  await expect(metric(page, 'Stacks hiding an order under $4')).toHaveText('100%')
  // (4.6117 + 2) / 2 deliveries.
  await expect(metric(page, 'Platform cost per delivery')).toHaveText('$3.31')
})

test('the built-in sample loads, replays, and survives a reload until removed', async ({ page }) => {
  await open(page, 'tab=data&cmp=0')
  await expect(page.getByRole('button', { name: 'Load and replay' })).toBeDisabled()
  await page.getByRole('button', { name: 'Fill with a synthetic sample' }).click()
  await page.getByRole('button', { name: 'Load and replay' }).click()
  await expect(page.getByText('Your data, local to this browser')).toBeVisible()
  await expect(metric(page, 'Pay per mile')).toHaveText(/^\$\d/)
  const p50 = await metric(page, 'Delivery time, p50 (min)').textContent()
  await page.reload()
  await expect(metric(page, 'Delivery time, p50 (min)')).toHaveText(p50!)
  // The link carries settings only.
  expect(page.url()).toContain('s=custom')
  expect(page.url().length).toBeLessThan(300)
  await tab(page, 'Your data')
  await expect(page.locator('.loaded')).toContainText('120 orders, 20 couriers')
  await page.getByRole('button', { name: 'Remove' }).click()
  await expect(page.locator('.loaded')).toHaveCount(0)
  await page.reload()
  await tab(page, 'Your data')
  await expect(page.locator('.loaded')).toHaveCount(0)
})

test('uploaded data runs through the experiment and the sweep', async ({ page }) => {
  await load(page, orders(...Array.from({ length: 40 }, (_, i) => `o${i},${i * 2},10,20,${10.01 + (i % 5) / 500},20,8`)), couriers('C1,0,120,10,20', 'C2,0,120,10.01,20', 'C3,0,120,10.01,20.01'))
  await expect(metric(page, 'Never delivered')).toHaveText(/%/)
  await tab(page, 'Sweep')
  await expect(page.getByRole('button', { name: /^Apply batching weight/ })).toHaveCount(11, { timeout: 60_000 })
  await tab(page, 'Experiment')
  await expect(page.getByText('40 orders a day on average')).toBeVisible({ timeout: 60_000 })
})

test('an uploaded CSV with a BOM, CRLF and quoted cells reads like the pasted one', async ({ page }) => {
  await open(page, 'tab=data&a=greedy.50.50.0&cmp=0')
  const csv = '﻿"id",created,store_lat,store_lng,customer_lat,customer_lng,prep,payout\r\n"o,1",0,10,20,10.04,20,10,9.50\r\n\r\n'
  const inputs = page.locator('input[type=file]')
  await inputs.nth(0).setInputFiles({ name: 'orders.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  await expect(page.getByText('Loaded orders.csv')).toBeVisible()
  await inputs.nth(1).setInputFiles({ name: 'couriers.csv', mimeType: 'text/csv', buffer: Buffer.from('﻿' + ONE_COURIER.replaceAll('\n', '\r\n')) })
  await expect(page.getByText('Loaded couriers.csv')).toBeVisible()
  await page.getByRole('button', { name: 'Load and replay' }).click()
  await expect(metric(page, 'Pay per active hour')).toHaveText('$19.99')
  expect((await stored(page))!.orders[0].id).toBe('o,1')
})

test('JSON: one object with both lists, and a bare array', async ({ page }) => {
  const o = { id: 'o1', created: 0, storeLat: 10, storeLng: 20, customerLat: 10.04, customerLng: 20, prep: 10, payout: 9.5 }
  const c = { id: 'C1', shiftStart: 0, shiftEnd: 60, startLat: 10, startLng: 20 }
  await load(page, JSON.stringify({ orders: [o], couriers: [c] }))
  await expect(metric(page, 'Pay per active hour')).toHaveText('$19.99')
  await page.goto('/')
  await load(page, JSON.stringify([o]), JSON.stringify([c]))
  await expect(metric(page, 'Pay per active hour')).toHaveText('$19.99')
})

test('clock, ISO and epoch times give the same timeline', async ({ page }) => {
  for (const [a, b] of [['18:05', '18:30'], ['2024-03-02T18:05:00Z', '2024-03-02T18:30:00Z'], ['1709402700', '1709404200']]) {
    await page.goto('/')
    await load(page, orders(`a,${a},10,20,10.01,20,5`, `b,${b},10,20,10.01,20,5`))
    await expect(metric(page, 'Never delivered')).toHaveText('0%')
    expect((await stored(page))!.orders.map(o => o.createdAt)).toEqual([0, 25])
  }
})

test('Meituan waybills: one area, recorded delivery times beside the simulated ones', async ({ page }) => {
  await open(page, 'tab=data&cmp=0')
  await page.locator('input[type=file]').first().setInputFiles({ name: 'all_waybill_info_meituan_0322.csv', mimeType: 'text/csv', buffer: Buffer.from(fixtureFile('meituan-waybills.csv')) })
  await page.getByRole('button', { name: 'Load and replay' }).click()
  await expect(page.getByText('Recorded in the imported file')).toContainText('across 39 delivered orders')
  await tab(page, 'Your data')
  await expect(page.locator('.loaded')).toContainText('39 orders, 9 couriers')
})

test('Kaggle food delivery layout loads the busiest market', async ({ page }) => {
  await load(page, fixtureFile('kaggle-food-delivery.csv'))
  await expect(page.locator('.verdict')).toBeVisible()
  expect((await stored(page))!.orders.map(o => o.id)).toEqual(['0x1a01', '0x1a02', '0x1a05', '0x1a08'])
})

test('wrong, empty and truncated input is refused with a message', async ({ page }) => {
  const cases: [string, RegExp][] = [
    ['<!doctype html><html><body>Sign in</body></html>', /No orders found/],
    ['{"orders":[{"id":1,', /Orders:/],
    ['{"orders": 3}', /"orders" array/],
    ['id,created\n1,2', /Order line 2: bad store lat\/lng, customer lat\/lng, prep time/],
    ['id,created,store_lat,store_lng,customer_lat,customer_lng,prep', /No orders found/],
    ['id;created;store_lat\n1;2;3', /Order line 2: bad created time/],
    [orders('a,1,400,20,10,20,5'), /Order line 2: coordinates out of range/],
    [orders('a,1,0,0,10,20,5'), /No valid orders/],
    [orders('a,1,10,20,10.0'), /Order line 2: bad customer lat\/lng, prep time/],
    ['\u0000\u0001PNG\r\n\u001a', /No orders found|bad created time/],
  ]
  await open(page, 'tab=data')
  for (const [text, message] of cases) {
    await ordersBox(page).fill(text)
    await page.getByRole('button', { name: 'Load and replay' }).click()
    await expectRefused(page, message)
  }
  await ordersBox(page).fill(orders(HAND))
  await couriersBox(page).fill('{"couriers":[')
  await page.getByRole('button', { name: 'Load and replay' }).click()
  await expectRefused(page, /Couriers:/)
})

test('limits: too many couriers, and a file over the size limit', async ({ page }) => {
  await open(page, 'tab=data')
  await ordersBox(page).fill(orders(HAND))
  await couriersBox(page).fill(couriers(...Array.from({ length: 801 }, (_, i) => `C${i},0,60,10,20`)))
  await page.getByRole('button', { name: 'Load and replay' }).click()
  await expectRefused(page, /801 couriers is over the 800 limit/)
  await page.locator('input[type=file]').first().setInputFiles({ name: 'big.csv', mimeType: 'text/csv', buffer: Buffer.alloc(12_000_001, 'a') })
  await expect(page.getByText('big.csv is over 12 MB')).toBeVisible()
})

test('markup in ids is shown as text', async ({ page }) => {
  const evil = '<img src=x onerror=document.title=1>'
  await load(page, orders(`${evil},0,10,20,10.04,20,10`), couriers(`${evil},0,60,10,20`))
  await page.getByLabel('Choose a courier').selectOption('a:0')
  await page.getByLabel('Timeline').fill('20')
  await expect(page.locator('.courier-card h3')).toContainText(evil)
  await expect(page.locator('.order-id')).toHaveText(evil)
  expect(await page.title()).toContain('Dispatch Lab')
})
