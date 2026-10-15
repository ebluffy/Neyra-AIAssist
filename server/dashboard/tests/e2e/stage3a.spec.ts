import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'

const key = 'offline-dashboard-test-key-32-characters'

async function signIn(page: Page) {
  const setup = await page.request.post('/v1/dashboard/auth/setup', { data: { key } })
  expect([200, 409]).toContain(setup.status())
  const response = await page.request.post('/v1/dashboard/auth/login', { data: { key } })
  expect(response.ok()).toBeTruthy()
  const token = (await response.json()).data.session_token as string
  await page.addInitScript((session) => sessionStorage.setItem('neyra_dashboard_session', session), token)
  return token
}

test('memory layers use real offline API data and journal deletion remains available', async ({ page }, testInfo) => {
  const token = await signIn(page)
  const headers = { Authorization: `Bearer ${token}` }
  const reply = await page.request.post('/v1/chat', { headers, data: { text: 'memory-layer-example', platform_user_id: 'layer-user', channel_id: 'layer-channel' } })
  expect(reply.ok()).toBeTruthy()
  await expect.poll(async () => {
    const response = await page.request.get('/v1/memory/diary', { headers })
    return (await response.json()).data.notes.some((note: { source: string }) => note.source === 'turn_diary')
  }).toBeTruthy()
  await page.goto('/memory')
  const shortTab = page.getByRole('tab', { name: 'Короткая память', exact: true })
  await shortTab.click()
  const window = page.locator('details').filter({ hasText: 'layer-channel' })
  await window.locator('summary').click()
  await expect(window).toContainText('memory-layer-example')
  await shortTab.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'Промежуточная память' })).toBeFocused()
  await expect(page.getByText('Я ответила на вопрос в проверочном диалоге.', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Добавить в дневник' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Очистить', exact: true })).toBeVisible()
  const personResponse = await page.request.post('/v1/memory/people', { headers, data: { names: ['Memory layer person'] } })
  expect(personResponse.ok()).toBeTruthy()
  const personId = (await personResponse.json()).data.person.id
  const fact = await page.request.post(`/v1/memory/people/${personId}/facts`, { headers, data: { fact: 'offline-durable-fact' } })
  expect(fact.ok()).toBeTruthy()
  await page.getByRole('tab', { name: 'Долгая память', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Долгая память' })).toBeVisible()
  await expect(page.getByText('offline-durable-fact', { exact: true }).first()).toBeVisible()
  for (const theme of ['light', 'dark']) {
    await page.getByRole('button', { name: theme === 'light' ? 'Светлая тема' : 'Тёмная тема', exact: true }).click()
    await page.evaluate(() => window.scrollTo(0, 0))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    await page.screenshot({ path: path.join('test-results', `${testInfo.project.name}-${theme}-memory.png`), fullPage: true, animations: 'disabled' })
  }
  const created = await page.request.post('/v1/memory/journal', { headers, data: { text: 'offline-reflection-event', title: 'Offline reflection' } })
  expect(created.ok()).toBeTruthy()
  await page.goto('/system')
  await page.getByRole('tab', { name: 'События памяти', exact: true }).click()
  const journal = page.getByRole('region', { name: 'Журнал ядра' })
  await expect(journal.getByText('offline-reflection-event')).toBeVisible()
  await expect(journal.getByRole('textbox')).toHaveCount(0)
  await journal.getByRole('button', { name: /Удалить запись журнала/ }).first().click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByRole('button', { name: 'Удалить', exact: true })).toBeDisabled()
  await dialog.getByRole('textbox').fill('УДАЛИТЬ')
  await dialog.getByRole('button', { name: 'Удалить', exact: true }).click()
  await expect(journal.getByText('offline-reflection-event')).toHaveCount(0)
  await expect(journal.getByRole('button', { name: 'Очистить журнал' })).toBeVisible()
})

