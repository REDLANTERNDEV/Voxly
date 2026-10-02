import assert from 'node:assert/strict';

// Exercise the actual shell, composer and dock together through the CUA API.
export async function checkDockComposer(tab, viewport, sizes, base = 'http://127.0.0.1:1422', extraQuery = '') {
  const results = [];
  try {
    for (const size of sizes) {
      await viewport.set(size);
      for (const query of ['browser&dock', 'dock&tr&light&windows']) {
        await tab.goto(`${base}/?${query}${extraQuery}`);
        await tab.getAXState({ emit: false });
        for (const state of ['idle', 'joined', 'left']) {
          if (state !== 'idle') {
            await tab.playwright.getByRole('button', { name: state === 'joined' ? 'Fixture join voice' : 'Fixture leave voice', exact: true }).click();
            await tab.getAXState({ emit: false });
          }
          if (size.width > 900) {
            const geometry = await tab.playwright.evaluate(() => {
              const panel = document.querySelector('.main-panel').getBoundingClientRect();
              const dock = document.querySelector('.dock-controls');
              return { bottom: panel.bottom, windowHeight: innerHeight, quiet: !dock.children.length,
                hidden: getComputedStyle(dock).visibility === 'hidden' };
            });
            assert.equal(geometry.quiet, state !== 'joined');
            assert.equal(geometry.hidden, state !== 'joined');
            if (geometry.quiet) assert.ok(geometry.bottom >= geometry.windowHeight - 12, 'Quiet chat must retain its original bottom alignment');
          }
          if (state === 'idle') {
            await tab.playwright.locator('.account-menu > summary').click();
            await tab.getAXState({ emit: false });
            assert.equal(await tab.playwright.locator('.account-settings-link').isVisible(), true);
            const reachable = await tab.playwright.locator('.account-settings-link').evaluate(element => {
              const r = element.getBoundingClientRect();
              return element.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
            });
            assert.equal(reachable, true, 'Quiet dock must keep account settings reachable');
            await tab.playwright.locator('.account-menu > summary').click();
            await tab.getAXState({ emit: false });
          }
          if (extraQuery.includes('reply')) {
            await tab.playwright.locator('.message-reply-trigger').click();
            await tab.getAXState({ emit: false });
            assert.equal(await tab.playwright.locator('.composer-reply').count(), 1);
          }
          for (const draft of ['', 'First line\nSecond line\nThird line']) {
            await tab.playwright.locator('#messageInput').fill(draft);
            await tab.getAXState({ emit: false });
            const points = await tab.playwright.evaluate(() => {
              const field = document.querySelector('#messageInput'), r = field.getBoundingClientRect();
              const composer = document.querySelector('.composer'), c = composer.getBoundingClientRect();
              const points = [[r.left + 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.top + 2], [c.left + c.width / 2, c.bottom - 3]];
              for (const [x, y] of points) {
                const hit = document.elementFromPoint(x, y);
                if (!hit || !composer.contains(hit)) throw new Error(`Composer covered at ${x},${y} by ${hit?.className}`);
              }
              return points;
            });
            for (const point of points) {
              await tab.playwright.getByRole('button', { name: state === 'joined' ? 'Fixture leave voice' : 'Fixture join voice', exact: true }).press('Tab');
              await tab.getAXState({ emit: false });
              await tab.click(point);
              await tab.getAXState({ emit: false });
              assert.equal(await tab.playwright.evaluate(() => document.activeElement?.id), 'messageInput');
            }
          }
          await tab.playwright.locator('#messageInput').fill('A message');
          await tab.playwright.getByRole('button', { name: query.includes('tr') ? 'Gönder' : 'Send', exact: true }).click();
          await tab.getAXState({ emit: false });
          assert.equal(await tab.playwright.locator('#messageInput').evaluate(e => e.value), '');
          results.push(`${size.width}x${size.height} ${query} ${state}`);
        }
      }
    }
    return results;
  } finally { await viewport.reset(); }
}
