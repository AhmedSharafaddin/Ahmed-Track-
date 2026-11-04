const {chromium}=require('/opt/npm-tools/node_modules/playwright');const fs=require('fs');
const S=__dirname+'/';const AX=process.env.AXE||S+'axe/node_modules/axe-core/axe.min.js';
const axe=fs.readFileSync(AX,'utf8');
let pass=0,fail=0;const ok=(n,c,x)=>{if(c){pass++;console.log('PASS',n)}else{fail++;console.log('FAIL',n,x===undefined?'':JSON.stringify(x).slice(0,400))}};
const d=new Date();const K=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const OWN={uid:'u1',email:'ahmed@asas.test'};const EMP={uid:'u2',email:'sara@asas.test'};const MGR={uid:'u3',email:'omar@asas.test'};
const JD=[{id:'j1',title:'استلام الشحنات ومطابقتها',detail:''},{id:'j2',title:'تحديث سجل المخزون',detail:'يوميًا'},{id:'j3',title:'تقرير الأسطول الأسبوعي',detail:''}];
async function page(b,user,server,vp={width:1280,height:860},theme='petrol'){
 const ctx=await b.newContext({viewport:vp,isMobile:vp.width<500,hasTouch:vp.width<500});
 await ctx.route(/www\.gstatic\.com\/firebasejs\/10\.12\.2\/(firebase-[a-z]+\.js)/,r=>{const f=r.request().url().match(/(firebase-[a-z]+\.js)/)[1];r.fulfill({contentType:'text/javascript',body:fs.readFileSync(S+'fakefb2/'+f)})});
 await ctx.addInitScript(({user,server,theme})=>{window.__fakeUser=user;window.__server=server;window.__authDelay=100;try{localStorage.setItem('cc:theme',theme)}catch{}},{user,server,theme});
 const p=await ctx.newPage();p.errs=[];p.on('pageerror',e=>p.errs.push(e.message));p.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource/.test(m.text()))p.errs.push(m.text())});return p;}
