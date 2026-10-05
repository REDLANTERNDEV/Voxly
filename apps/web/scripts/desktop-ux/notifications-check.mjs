import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createVoxlyApp} from '../../../server/dist/src/app.js';
import {createSession} from '../../../server/dist/src/auth/sessions.js';
const app=await createVoxlyApp({databasePath:':memory:',ownerBootstrapToken:'fixture-bootstrap',allowHttpOwnerBootstrap:true,secureCookies:false,webDistPath:resolve('apps/web/dist')});
const browser=await chromium.launch({headless:true,...(process.env.VOXLY_TEST_BROWSER_PATH?{executablePath:process.env.VOXLY_TEST_BROWSER_PATH}:{}),args:['--autoplay-policy=no-user-gesture-required']});
try{
  await app.server.listen({host:'127.0.0.1',port:0});const base=`http://127.0.0.1:${app.server.server.address().port}`;
  const jar=response=>Object.fromEntries(response.cookies.map(cookie=>[cookie.name,cookie.value]));
  const bootstrap=await app.server.inject({method:'POST',url:'/api/bootstrap/owner',payload:{bootstrapToken:'fixture-bootstrap',nickname:'Owner'}});assert.equal(bootstrap.statusCode,201);const owner=jar(bootstrap);
  const invite=await app.server.inject({method:'POST',url:'/api/owner/invites',cookies:owner,payload:{label:'Browser test'}});
  const joined=await app.server.inject({method:'POST',url:'/api/invites/accept',payload:{inviteToken:invite.json().invite.token,nickname:'Reader'}});assert.equal(joined.statusCode,201);
  const tokens=[jar(joined).voxly_session,createSession({sqlite:app.sqlite,save(){},close(){}},joined.json().user.id,'Second browser Device')];
  const createRoom=async name=>{const response=await app.server.inject({method:'POST',url:'/api/servers/the-basement/rooms',cookies:owner,payload:{name,kind:'text'}});assert.equal(response.statusCode,201);return response.json().room.id;};
  const news=await createRoom('news'),other=await createRoom('other');
  const post=async room=>{const response=await app.server.inject({method:'POST',url:`/api/rooms/${room}/messages`,cookies:owner,payload:{body:'Unread browser check'}});assert.equal(response.statusCode,201);return response.json().message;};
  const pages=[];
  for(const token of tokens){
    const context=await browser.newContext({viewport:{width:1280,height:800}});await context.addCookies([{name:'voxly_session',value:token,url:base}]);
    await context.addInitScript(()=>{window.messageSoundAttempts=[];HTMLMediaElement.prototype.play=function(){if(this.src?.includes('/sounds/message'))window.messageSoundAttempts.push(this.src);return Promise.resolve();};});
    const page=await context.newPage();await page.goto(`${base}/app/server/the-basement/text/general`);await page.locator('.server-avatar').waitFor();pages.push(page);
  }
  const badge=page=>page.locator('.server-avatar .server-unread-badge');
  for(let i=0;i<10;i++)await post(news);await post(other);
  for(const page of pages)await expect(badge(page)).toHaveText('9+');
  await pages[0].bringToFront();await pages[0].goto(`${base}/app/server/the-basement/text/${news}`);await pages[0].locator('.server-avatar').waitFor();
  for(const page of pages)await expect(badge(page)).toHaveText('1');
  // Headless Chromium reports every context focused: emulate a blurred Device explicitly.
  await pages[0].evaluate(()=>{Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>false});window.dispatchEvent(new Event('blur'));});
  await expect.poll(()=>pages[0].evaluate(()=>document.hasFocus())).toBe(false);
  await pages[1].bringToFront();await post(news);
  for(const page of pages)await expect(badge(page)).toHaveText('2');
  await pages[1].locator('.server-avatar').click({button:'right'});await pages[1].getByRole('button',{name:'Mute message notifications',exact:true}).hover();
  await pages[1].getByRole('menuitem',{name:'Until I turn them back on',exact:true}).click();
  for(const page of pages)await expect(badge(page)).toHaveCount(0);
  const before=await pages[1].evaluate(()=>window.messageSoundAttempts.length);await post(news);
  await expect.poll(async()=>{const response=await app.server.inject({method:'GET',url:'/api/notifications',cookies:{voxly_session:tokens[1]}});return response.json().servers[0].rooms.find(room=>room.roomId===news).unreadCount;}).toBe(2);
  const snapshots=await Promise.all(tokens.map(token=>app.server.inject({method:'GET',url:'/api/notifications',cookies:{voxly_session:token}})));
  assert.ok(snapshots.every(response=>response.json().servers[0].mute.mode==='indefinite'));
  await pages[1].locator('.server-avatar').click({button:'right'});await pages[1].getByRole('button',{name:'Unmute message notifications',exact:true}).click();
  for(const page of pages)await expect(badge(page)).toHaveText('3');
  assert.equal(await pages[1].evaluate(()=>window.messageSoundAttempts.length),before,'Mute and backlog restoration must not play message cues');
  await pages[1].reload();await expect(badge(pages[1])).toHaveText('3');
  await pages[1].route('**/api/servers/the-basement/notification-settings',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"fixture_unavailable"}'}));
  await pages[1].locator('.server-avatar').click({button:'right'});await pages[1].getByRole('button',{name:'Mute message notifications',exact:true}).hover();
  await pages[1].getByRole('menuitem',{name:'For 1 hour',exact:true}).click();
  await expect(pages[1].locator('.workspace-switch-error')).toContainText('could not be saved');await expect(badge(pages[1])).toHaveText('3');
  await pages[1].unroute('**/api/servers/the-basement/notification-settings');
  await pages[1].route(`**/api/rooms/${other}/messages?*`,route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"fixture_unavailable"}'}));
  await pages[1].goto(`${base}/app/server/the-basement/text/${other}`);await pages[1].locator('.server-avatar').waitFor();await expect(badge(pages[1])).toHaveText('3');
  const failed=await app.server.inject({method:'GET',url:'/api/notifications',cookies:{voxly_session:tokens[1]}});assert.equal(failed.json().servers[0].rooms.find(room=>room.roomId===other).unreadCount,1);
  console.log('Notification browser checks passed: 9+, per-channel clearing, two Devices, background unread, mute/backlog, reload, failed writes, failed history.');
}finally{await browser.close();await app.close();}
