import assert from 'node:assert/strict';

// Run with the documented CUA tab and viewport API, against disposable fixtures.
export async function checkStreamHierarchy(tab, base='http://127.0.0.1:1422') {
  await tab.goto(`${base}/implementation.html?screen=voice`);
  await tab.playwright.domSnapshot();
  assert.equal(await tab.playwright.getByRole('region',{name:'Music',exact:true}).count(),0);
  assert.equal(await tab.playwright.locator('video').count(),0);
  await tab.playwright.getByRole('button',{name:'Watch stream — Alex'}).click();
  await tab.playwright.getByRole('region',{name:'Stage',exact:true}).waitFor({state:'visible'});
  assert.match(await tab.playwright.getByRole('status').filter({hasText:'subscriptions:'}).textContent(),/Joined · subscriptions: 1/);
  await tab.playwright.getByRole('button',{name:'Fullscreen',exact:true}).click();
  await tab.playwright.getByRole('button',{name:'Exit full screen',exact:true}).last().waitFor({state:'visible'});
  await tab.playwright.getByRole('region',{name:'Stage',exact:true}).getByRole('button',{name:'Exit full screen',exact:true}).first().click();
  await tab.playwright.getByRole('button',{name:'Fullscreen',exact:true}).waitFor({state:'visible'});
  assert.match(await tab.playwright.getByRole('status').filter({hasText:'subscriptions:'}).textContent(),/subscriptions: 1/);
  await tab.playwright.getByLabel('Stream volume',{exact:true}).click();
  await tab.playwright.getByRole('slider',{name:'Stream volume'}).waitFor({state:'visible'});
  assert.equal(await tab.playwright.getByRole('region',{name:'Stage',exact:true}).count(),1);
  await tab.playwright.getByRole('button',{name:'Fullscreen',exact:true}).click();
  await tab.playwright.getByRole('button',{name:'Exit full screen',exact:true}).last().press('Escape');
  await tab.playwright.getByRole('button',{name:'Fullscreen',exact:true}).waitFor({state:'visible'});
  assert.match(await tab.playwright.getByRole('status').filter({hasText:'subscriptions:'}).textContent(),/subscriptions: 1/);
  await tab.playwright.getByRole('region',{name:'Stage',exact:true}).getByRole('button',{name:'Remove Alex from stage'}).click();
  await tab.playwright.getByRole('button',{name:'Watch stream — Alex'}).waitFor({state:'visible'});
  assert.match(await tab.playwright.getByRole('status').filter({hasText:'subscriptions:'}).textContent(),/subscriptions: 0/);
  await tab.playwright.getByRole('button',{name:'Watch stream — Alex'}).click();
  await tab.playwright.getByRole('button',{name:'Return to stream box'}).click();
  await tab.playwright.getByRole('button',{name:'Watch stream — Alex'}).waitFor({state:'visible'});
  await tab.playwright.getByRole('button',{name:'Watch stream — Alex'}).click();
  await tab.playwright.getByRole('button',{name:'End source'}).click();
  await tab.playwright.getByRole('region',{name:'Stage',exact:true}).waitFor({state:'detached'});
  assert.match(await tab.playwright.getByRole('status').filter({hasText:'subscriptions:'}).textContent(),/subscriptions: 0/);
  await tab.goto(`${base}/implementation.html?screen=voice&failJoin`);
  await tab.playwright.getByRole('button',{name:'Watch stream — Alex'}).click();
  await tab.playwright.getByText('That source is no longer available.',{exact:true}).waitFor({state:'visible'});
  assert.equal(await tab.playwright.getByRole('region',{name:'Stage',exact:true}).count(),0);
  assert.match(await tab.playwright.getByRole('status').filter({hasText:'subscriptions:'}).textContent(),/Outside · subscriptions: 0/);
  return 'Watch → stage → fullscreen → stage → box; Escape, volume, source removal, and failed joins';
}

export async function checkAccountEntry(tab,viewport,base='http://127.0.0.1:1422') {
  const screenshots=[];
  for (const width of [390,1280]) {
    await viewport.set({width,height:900});
    for (const language of ['en','tr']) {
      for (const screen of ['invite','owner-claim','access-claim','link','recover','approval']) {
        await tab.goto(`${base}/implementation.html?screen=${screen}&lang=${language}`);
        await tab.playwright.domSnapshot();
        await tab.playwright.locator('.account-entry').waitFor({state:'visible'});
        const layout=await tab.playwright.locator('.account-entry-shell').evaluate(el=>({
          width:el.getBoundingClientRect().width,left:el.getBoundingClientRect().left,
          right:el.getBoundingClientRect().right,page:document.documentElement.scrollWidth,viewport:innerWidth
        }));
        assert.ok(layout.left>=0&&layout.right<=layout.viewport,`${screen}/${language}/${width} frame overflows`);
        assert.ok(layout.page<=layout.viewport,`${screen}/${language}/${width} page overflows`);
        assert.equal(await tab.playwright.locator('.auth-page-header').count(),1);
        screenshots.push({name:`${screen}-${language}-${width}`,bytes:await tab.screenshot({fullPage:true})});
      }
    }
  }
  await viewport.reset();
  return screenshots;
}
