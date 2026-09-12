import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const violations = result.violations.filter(violation => ['serious', 'critical'].includes(violation.impact ?? ''));
  expect(violations, violations.map(violation => `${violation.id}: ${violation.help}\n${violation.nodes.map(node => node.target.join(' ')).join('\n')}`).join('\n\n')).toEqual([]);
}

test('login, dashboard, and each settings tab have no serious accessibility violations', async ({ page }) => {
  await page.goto('/configure');
  await expect(page.locator('#login-panel')).toBeVisible();
  await expectNoSeriousViolations(page);

  await page.getByLabel('Administrator password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#workspace')).toBeVisible();
  await expectNoSeriousViolations(page);

  await page.getByRole('button', { name: '⚙ Settings' }).click();
  for (const tab of ['Connections', 'Library', 'Access']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expectNoSeriousViolations(page);
  }
});
