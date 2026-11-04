const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch({...(process.env.CHROME?{executablePath:process.env.CHROME}:{}),args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
const ctx=await b.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});await ctx.grantPermissions(['microphone']);
const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.goto(''+(process.env.BASE||'http://localhost:8790')+'/');await p.evaluate(()=>localStorage.clear());await p.reload();await p.waitForTimeout(1500);
const r=await p.evaluate(()=>{const g=s=>document.querySelector(s).getBoundingClientRect();const m=g('.mic-fab'),f=g('.fab'),t=g('.tabbar');return {mic:[m.x+m.width/2,m.width,m.bottom],vw:innerWidth,fab:[f.left,f.right,f.top],tabTop:t.top,overlapFab:!(m.right<f.left||m.left>f.right||m.bottom<f.top||m.top>f.bottom)}});
console.log(JSON.stringify(r));
await p.tap('.mic-fab');await p.waitForTimeout(400);console.log('toast:',await p.textContent('#toast'));
await p.screenshot({path:'mic_mob.png'});
// أضف 400 مهمة وقس فتح المهمة
await p.evaluate(()=>document.querySelector('#dlg [data-v=cancel]')?.click());
await p.evaluate(async()=>{const m=await import('/js/model.js');for(let i=0;i<400;i++)m.createTask({title:'مهمة '+i,important:i%3==0,due:null});});
await p.goto(''+(process.env.BASE||'http://localhost:8790')+'/#/all');await p.waitForTimeout(800);
const o=await p.evaluate(async()=>{const el=document.querySelector('li.t .tm, .tm');const t0=performance.now();el.click();await new Promise(r=>{const f=()=>document.querySelector('.pomo-go, .pane-in')?r():requestAnimationFrame(f);f()});return Math.round(performance.now()-t0)});
console.log('open task ms (400 tasks):',o);console.log(errs);await b.close()})();
