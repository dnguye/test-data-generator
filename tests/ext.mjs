import fs from 'fs';
const R=new URL('../',import.meta.url).pathname;

globalThis.document={getElementById:(id)=>({value: id==="seed"?"42":""})};
const bundle=fs.readFileSync(R+'faker.iife.js','utf8');
const ext=fs.readFileSync(R+'faker-ext.js','utf8');
globalThis.FakerLib=new Function(bundle+'\n;globalThis.FakerLib=FakerLib;\n'+ext+'\n; return FakerLib;')();
const F=globalThis.FakerLib, f=F.faker;
let pass=0, fail=0;
const ok=(c,m)=>{ c?(pass++):(fail++, console.log('  FAIL: '+m)); };

const NEW=["unwrap","ids","ident","dirty","weighted","geoNorthAmerica","geoLatinAmerica","geoEurope","geoAsiaPacific","geoMiddleEastAfrica","intlAny",
  "intlJapan","intlGermany","intlFrance","intlSpain","intlItaly","intlMexico","intlBrazil","intlChina","intlKorea","intlIndia","intlUnitedKingdom","intlCanada"];
console.log('=== 1. modules present ===');
NEW.forEach(m=>ok(f[m]&&typeof f[m]==='object', 'module missing: '+m));
let count=0; NEW.forEach(m=>count+=Object.keys(f[m]).length);
console.log(`  ${NEW.length} modules, ${count} methods added`);

console.log('=== 2. every method returns a defined scalar (no objects/arrays) ===');
f.seed(11);
for(const m of NEW){
  for(const k of Object.keys(f[m])){
    let v; try{ v=f[m][k].apply(null); }catch(e){ fail++; console.log(`  FAIL: ${m}.${k} threw ${e.message}`); continue; }
    ok(v!==undefined && v!==null, `${m}.${k} returned ${v}`);
    ok(typeof v!=='object', `${m}.${k} returned an object/array: ${JSON.stringify(v)}`);
    ok(!String(v).includes('[object Object]'), `${m}.${k} stringifies to [object Object]`);
  }
}

