import type { Page } from '@playwright/test'

const PLACES = [{ name: 'Testville', display_name: 'Testville, Test County, Testland', lat: '50.0000', lon: '10.0000' }]

/** A small made-up grid of streets with restaurants on it, in the shape Overpass answers. */
export function overpass(stores = 30) {
  const at = (i: number) => 50 + (i - 12) * 0.0015
  const lng = (i: number) => 10 + (i - 12) * 0.002
  const elements: object[] = []
  for (let i = 0; i < 25; i++) {
    const line = (f: (j: number) => object) => Array.from({ length: 25 }, (_, j) => f(j))
    elements.push({ type: 'way', tags: { highway: 'residential' }, geometry: line(j => ({ lat: at(i), lon: lng(j) })) })
    elements.push({ type: 'way', tags: { highway: 'residential' }, geometry: line(j => ({ lat: at(j), lon: lng(i) })) })
  }
  for (let i = 0; i < stores; i++) elements.push({ type: 'node', lat: at(i % 25), lon: lng((i * 7) % 25), tags: { amenity: 'restaurant' } })
  return { elements }
}

export async function stub(page: Page, answers: { status?: number; json: object }[]) {
  const hits: string[] = []
  await page.route('https://nominatim.openstreetmap.org/**', r => r.fulfill({ json: PLACES, headers: { 'access-control-allow-origin': '*' } }))
  await page.route(/overpass/, r => {
    hits.push(new URL(r.request().url()).host)
    const a = answers[Math.min(hits.length, answers.length) - 1]
    return r.fulfill({ status: a.status ?? 200, json: a.json, headers: { 'access-control-allow-origin': '*' } })
  })
  return hits
}

export async function searchCity(page: Page) {
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await page.getByLabel('City or neighbourhood').fill('Testville')
  await page.getByRole('button', { name: 'Find' }).click()
  await page.getByRole('button', { name: /Testville/ }).click()
}