test('settings persist through API into the next real offline turn and status', async ({ page }, testInfo) => {
  const token = await signIn(page)
  const headers = { Authorization: `Bearer ${token}` }
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/settings')
  const mode = page.getByRole('combobox', { name: 'Режим общения' })
  await expect(mode).toBeVisible()
  for (const [label, value] of [['Подробно', 'detailed'], ['Технически', 'technical'], ['Без шуток', 'no_jokes'], ['Кратко', 'brief'], ['По persona', 'default']] as const) {
    await mode.click()
    await page.getByRole('option', { name: label, exact: true }).click()
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
    await expect(page.getByText('Режим сохранён и применяется к следующим ответам.')).toBeVisible()
    const config = await page.request.get('/v1/config/runtime', { headers })
    expect((await config.json()).data.values['agent.conversation_mode']).toBe(value)
    const reply = await page.request.post('/v1/chat', { headers, data: { text: `Проверка ${value}`, platform_user_id: 'e2e-user', channel_id: 'e2e-channel' } })
    expect(reply.ok()).toBeTruthy()
    const result = (await reply.json()).data
    expect(result.text).toContain(`Режим: ${value}`)
    expect(result.model_trace.calls.some((call: { lane: string }) => call.lane === 'talk')).toBeTruthy()
  }
  await page.reload()
  await expect(mode).toContainText('По persona')
  for (const theme of ['light', 'dark']) {
    await page.getByRole('combobox', { name: 'Тема', exact: true }).selectOption(theme)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await page.evaluate(() => window.scrollTo(0, 0))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
    await page.screenshot({ path: path.join('test-results', `${testInfo.project.name}-${theme}-settings.png`), fullPage: true })
  }
  await mode.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('listbox')).toBeVisible()
  await expect(page.getByRole('option', { name: 'По persona', exact: true })).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByRole('option', { name: 'Без шуток', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(mode).toContainText('Без шуток')
  await page.getByRole('button', { name: 'Отменить', exact: true }).click()
  await expect(mode).toContainText('По persona')

  await page.goto('/status')
  const activity = page.getByRole('region', { name: 'Последние вызовы' })
  await expect(activity.getByText('reported-offline-talk', { exact: true }).first()).toBeVisible()
  await expect(activity.getByText('configured-offline-talk', { exact: true }).first()).toBeVisible()
  for (const theme of ['light', 'dark']) {
    await page.getByRole('button', { name: theme === 'light' ? 'Светлая тема' : 'Тёмная тема', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
    await page.screenshot({ path: path.join('test-results', `${testInfo.project.name}-${theme}-activity.png`), fullPage: true })
  }
  expect(errors).toEqual([])
})

test('save errors keep the mode and the actual ops API remains available', async ({ page }) => {
  const token = await signIn(page)
  const headers = { Authorization: `Bearer ${token}` }
  await page.goto('/settings')
  const mode = page.getByRole('combobox', { name: 'Режим общения' })
  await mode.click()
  await page.getByRole('option', { name: 'Технически', exact: true }).click()
  await page.route('**/v1/config/update', (route) => route.fulfill({ status: 500, json: { ok: false, error: { message: 'Проверочная ошибка сохранения' } } }))
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.locator('#conversation-mode-error')).toContainText('Проверочная ошибка сохранения')
  await expect(mode).toContainText('Технически')
  await expect(mode).toHaveAttribute('aria-invalid', 'true')
  await page.unroute('**/v1/config/update')
  await page.getByRole('button', { name: 'Отменить', exact: true }).click()

  await page.goto('/modules')
  await page.getByText('Offline example', { exact: true }).first().click()
  const enabled = page.getByRole('switch', { name: 'Включить или выключить модуль' })
  await expect(enabled).toBeChecked()
  await enabled.click()
  await expect(enabled).not.toBeChecked()
  await enabled.click()
  await expect(enabled).toBeChecked()
  await page.getByRole('button', { name: 'Вызвать', exact: true }).click()

  const people = await page.request.post('/v1/memory/people', { headers, data: { names: ['Offline test person'] } })
  expect(people.ok()).toBeTruthy()
  await page.goto('/memory')
  await expect(page.getByRole('heading', { name: 'Память', exact: true })).toBeVisible()
  const backup = await page.request.post('/v1/backup/run', { headers, data: {} })
  expect(backup.ok()).toBeTruthy()
  await page.goto('/system')
  await expect(page.getByRole('heading', { name: 'Система', exact: true })).toBeVisible()
  const restart = await page.request.post('/v1/system/restart', { headers, data: {} })
  expect(restart.ok()).toBeTruthy()
})