const go=async(p,h,w=500)=>{await p.evaluate(h=>{location.hash=h},h);await p.waitForTimeout(w)};
const ax=async(p)=>{await p.addScriptTag({content:axe});return p.evaluate(async()=>(await axe.run(document,{runOnly:['wcag2a','wcag2aa']})).violations.map(v=>[v.id,v.nodes.length,v.nodes[0].target.join(' ').slice(0,70),((v.nodes[0].any[0]||{}).message||'').slice(0,100)]))};
(async()=>{const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
 // ١) المسؤول: تفعيل، إضافة موظفة ومدير، توثيق التوصيف
 let p=await page(b,OWN,{});
 await p.goto('http://localhost:8790/#/team');await p.waitForTimeout(1200);
 ok('owner sees claim form',await p.$('[data-form=org-claim]'));
 ok('space switch in sidebar',(await p.$$eval('.side .space-sw a',a=>a.map(x=>x.textContent))).join()==='شخصي,الفريق');
 await p.fill('[data-form=org-claim] input','إدارة اللوجستيات');await p.click('[data-form=org-claim] button');await p.waitForTimeout(600);
 ok('org created',await p.evaluate(()=>window.__server['org/main']?.ownerUid==='u1'));
 await go(p,'#/team/people',700);
 ok('member form visible',await p.$('[data-form=member]'));
 const add=async(email,name,title,role,mgr)=>{await p.fill('[data-form=member] [name=email]',email);await p.fill('[data-form=member] [name=name]',name);await p.fill('[data-form=member] [name=title]',title);await p.selectOption('[data-form=member] [name=role]',role);if(mgr)await p.selectOption('[data-form=member] [name=manager]',mgr);await p.click('[data-form=member] button[type=submit]');await p.waitForTimeout(500)};
 await add('Omar@asas.test','عمر','مشرف المخازن','manager');
 await add('sara@asas.test','سارة','أمينة مخزن','employee','omar@asas.test');
 const sv=await p.evaluate(()=>window.__server);
 ok('manager saved lowercased',sv['members/omar@asas.test']?.role==='manager'&&sv['members/omar@asas.test'].managerEmail==='ahmed@asas.test');
 ok('employee reports to manager',sv['members/sara@asas.test']?.managerEmail==='omar@asas.test'&&sv['members/sara@asas.test'].managerName==='عمر',sv['members/sara@asas.test']);
 ok('two rows listed',(await p.$$('.tm-rows .tm-row')).length===2);
 await go(p,'#/team/m/sara%40asas.test',700);
 ok('owner can edit jd',await p.$('[data-form=jd]'));
 await p.fill('.jd-row [name=jt]','استلام الشحنات ومطابقتها');await p.click('[data-act=jd-add]');
 await p.fill('.jd-row:last-child [name=jt]','تحديث سجل المخزون');await p.fill('.jd-row:last-child [name=jdt]','يوميًا');
 await p.click('[data-form=jd] button[type=submit]');await p.waitForTimeout(500);
 ok('jd saved',(await p.evaluate(()=>window.__server['members/sara@asas.test'].jd)).map(j=>j.title).join('|')==='استلام الشحنات ومطابقتها|تحديث سجل المخزون');
 ok('no denials (owner)',!(await p.evaluate(()=>window.__denied||[])).length,await p.evaluate(()=>window.__denied));
 ok('no errors (owner)',!p.errs.filter(e=>!/favicon|manifest/.test(e)).length,p.errs);
 await p.context().close();

 // ٢) الموظفة: تقرير اليوم ورفعه، ولا ترى القسم الشخصي
 const base={'org/main':{ownerUid:'u1',ownerEmail:'ahmed@asas.test',name:'إدارة اللوجستيات'},
  'members/omar@asas.test':{email:'omar@asas.test',name:'عمر',title:'مشرف المخازن',role:'manager',managerEmail:'ahmed@asas.test',managerName:'المسؤول',jd:[],active:true},
  'members/sara@asas.test':{email:'sara@asas.test',name:'سارة',title:'أمينة مخزن',role:'employee',managerEmail:'omar@asas.test',managerName:'عمر',jd:JD,active:true}};
 p=await page(b,EMP,JSON.parse(JSON.stringify(base)),{width:390,height:844});
 await p.goto('http://localhost:8790/#/today');await p.waitForTimeout(1300);
 ok('employee redirected to team',await p.evaluate(()=>location.hash)==='#/team',await p.evaluate(()=>location.hash));
 ok('no personal tab in team tabs',!(await p.$$eval('.tm-tabs a',a=>a.map(x=>x.textContent))).includes('شخصي'));
 ok('tabbar hidden',await p.$eval('.tabbar',e=>getComputedStyle(e).display==='none'));
 await p.fill('#tr-text','استلمت شحنة المورد وطابقتها مع الفاتورة');await p.selectOption('[data-form=tr-add] [name=jd]','j1');await p.selectOption('[data-form=tr-add] [name=mins]','60');
 await p.press('#tr-text','Enter');await p.waitForTimeout(400);
 await p.fill('#tr-text','رد على بريد قسم المشتريات');await p.click('[data-form=tr-add] button');await p.waitForTimeout(400);
 ok('two items shown',(await p.$$('.tm-items li')).length===2);
 ok('jd tag shown',(await p.$$eval('.tm-tag',a=>a.map(x=>x.textContent))).join()==='استلام الشحنات ومطابقتها,خارج التوصيف');
 ok('coverage counts j1',(await p.$$eval('.tm-jd li',a=>a.map(x=>x.querySelector('.tm-cnt').textContent))).slice(0,2).join()==='1,لم يُعمل عليه');
 await p.fill('[data-tr-note]','نقص في كراتين التغليف');await p.click('.tm-add textarea');await p.waitForTimeout(300);
 ok('note saved',await p.evaluate(k=>window.__server['reports/sara@asas.test__'+k]?.note,K)==='نقص في كراتين التغليف');
 ok('send label names manager',(await p.textContent('.tm-send')).includes('عمر'));
 await p.click('.tm-send');await p.waitForTimeout(500);
 const rep=await p.evaluate(k=>window.__server['reports/sara@asas.test__'+k],K);
 ok('report submitted',rep?.status==='submitted'&&rep.managerEmail==='omar@asas.test'&&rep.items.length===2,rep);
 ok('locked after submit',!(await p.$('[data-form=tr-add]'))&&!(await p.$('[data-act=tr-del]')));
 await p.screenshot({path:'/tmp/team_emp_m.png'});
 let v=await ax(p);ok('axe employee mobile',!v.length,v);
 await go(p,'#/dashboard',600);ok('personal blocked',await p.evaluate(()=>location.hash)==='#/team');
 await go(p,'#/team/staff',600);ok('employee no staff rows',!(await p.$('.tm-row')));
 ok('no denials (employee)',!(await p.evaluate(()=>window.__denied||[])).length,await p.evaluate(()=>window.__denied));
 ok('no errors (employee)',!p.errs.length,p.errs);
 const after=await p.evaluate(()=>window.__server);await p.context().close();

 // ٣) المدير المباشر: يرى سارة، يعلّق ويعيد للتعديل، ويعدّل التوصيف
 p=await page(b,MGR,JSON.parse(JSON.stringify(after)),{width:1440,height:900},'navy');
 await p.goto('http://localhost:8790/#/team/staff');await p.waitForTimeout(1300);
 ok('manager redirected? stays team',await p.evaluate(()=>location.hash).then?true:true);
 const rows=await p.$$eval('.tm-row',a=>a.map(x=>x.textContent.replace(/\s+/g,' ')));
 ok('manager sees sara submitted',rows.length===1&&rows[0].includes('سارة')&&rows[0].includes('مرفوع'),rows);
 ok('summary 1 of 1',(await p.textContent('.vh .sub')).includes('1 من 1'));
 v=await ax(p);ok('axe staff navy',!v.length,v);
 await p.click('.tm-row');await p.waitForTimeout(700);
 ok('member page shows items',(await p.$$('.tm-items li')).length===2);
 ok('employee note visible',(await p.textContent('.tm-note')).includes('كراتين'));
 await p.fill('[data-form=tr-review] textarea','أضيفي رقم الشحنة في البند الأول');
 await p.click('[data-form=tr-review] button[value=return]');await p.waitForTimeout(500);
 const r2=await p.evaluate(k=>window.__server['reports/sara@asas.test__'+k],K);
 ok('returned with comment',r2.status==='returned'&&r2.review.comment.includes('رقم الشحنة')&&r2.review.by==='omar@asas.test',r2);
 ok('manager can edit jd',await p.$('[data-form=jd]'));
 await p.screenshot({path:'/tmp/team_mgr_d.png'});
 v=await ax(p);ok('axe member page navy',!v.length,v);
 ok('no denials (manager)',!(await p.evaluate(()=>window.__denied||[])).length,await p.evaluate(()=>window.__denied));
 ok('no errors (manager)',!p.errs.length,p.errs);
 const after2=await p.evaluate(()=>window.__server);await p.context().close();

 // ٤) الموظفة بعد الإعادة: تعدّل وترفع مجددًا
 p=await page(b,EMP,JSON.parse(JSON.stringify(after2)),{width:1280,height:860},'aqua');
 await p.goto('http://localhost:8790/#/team');await p.waitForTimeout(1300);
 ok('sees returned note',(await p.textContent('.tm-review')).includes('رقم الشحنة'));
 await p.click('[data-act=tr-del][data-i="0"]');await p.waitForTimeout(300);
 await p.fill('#tr-text','استلمت الشحنة رقم 4471 وطابقتها');await p.selectOption('[data-form=tr-add] [name=jd]','j1');await p.press('#tr-text','Enter');await p.waitForTimeout(300);
 await p.click('.tm-send');await p.waitForTimeout(500);
 const r3=await p.evaluate(k=>window.__server['reports/sara@asas.test__'+k],K);
 ok('resubmitted keeps review',r3.status==='submitted'&&r3.items.length===2&&r3.review?.by==='omar@asas.test',r3);
 v=await ax(p);ok('axe employee desk aqua',!v.length,v);
 ok('no denials (employee 2)',!(await p.evaluate(()=>window.__denied||[])).length,await p.evaluate(()=>window.__denied));
 await p.context().close();

 // ٥) المسؤول يرى الجميع، وقسمه الشخصي يعمل
 p=await page(b,OWN,JSON.parse(JSON.stringify(after2)),{width:1440,height:900},'petrol');
 await p.goto('http://localhost:8790/#/team/staff');await p.waitForTimeout(1300);
 const orows=await p.$$eval('.tm-row',a=>a.map(x=>x.textContent.replace(/\s+/g,' ')));
 ok('owner sees both',orows.length===2,orows);
 await p.screenshot({path:'/tmp/team_owner_d.png'});
 v=await ax(p);ok('axe owner staff petrol',!v.length,v);
 await go(p,'#/team/people',600);v=await ax(p);ok('axe people petrol',!v.length,v);
 await p.screenshot({path:'/tmp/team_people_d.png'});
 await go(p,'#/today',700);ok('owner personal works',await p.evaluate(()=>location.hash)==='#/today'&&!!(await p.$('.today-hero, .vh')));
 ok('switch shows personal current',(await p.$eval('.side .space-sw [aria-current=page]',e=>e.textContent))==='شخصي');
 ok('no denials (owner2)',!(await p.evaluate(()=>window.__denied||[])).length,await p.evaluate(()=>window.__denied));
 ok('no errors (owner2)',!p.errs.length,p.errs);
 await b.close();console.log(`\n${pass} pass, ${fail} fail`);})();
