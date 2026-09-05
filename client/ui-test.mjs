import { chromium } from 'playwright'
const errs = []
const b = await chromium.launch({ executablePath: '/Users/piyuzz/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell' })
// two contexts = two independent tabs/identities
const c1 = await b.newContext({ viewport: { width: 1440, height: 900 } })
const c2 = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
const p1 = await c1.newPage(), p2 = await c2.newPage()
for (const [n, p] of [['tab1', p1], ['tab2', p2]]) {
  p.on('console', m => { if (m.type() === 'error') errs.push(`${n} console: ${m.text()}`) })
  p.on('pageerror', e => errs.push(`${n} pageerror: ${e.message}`))
}
await p1.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await p2.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await p1.waitForTimeout(3000)
await p1.screenshot({ path: process.env.SP + '/01-landing-desktop.png', fullPage: true })
await p2.screenshot({ path: process.env.SP + '/02-landing-mobile.png', fullPage: true })
console.log('landing badge:', await p1.locator('.micro-label').first().textContent())
// enter both rooms
await p1.getByRole('button', { name: /Watch a live room/ }).click()
await p2.getByRole('button', { name: /Watch a live room/ }).click()
await p1.waitForTimeout(4000)
console.log('tab1 presence:', (await p1.locator('section').first().innerText()).replace(/\n/g,' | ').slice(0,220))
await p1.screenshot({ path: process.env.SP + '/03-room-desktop.png', fullPage: true })
await p2.screenshot({ path: process.env.SP + '/04-room-mobile.png', fullPage: true })
// tab1 clicks the one-click demo; tab2 must paint without touching anything
const deep = p1.getByRole('button', { name: /Run the deepest one/ })
if (await deep.count()) { await deep.click(); console.log('clicked deepest') }
else { await p1.locator('ul li button').nth(2).click(); console.log('clicked list item') }
for (const t of [1200, 1500, 1500, 2000, 2500]) {
  await p1.waitForTimeout(t)
}
await p1.screenshot({ path: process.env.SP + '/05-walk-desktop.png', fullPage: true })
await p2.screenshot({ path: process.env.SP + '/06-walk-mobile-watching.png', fullPage: true })
const t2 = await p2.innerText('body')
console.log('--- TAB2 (never clicked) sees ---')
console.log(t2.replace(/\n{2,}/g, '\n').slice(0, 1400))
console.log('--- errors ---'); console.log(errs.slice(0, 12).join('\n') || 'none')
await b.close()