console.log('=== 3. checksum validity (200 draws each) ===');
const luhnOk=s=>{let sum=0,alt=false;for(let i=s.length-1;i>=0;i--){let d=+s[i];if(alt){d*=2;if(d>9)d-=9;}sum+=d;alt=!alt;}return sum%10===0;};
let bad={npi:0,aba:0,isin:0,gtin:0,upc:0,vin:0,nhs:0,sin:0,ssn:0};
const VINV={A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9};
const VINW=[8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
for(let i=0;i<200;i++){
  if(!luhnOk('80840'+f.ident.npi())) bad.npi++;
  const aba=f.ident.abaRouting();
  const d=[...aba].map(Number);
  if((3*(d[0]+d[3]+d[6])+7*(d[1]+d[4]+d[7])+(d[2]+d[5]+d[8]))%10!==0) bad.aba++;
  const isin=f.ident.isin();
  let exp=''; for(const ch of isin.slice(0,11)) exp += /[0-9]/.test(ch)?ch:String(ch.charCodeAt(0)-55);
  if(!luhnOk(exp+isin.slice(11))) bad.isin++;
  const g=f.ident.gtin13(); let s1=0; for(let j=0;j<13;j++) s1+=(+g[j])*(j%2===0?1:3); if(s1%10!==0) bad.gtin++;
  const u=f.ident.upc12(); let s2=0; for(let j=0;j<12;j++) s2+=(+u[j])*(j%2===0?3:1); if(s2%10!==0) bad.upc++;
  const vin=f.ident.vin();
  if(vin.length!==17 || /[IOQ]/.test(vin)) bad.vin++;
  else { let sv=0; for(let j=0;j<17;j++){const c=vin[j]; sv += (/[0-9]/.test(c)?+c:(VINV[c]||0))*VINW[j];}
         const exp2=(sv%11)===10?'X':String(sv%11); if(vin[8]!==exp2) bad.vin++; }
  const nhs=f.ident.nhsNumber().replace(/ /g,'');
  let sn=0; for(let j=0;j<9;j++) sn+=(+nhs[j])*(10-j);
  let ck=11-(sn%11); if(ck===11)ck=0; if(ck===10||String(ck)!==nhs[9]) bad.nhs++;
  if(!luhnOk(f.ident.sinCanada().replace(/ /g,''))) bad.sin++;
  const ssn=f.ident.ssn(), pa=+ssn.slice(0,3);
  if(pa===0||pa===666||pa>899||ssn.slice(4,6)==='00'||ssn.slice(7)==='0000') bad.ssn++;
}
Object.entries(bad).forEach(([k,v])=>ok(v===0, `${k}: ${v}/200 invalid`));

console.log('=== 4. Salesforce 18-char suffix matches the real algorithm ===');
const MAP="ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
for(let i=0;i<200;i++){
  const id=f.ids.salesforceAccount();
  ok(id.length===18 && id.startsWith('001'), 'sf shape: '+id);
  let suf='';
  for(let c=0;c<3;c++){let b=0;for(let j=0;j<5;j++){const ch=id[c*5+j]; if(ch>='A'&&ch<='Z') b|=1<<j;} suf+=MAP[b];}
  ok(suf===id.slice(15), 'sf checksum: '+id);
}

console.log('=== 5. geo place() rows agree: city + postal format match country ===');
const FMT={ "United States":/^\d{5}$/, "Canada":/^[A-Z]\d[A-Z] \d[A-Z]\d$/, "Mexico":/^\d{5}$/,
  "Brazil":/^\d{5}-\d{3}$/, "Argentina":/^[A-Z]\d{4}[A-Z]{3}$/, "Chile":/^\d{7}$/, "Colombia":/^\d{6}$/, "Peru":/^\d{5}$/,
  "United Kingdom":/^[A-Z]{1,2}\d{1,2} \d[A-Z]{2}$/, "Germany":/^\d{5}$/, "France":/^\d{5}$/, "Spain":/^\d{5}$/,
  "Italy":/^\d{5}$/, "Netherlands":/^\d{4} [A-Z]{2}$/, "Poland":/^\d{2}-\d{3}$/, "Sweden":/^\d{3} \d{2}$/,
  "Japan":/^\d{3}-\d{4}$/, "China":/^\d{6}$/, "India":/^\d{6}$/, "Singapore":/^\d{6}$/, "Australia":/^\d{4}$/,
  "South Korea":/^\d{5}$/, "United Arab Emirates":/^$/, "Saudi Arabia":/^\d{5}-\d{4}$/, "Israel":/^\d{7}$/,
  "South Africa":/^\d{4}$/, "Nigeria":/^\d{6}$/, "Egypt":/^\d{5}$/, "Kenya":/^\d{5}$/ };
const CITIES={};
for(const [k,list] of Object.entries({NorthAmerica:0})) {}
const geoMods=NEW.filter(m=>m.startsWith('geo'));
for(const gm of geoMods){
  for(let i=0;i<150;i++){
    const p=JSON.parse(f[gm].place());
    ok(FMT[p.country]!==undefined, `${gm}: unknown country ${p.country}`);
    if(FMT[p.country]) ok(FMT[p.country].test(p.postal), `${gm} ${p.country} postal "${p.postal}"`);
    ok(typeof p.city==='string'&&p.city.length>0, `${gm} empty city`);
    ok(/^[A-Z]{2}$/.test(p.countryCode), `${gm} bad code ${p.countryCode}`);
  }
}

console.log('=== 6. intl locales produce localised, non-empty values ===');
for(const m of NEW.filter(m=>m.startsWith('intl')&&m!=='intlAny')){
  for(const k of ['fullName','city','streetAddress','zipCode','phone']){
    let empties=0;
    for(let i=0;i<40;i++){ if(String(f[m][k].apply(null)).trim()==='') empties++; }
    ok(empties===0, `${m}.${k} produced ${empties}/40 empty values`);
  }
  const p=JSON.parse(f[m].place());
  ok(p.country&&p.name&&p.city&&p.postal!==undefined, `${m}.place missing keys`);
}
console.log('  samples: ' + ['intlJapan','intlGermany','intlKorea','intlBrazil'].map(m=>`${m}: ${f[m].fullName()} / ${f[m].city()} ${f[m].zipCode()}`).join('  |  '));

console.log('=== 7. dirty module behaves as designed ===');
f.seed(3);
ok(f.dirty.blank()==='', 'blank not empty');
let zw=0; for(let i=0;i<40;i++){ if(/[​‌﻿]/.test(f.dirty.zeroWidth())) zw++; }
ok(zw===40, `zeroWidth only inserted in ${zw}/40`);
let conf=0; for(let i=0;i<60;i++){ if(/[аеоср]/.test(f.dirty.unicodeConfusable())) conf++; }
ok(conf>40, `unicodeConfusable swapped in only ${conf}/60`);
let br=0; for(let i=0;i<20;i++){ const v=f.dirty.csvBreaker(); if(v.includes(',')&&v.includes('"')&&v.includes('\n')) br++; }
ok(br===20, `csvBreaker malformed in ${20-br}/20`);
let lz=0; for(let i=0;i<40;i++){ if(/^0/.test(f.dirty.leadingZeroNumber())) lz++; }
ok(lz===40, `leadingZeroNumber missing zeros in ${40-lz}/40`);

console.log('=== 8. weighted distributions are actually skewed ===');
f.seed(5);
const tally={};
for(let i=0;i<4000;i++){ const v=f.weighted.customerTier(); tally[v]=(tally[v]||0)+1; }
ok(tally.Standard>tally.Premium && tally.Premium>tally.Enterprise, 'tier not skewed: '+JSON.stringify(tally));
console.log('  customerTier over 4000:', JSON.stringify(tally));
const ct={}; for(let i=0;i<4000;i++){ const v=f.weighted.country(); ct[v]=(ct[v]||0)+1; }
ok(ct['United States']>1500, 'country skew wrong: '+JSON.stringify(ct));

console.log('=== 9. seed reproducibility across every new method ===');
function snapshot(seed){
  f.seed(seed); const out=[];
  for(const m of NEW) for(const k of Object.keys(f[m])) out.push(m+'.'+k+'='+f[m][k].apply(null));
  return out.join('');
}
ok(snapshot(99)===snapshot(99), 'same seed produced different data');
ok(snapshot(99)!==snapshot(100), 'different seeds produced identical data');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
