// الاتزان: العجلة والتقييم، الرؤى، خطوة لأضعف مجال، لافتة اليوم، «عالق؟»، الحد الأدنى، الجوال، وaxe.
// BASE=http://localhost:8790 node tests/balance.js
const {chromium}=require('playwright');
let pass=0,fail=0;const ok=(n,c,x)=>{if(c){pass++;console.log('PASS',n)}else{fail++;console.log('FAIL',n,x===undefined?'':JSON.stringify(x))}};
const BASE=process.env.BASE||'http://localhost:8790';
(async()=>{
 const b=await chromium.launch({...(process.env.CHROME?{executablePath:process.env.CHROME}:{})});
 const ctx=await b.newContext({viewport:{width:1440,height:900}});
 const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
 await p.goto(BASE+'/');await p.evaluate(()=>localStorage.clear());await p.reload();await p.waitForTimeout(700);
 const D=()=>p.evaluate(()=>JSON.parse(localStorage.getItem('cc:data:v1')));
 const fl=()=>p.waitForTimeout(300);
 // بذرة: مجال يطغى (٨ منجزة) ومجالان بلا إنجاز
 await p.evaluate(()=>{
  const d=JSON.parse(localStorage.getItem('cc:data:v1'));
  const A=d.areas; const iso=(back)=>new Date(Date.now()-back*864e5).toISOString();
  const mk=(i,o)=>({id:'t'+i,title:'مهمة '+i,notes:'',areaId:A[0].id,goalId:null,urgent:false,important:false,due:null,status:'todo',focusDate:null,focusOrder:0,slips:0,completedAt:null,steps:[],repeat:null,assignee:null,snoozes:0,createdAt:iso(20),updatedAt:iso(1),...o});
  for(let i=0;i<8;i++) d.tasks.push(mk(i,{status:'done',completedAt:iso(i%6)}));
  d.tasks.push(mk(20,{title:'تقرير الربع <b>x</b>',areaId:A[1].id,slips:2,snoozes:2}));
  d.tasks.push(mk(21,{title:'مهمة مفتوحة',areaId:A[0].id,focusLog:[[new Date().toISOString().slice(0,10),50]]}));
  localStorage.setItem('cc:data:v1',JSON.stringify(d)); window.__n=A.length; window.__a=A.map(a=>a.id);
 });
 const nA=await p.evaluate(()=>window.__n);const ids=await p.evaluate(()=>window.__a);
 await p.reload();await p.waitForTimeout(700);
 ok('seed areas >= 3',nA>=3,nA);
 // لافتة اليوم
 ok('today shows balance nudge',await p.isVisible('.bal-nudge'));
 ok('nav has balance',await p.isVisible('[data-nav="#/balance"]'));
 await p.goto(BASE+'/#/balance');await fl();
 ok('balance page renders',await p.isVisible('.bal-hero'));
 ok('wheel drawn',await p.isVisible('svg.wheel'));
 ok('rate rows = areas',(await p.$$('.bal-row')).length===nA);
 ok('dominance insight',(await p.textContent('.bal-ins')).includes('من جهدك'));
 ok('no raw html from titles',!(await p.innerHTML('#view, main')).includes('<b>x</b>'));
 // التقييم
 for(let i=0;i<nA;i++){await p.click(`[data-act="bal-rate"][data-id="${ids[i]}"][data-v="${i===1?3:8}"]`);await fl();}
 let d=await D();const wk=d.reviews.find(r=>r.wheel);
 ok('wheel saved in week doc',wk&&Object.keys(wk.wheel).length===nA&&wk.wheel[ids[1]]===3,wk);
 ok('week doc id is date',/^\d{4}-\d{2}-\d{2}$/.test(wk.id));
 ok('score shown',/\d/.test(await p.textContent('.bal-hero .db-big > b'))&&(await p.textContent('.bal-hero')).includes('مؤشر الاتزان'));
 ok('satisfaction polygon',await p.isVisible('svg.wheel .ws'));
 // ضغطة ثانية تمسح
 await p.click(`[data-act="bal-rate"][data-id="${ids[0]}"][data-v="8"]`);await fl();d=await D();
 ok('second tap clears',!(d.reviews.find(r=>r.wheel).wheel[ids[0]]));
 await p.click(`[data-act="bal-rate"][data-id="${ids[0]}"][data-v="9"]`);await fl();
 // خطوة لأضعف مجال
 ok('lowest-area step form',await p.isVisible('form[data-form="bal-step"]'));
 await p.fill('form[data-form="bal-step"] [name=title]','اتصال قصير');await p.click('form[data-form="bal-step"] [value=today]');await fl();
 d=await D();const st=d.tasks.find(t=>t.title==='اتصال قصير');
 ok('step task created in lowest area, due today',st&&st.areaId===ids[1]&&st.due===new Date().toLocaleDateString('en-CA'),st);
 // الطاقة والحد الأدنى
 await p.click('[data-act="bal-energy"][data-v="3"]');await fl();d=await D();
 ok('energy saved',Object.values(d.reviews.find(r=>r.energy).energy)[0]===3);
 await p.click('.prow[data-act="min-day"]');await fl();d=await D();
 ok('min day saved',(d.reviews.find(r=>r.min)?.min||[]).length===1);
 await p.goto(BASE+'/#/today');await fl();
 ok('today shows min-day banner',(await p.textContent('.bal-nudge')).includes('الحد الأدنى'));
 await p.click('.bal-nudge [data-act="min-day"]');await fl();d=await D();
 ok('min day off',(d.reviews.find(r=>r.id===wk.id).min||[]).length===0);
 // المراجعة لا تعرض مستندًا فارغًا في السابقة، وحفظها لا يمسح العجلة
 await p.goto(BASE+'/#/review');await fl();
 await p.fill('form[data-form=review] [name=wins]','إنجاز');await p.click('form[data-form=review] [type=submit]');await fl();d=await D();
 const w2=d.reviews.find(r=>r.id===wk.id);ok('review save keeps wheel',w2.wins==='إنجاز'&&Object.keys(w2.wheel).length===nA,w2);
 // عالق؟
 await p.goto(BASE+'/#/area/'+ids[1]);await fl();
 await p.click('.tl [data-act="open"]');await fl();
 ok('stuck link in pane',await p.isVisible('[data-act="stuck"]'));
 await p.click('.stuck-link');await fl();
 ok('stuck dialog lists 5 feelings',(await p.$$('[data-act="stuck-pick"]')).length===5);
 await p.click('[data-act="stuck-pick"][data-f="unclear"]');await fl();
 await p.fill('form[data-form=stuck] [name=step]','أفتح الملف');await p.click('form[data-form=stuck] [type=submit]');await fl();
 d=await D();const tk=d.tasks.find(t=>(t.steps||[]).some(s=>s.title==='أفتح الملف'));
 ok('first step added',!!tk,tk);
 ok('stuck logged',(d.reviews.find(r=>r.stuck)?.stuck||[]).some(s=>s.f==='unclear'));
 ok('10-min focus running',(await p.textContent('#fx-time')).startsWith('09:')||(await p.textContent('#fx-time'))==='10:00');
 await p.click('[data-act="end-focus"]');await fl();
 // الجوال: لا تمرير أفقي
 await p.setViewportSize({width:375,height:760});await p.goto(BASE+'/#/balance');await fl();
 const ov=await p.evaluate(()=>document.documentElement.scrollWidth-innerWidth);ok('mobile no horizontal overflow',ov<=1,ov);
 const tap=await p.evaluate(()=>Math.min(...[...document.querySelectorAll('.bal-rate button')].map(b=>b.getBoundingClientRect().height)));ok('rate buttons >= 36px tall',tap>=36,tap);
 await p.screenshot({path:'/tmp/bal-mobile.png',fullPage:true});
 await p.setViewportSize({width:1440,height:900});await fl();await p.screenshot({path:'/tmp/bal-desk.png',fullPage:true});
 await p.goto(BASE+'/#/today');await fl();await p.screenshot({path:'/tmp/today-desk.png'});
 // axe
 try{const axe=require('axe-core');await p.goto(BASE+'/#/balance');await fl();await p.addScriptTag({content:axe.source});
  const r=await p.evaluate(()=>axe.run(document,{runOnly:['wcag2a','wcag2aa']}));
  ok('axe AA on balance',r.violations.length===0,r.violations.map(v=>[v.id,v.nodes.slice(0,3).map(n=>n.target.join(' '))]));}catch(e){console.log('SKIP axe',e.message.slice(0,60))}
 ok('no page errors',errs.length===0,errs.slice(0,4));
 console.log(`\n${pass} passed, ${fail} failed`);await b.close();process.exit(fail?1:0);
})();
