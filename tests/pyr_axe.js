const {chromium}=require('playwright');
const fs=require('fs');const S=__dirname+'/';
let pass=0,fail=0;const ok=(n,c,x)=>{if(c){pass++;console.log('PASS',n)}else{fail++;console.log('FAIL',n,x===undefined?'':JSON.stringify(x))}};
(async()=>{
 const b=await chromium.launch({...(process.env.CHROME?{executablePath:process.env.CHROME}:{})});
 const ctx=await b.newContext({viewport:{width:1440,height:900},colorScheme:process.argv[2]||'light'});
 const p=await ctx.newPage();const axe=fs.readFileSync(require.resolve('axe-core/axe.min.js'),'utf8');const errs=[];p.on('pageerror',e=>errs.push(e.message));p.on('dialog',d=>d.accept());
 await p.goto(''+(process.env.BASE||'http://localhost:8790')+'/');await p.evaluate(()=>localStorage.clear());await p.reload();await p.waitForTimeout(700);
 const D=()=>p.evaluate(()=>JSON.parse(localStorage.getItem('cc:data:v1')));
 const fl=()=>p.waitForTimeout(300);
 // قيم
 await p.goto(''+(process.env.BASE||'http://localhost:8790')+'/#/goals');await fl();
 ok('pyramid shows values intro',await p.isVisible('.pv-start'));
 await p.click('[data-act="edit-values"]');await fl();
 const ins=await p.$$('.val-row input[name=vtext]');ok('3 value rows',ins.length===3);
 await ins[0].fill('الأسرة');await ins[1].fill('الإتقان');await p.click('.dlg [type=submit], dialog [type=submit]');await fl();
 let d=await D();const st=d.reviews.find(r=>r.id==='_settings');ok('values saved (2, empty skipped)',st?.values?.length===2,st);
 ok('value section rendered',(await p.$$('.pv')).length===2);
 // هدف بعيد
 await p.click('.pv:first-of-type [data-act="new-goal"]');await fl();
 ok('long goal prefilled level+value',await p.evaluate(()=>{const f=document.querySelector('form[data-form=goal]');return f.level.value==='long'&&!!f.valueId.value}));
 await p.fill('[name=title]','بيت للأسرة');await p.click('form[data-form=goal] [type=submit]');await fl();
 d=await D();const L=d.goals.find(g=>g.title==='بيت للأسرة');ok('long goal saved',L&&L.level==='long'&&L.valueId,L);
 // هدف قريب تحته
 await p.click('.pl [data-act="new-goal"][data-parent]');await fl();
 ok('mid prefilled parent',await p.evaluate(()=>{const f=document.querySelector('form[data-form=goal]');return f.level.value==='mid'&&!!f.parentId.value&&!f.querySelector('[data-lv=mid]').hidden&&f.querySelector('[data-lv=long]').hidden}));
 await p.fill('[name=title]','شراء الأرض');await p.click('form[data-form=goal] [type=submit]');await fl();
 d=await D();const M=d.goals.find(g=>g.title==='شراء الأرض');ok('mid saved with parent',M&&M.level==='mid'&&M.parentId===L.id,M);
 // أضف 5 مهام للهدف القريب → 3 مفتوحة + 2 تنتظر
 for(let i=1;i<=5;i++){await p.click(`.pm [data-act="new-for-goal"]`);await fl();await p.fill('#qa-d',`خطوة ${i}`);await p.press('#qa-d','Enter');await fl();}
 d=await D();const gt=d.tasks.filter(t=>t.goalId===M.id);
 ok('5 tasks, 2 parked',gt.length===5&&gt.filter(t=>t.parked).length===2,gt.map(t=>[t.title,t.parked]));
 ok('card shows next step + parked count',(await p.textContent('.pm')).includes('تنتظر دورها')&&(await p.$$('.pm .pm-next')).length===1);
 ok('only one step visible in card (no clutter)',(await p.$$('.pm li, .pm .t')).length===0);
 // إنجاز واحدة يُظهر المؤجلة
 await p.click('.pm [data-act="toggle"]');await fl();
 d=await D();ok('completing unparks one',d.tasks.filter(t=>t.goalId===M.id&&t.parked).length===1);
 await p.screenshot({path:S+'pyr_desk.png',fullPage:true});
 const A=async(n)=>{await p.addScriptTag({content:axe});const r=await p.evaluate(async()=>(await axe.run(document,{runOnly:['wcag2a','wcag2aa']})).violations.map(v=>[v.id,v.nodes.length,v.nodes[0].target.join(' '),(v.nodes[0].any[0]||{}).message,v.nodes[0].html.slice(0,160)]));console.log('AXE',n,JSON.stringify(r))};
 await A('pyramid');
 await p.click('.pm [data-act="open"]');await fl();await A('pane collapsed');await p.click('.pmore');await fl();await A('pane expanded');
 await p.screenshot({path:S+'pane_more.png'});
 await p.click('.pmore');await p.click('.pomo-go');await fl();await A('focus');await p.screenshot({path:S+'pomo_run.png'});
 await p.setViewportSize({width:390,height:844});await p.goto(''+(process.env.BASE||'http://localhost:8790')+'/#/goals');await fl();await p.screenshot({path:S+'pyr_mob.png',fullPage:true});
 console.log(errs);await b.close();})();
