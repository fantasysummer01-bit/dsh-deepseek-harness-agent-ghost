// Optional visual QA. Use the bundled Playwright module and an existing Edge.
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.GHOST_PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({ headless: true, executablePath: process.env.GHOST_BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:8768/');
  await page.getByRole('heading', { name: '基本设置', exact: true }).waitFor();
  await page.locator('input[maxlength="64"]').fill('Ghost Demo');
  await page.getByLabel('记录后续可见消息', { exact: false }).check();
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.getByText('已保存，状态变更已写入本地账本。', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: '检索已保存记忆' }).fill('公园');
  await page.getByRole('button', { name: '检索', exact: true }).click();
  await page.getByText('今天在公园看到一只猫，旁边有一家咖啡店。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '校验状态', exact: true }).click();
  await page.getByText('校验通过：账本、检查点与当前状态一致。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '创建检查点', exact: true }).click();
  await page.getByText('已创建并校验检查点。', { exact: true }).waitFor();
  await page.getByRole('heading', { name: '检查点与恢复', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'preview/continuity.png', fullPage: true });
  await page.setViewportSize({ width: 590, height: 850 });
  await page.reload();
  await page.getByRole('heading', { name: '基本设置', exact: true }).waitFor();
  await page.screenshot({ path: 'preview/narrow.png', fullPage: true });
  const scrollWidth = await page.locator('body').evaluate(element => element.scrollWidth);
  if (errors.length || scrollWidth > 590) throw new Error(JSON.stringify({ errors, scrollWidth }));
  console.log(JSON.stringify({ errors, narrowScrollWidth: scrollWidth, viewport: 590, checks: ['edit/save', 'capture opt-in', 'evidence search', 'verify', 'checkpoint', 'narrow layout'] }));
} finally { await browser.close(); }
