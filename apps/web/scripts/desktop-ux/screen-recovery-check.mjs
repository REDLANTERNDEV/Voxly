import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
const browser=await chromium.launch({headless:true,...(process.env.VOXLY_TEST_BROWSER_PATH?{executablePath:process.env.VOXLY_TEST_BROWSER_PATH}:{})});
try { for (const frameCallbacks of [true,false]) {
 const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 if (!frameCallbacks) await page.addInitScript(()=>{HTMLVideoElement.prototype.requestVideoFrameCallback=undefined;});
 await page.goto('http://127.0.0.1:1422/features.html');
 await page.waitForFunction(()=>Boolean(window.screenRecoveryFixture));
 await page.evaluate(()=>window.screenRecoveryFixture.start());
 const fixture=page.locator('#recovery-fixture');
 await expect(fixture.locator('video')).toBeVisible();
 await page.waitForFunction(()=>window.screenRecoveryFixture.status()==='ready');
 await page.waitForFunction(()=>{
   const canvas=document.querySelector('#recovery-fixture canvas');
   const pixel=canvas.getContext('2d').getImageData(100,100,1,1).data;
   return pixel[0]>240&&pixel[1]<10&&pixel[2]<10;
 });
 await page.evaluate(()=>window.screenRecoveryFixture.disconnect());
 await expect(fixture.locator('canvas')).toBeVisible();
 await expect(fixture.locator('.screen-stage-placeholder')).toHaveCount(0);
 await expect(fixture.locator('[role=status]')).toHaveCount(0);
 const picture=await fixture.locator('canvas').evaluate(canvas=>({width:canvas.width,height:canvas.height,pixel:Array.from(canvas.getContext('2d').getImageData(100,100,1,1).data)}));
 assert.equal(picture.width,1280);assert.equal(picture.height,720);assert.ok(picture.pixel[0]>240&&picture.pixel[1]<10&&picture.pixel[2]<10);
 await page.evaluate(()=>window.screenRecoveryFixture.tick(4999));
 await expect(fixture.locator('[role=status]')).toHaveCount(0);
 await page.evaluate(()=>window.screenRecoveryFixture.disconnect());
 await page.evaluate(()=>window.screenRecoveryFixture.tick(5000));
 await expect(fixture.locator('[role=status]')).toHaveText('Reconnecting…');
 await page.evaluate(()=>window.screenRecoveryFixture.language('tr'));
 await expect(fixture.locator('[role=status]')).toHaveText('Yeniden bağlanıyor…');
 await page.evaluate(()=>window.screenRecoveryFixture.start('#0000ff'));
 await expect(fixture.locator('video')).toBeVisible();
 await expect(fixture.locator('canvas')).toBeHidden();
 await expect(fixture.locator('[role=status]')).toHaveCount(0);
 await page.evaluate(()=>window.screenRecoveryFixture.unwatch());
 await expect(fixture.locator('canvas')).toHaveCount(0);
 await expect(fixture.locator('video')).toHaveCount(0);
 assert.deepEqual(errors,[]);
 console.log(`Retained 720p picture; five-second overlay in both languages; repeated repair keeps deadline; decoded replacement and Unwatch clear retention; frame callbacks=${frameCallbacks}.`);
 await page.close();
 }
} finally {await browser.close();}
