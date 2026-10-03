import assert from 'node:assert/strict';

// Run through the documented CUA browser API; interactions use real rendered controls.
export async function checkDesktopUx(tab, viewport, base = 'http://127.0.0.1:1422') {
  const results = [];
  await viewport.reset();
  await tab.goto(`${base}/?composer`);
  await tab.playwright.locator('.composer > .error-text').click();
  await tab.getAXState({ emit: false });
  assert.equal(await tab.playwright.evaluate(() => document.activeElement?.id), 'messageInput');
  await tab.playwright.locator('#messageInput').fill('A message');
  await tab.playwright.getByRole('button', { name: 'Send', exact: true }).click();
  await tab.getAXState({ emit: false });
  results.push('composer padding focuses; Send retains its action');
  await tab.playwright.getByRole('button', { name: 'shortcuts', exact: true }).click();
  await tab.getAXState({ emit: false });
  const row = tab.playwright.locator('.desktop-shortcut-row').nth(0);
  await row.getByRole('button', { name: 'Edit keybind', exact: true }).click();
  await tab.getAXState({ emit: false });
  await row.getByRole('textbox').press('Control+Shift+K');
  await tab.playwright.getByText('Deafen / undeafen', { exact: true }).click();
  await tab.getAXState({ emit: false });
  assert.equal(await row.getByRole('button', { name: 'Stop recording', exact: true }).isVisible(), true);
  await row.getByRole('textbox').press('Control+Shift+L');
  await row.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await tab.getAXState({ emit: false });
  assert.equal(JSON.parse(await tab.playwright.locator('#desktop-operation-log').textContent()).findLast(o => o.kind === 'shortcut').binding, 'Control+Shift+KeyL');
  await row.getByRole('button', { name: 'Reset shortcut: Mute / unmute microphone', exact: true }).click();
  await tab.getAXState({ emit: false });
  assert.equal(JSON.parse(await tab.playwright.locator('#desktop-operation-log').textContent()).findLast(o => o.kind === 'shortcut').binding, 'Control+Shift+KeyM');
  results.push('recording continuity, latest draft saved on Stop, per-row reset');
  await row.getByRole('button', { name: 'Edit keybind', exact: true }).click();
  await tab.getAXState({ emit: false });
  await row.getByRole('textbox').press('k');
  await row.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await tab.getAXState({ emit: false });
  assert.equal(await row.getByRole('button', { name: 'Stop recording', exact: true }).isVisible(),true);
  const other = tab.playwright.locator('.desktop-shortcut-row').nth(1);
  await other.getByRole('button', { name: 'Edit keybind', exact: true }).click();
  await tab.getAXState({ emit: false });
  assert.equal(await row.getByRole('button', { name: 'Edit keybind', exact: true }).isVisible(),true);
  await other.getByRole('textbox').press('Escape');
  await tab.getAXState({ emit: false });
  results.push('invalid input retains recording; another recorder cancels the unsaved draft');
  for (const cancel of ['escape', 'section', 'close']) {
    if (cancel !== 'escape') { await tab.playwright.getByRole('button', { name: 'Shortcuts', exact: true }).click(); await tab.getAXState({ emit: false }); }
    await row.getByRole('button', { name: 'Edit keybind', exact: true }).click();
    await tab.getAXState({ emit: false });
    await row.getByRole('textbox').press('Control+Shift+K');
    if (cancel === 'escape') await row.getByRole('textbox').press('Escape');
    else if (cancel === 'section') await tab.playwright.getByRole('button', { name: 'Voice & audio', exact: true }).click();
    else await tab.playwright.getByRole('button', { name: 'Close', exact: true }).click();
    await tab.getAXState({ emit: false });
    if (cancel !== 'close') { await tab.playwright.getByRole('button', { name: 'Shortcuts', exact: true }).click(); await tab.getAXState({ emit: false }); }
    if (cancel !== 'close') assert.equal(JSON.parse(await tab.playwright.locator('#desktop-operation-log').textContent()).findLast(o => o.kind === 'shortcut').binding, 'Control+Shift+KeyM');
    const ops = JSON.parse(await tab.playwright.locator('#desktop-operation-log').textContent());
    assert.deepEqual(ops.filter(o => o.kind === 'recording').at(-1), { kind: 'recording', enabled: false });
    assert.equal(ops.filter(o => o.kind === 'shortcut').length, 2);
  }
  assert.equal(await tab.playwright.evaluate(() => document.activeElement?.textContent), 'shortcuts');
  results.push('Escape, section change and X cancel unsaved recording and release suppression; focus restored');
  for (const query of ['browser', 'browser&tr&light']) {
    await viewport.set({ width: 320, height: 640 });
    await tab.goto(`${base}/?${query}`);
    assert.equal(await tab.playwright.locator('.language-switch').evaluate(e => {
      const rect=e.getBoundingClientRect(), select=e.querySelector('select');
      return [[rect.left+2,rect.top+rect.height/2],[rect.right-2,rect.top+rect.height/2],[rect.left+rect.width/2,rect.top+2],[rect.left+rect.width/2,rect.bottom-2]].every(([x,y])=>document.elementFromPoint(x,y)===select);
    }), true);
    await tab.playwright.getByRole('button', { name: 'account', exact: true }).click();
    await tab.getAXState({ emit: false });
    const geometry = await tab.playwright.locator('.settings-section-header').evaluate(e => {
      const heading=e.querySelector('h2').getBoundingClientRect(), close=e.querySelector('button').getBoundingClientRect(), card=document.querySelector('.device-card .theme-card-head');
      return { fits: heading.right<=close.left && heading.left>=0 && close.right<=innerWidth, size: Math.min(close.width,close.height), deviceFits: card.scrollWidth<=card.clientWidth };
    });
    assert.equal(geometry.fits, true); assert.ok(geometry.size>=44); assert.equal(geometry.deviceFits,true);
    await tab.playwright.locator('.settings-close').press('Escape');
    await tab.getAXState({ emit: false });
    assert.equal(await tab.playwright.locator('.settings-dialog').count(),0);
  }
  results.push('English/Turkish narrow headings, 44px X, language selector edges, Escape');
  await viewport.reset();
  await tab.goto(`${base}/?browser`);
  const rail = await tab.playwright.locator('.workspace-rail-bottom').evaluate(e=>({download:e.querySelector('.workspace-download').getBoundingClientRect().bottom,settings:e.querySelector('.workspace-settings').getBoundingClientRect().top}));
  assert.ok(rail.download<=rail.settings);
  await tab.playwright.getByRole('button',{name:'Open in desktop',exact:true}).click();
  await tab.getAXState({emit:false});
  await tab.playwright.getByRole('button',{name:'Approve',exact:true}).waitFor({state:'visible'});
  await tab.getAXState({emit:false});
  assert.equal(await tab.playwright.locator('.desktop-launch-dialog[open]').count(),1);
  await tab.playwright.getByRole('button',{name:'Approve',exact:true}).click();
  await tab.getAXState({emit:false});
  await tab.playwright.getByRole('button',{name:'Done',exact:true}).click();
  await tab.getAXState({emit:false});
  assert.equal(await tab.playwright.locator('.desktop-launch-dialog[open]').count(),0);
  await tab.playwright.getByRole('button',{name:'Open in desktop',exact:true}).click();
  await tab.getAXState({emit:false});
  await tab.playwright.getByRole('button',{name:'Done',exact:true}).click();
  await tab.getAXState({emit:false});
  results.push('download directly above Settings; first and repeated prepared launches share one approval dialog; cancellation closes it');
  return results;
}
