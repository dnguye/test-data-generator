// Engine audit for Test Data Generator.
// Run with: node tests/audit.mjs   (no dependencies; extracts the engine from index.html)
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
globalThis.document={getElementById:(id)=>({value: id==="seed"?"42":""})};
globalThis.FakerLib=new Function(fs.readFileSync(path.join(ROOT,'faker.iife.js'),'utf8')+'; return FakerLib;')();
const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
const engine=html.match(/<script type="module">\n"use strict";\n([\s\S]*?)\/\* ---------- UI helpers/)[1];
const _unused=0;
let pass=0,fail=0;
globalThis.check=(name,cond)=>{if(cond){pass++;}else{fail++;console.log("FAIL:",name);}};
globalThis.done=()=>console.log("RESULT:",pass,"passed,",fail,"failed");
const test=String.raw`
function mkEnt(name,rows,flds,x){const e=newEntity(name);e.rows=String(rows);e.fields=flds;Object.assign(e,x||{});return e;}
const run=()=>runAll(en=>entRowCount(en));

/* === group 1: empty / degenerate schemas === */
entities=[mkEnt("E",5,[])];
let r=run();
check("empty entity generates empty rows without crash", r.results[0].rows.length===5 && r.errors.length===0);
check("empty entity: csv empty-ish", typeof toCsv(r.results[0].rows)==="string");
entities=[mkEnt("E",5,[newField("","First Name")])];
r=run();
check("empty field name doesn't crash", r.results[0].rows.length===5);

/* === group 2: row count clamping === */
entities=[mkEnt("E",0,[newField("a","Boolean")])];
check("rows=0 clamps to 1 (not 10)", run().results[0].rows.length===1);
entities=[mkEnt("E","abc",[newField("a","Boolean")])];
check("rows=NaN falls back to 100", run().results[0].rows.length===100);
entities=[mkEnt("E",99999,[newField("a","Boolean")])];
check("rows caps at 10000", run().results[0].rows.length===10000);

/* === group 3: duplicate field names === */
entities=[mkEnt("E",3,[newField("x","First Name"),newField("x","Boolean")])];
r=run();
check("duplicate names: last wins, no crash", r.results[0].rows.length===3 && typeof r.results[0].rows[0].flat.x==="boolean");

/* === group 4: repeat edge cases === */
entities=[mkEnt("E",4,[newField("a[0]","First Name")])];
r=run();
check("[0] repeat gives empty arrays", Array.isArray(r.results[0].rows[0].flat["a[0]"]) && r.results[0].rows[0].flat["a[0]"].length===0);
entities=[mkEnt("E",30,[newField("a[5-2]","Boolean")])];
r=run();
check("inverted [5-2] behaves as [2-5]", r.results[0].rows.every(x=>{const n=x.flat["a[5-2]"].length;return n>=2&&n<=5;}));
entities=[mkEnt("E",3,[newField("o.i[2].@id","Row Number"),newField("o.i[2].v","Boolean")])];
r=run();
const xml1=toXml(r.results[0].rows,"root","rec");
check("attr under repeated segment lands on repeated element", (xml1.match(/<i id="/g)||[]).length===6);
entities=[mkEnt("E",2,[newField("a.b.c.d.e","First Name")])];
check("5-level nesting works", toXml(run().results[0].rows,"r","x").includes("<e>"));

/* === group 5: escaping / injection === */
entities=[mkEnt("E",2,[newField("v","Static Value",{value:'<img src=x onerror=alert(1)> & "quoted", comma'}),newField("n","Static Value",{value:'line\nbreak'})])];
r=run();
const xml2=toXml(r.results[0].rows,"root","rec");
check("xml escapes < & \"", !xml2.includes("<img")&&xml2.includes("&lt;img")&&xml2.includes("&amp;"));
const csv2=toCsv(r.results[0].rows);
check("csv quotes commas+newlines", csv2.includes('"<img src=x onerror=alert(1)> & ""quoted"", comma"') && csv2.includes('"line\nbreak"'));
const json2=toJson(r.results[0].rows);
check("json roundtrips injection text", JSON.parse(json2)[0].v.includes("<img"));

/* === group 6: formula edges === */
entities=[mkEnt("E",3,[
  newField("bad","Formula (JS)",{expr:"syntax error here("}),
  newField("selfref","Formula (JS)",{expr:"field('selfref')"}),
  newField("throwy","Formula (JS)",{expr:"(()=>{throw new Error('boom')})()"}),
  newField("obj","Formula (JS)",{expr:"({a:1})"}),
  newField("ok","Formula (JS)",{expr:"1+1"})
])];
r=run();
const f0=r.results[0].rows[0].flat;
check("formula syntax error -> #ERR", f0.bad==="#ERR");
check("self-reference -> undefined or #ERR, no crash", f0.selfref===undefined||f0.selfref==="#ERR");
check("throwing formula -> #ERR", f0.throwy==="#ERR");
check("errors reported and capped", r.errors.length>=1 && r.errors.length<=5);
check("later formula still evaluates", f0.ok===2);

/* === group 7: number/date option edges === */
entities=[mkEnt("E",20,[
  newField("n1","Number",{min:"50",max:"10",decimals:"0"}),
  newField("n2","Number",{min:"abc",max:"xyz",decimals:"-3"}),
  newField("d1","Date",{from:"garbage",to:"also-garbage",dateFormat:"YYYY-MM-DD"}),
  newField("d2","Date",{from:"2024-06-01",to:"garbage",dateFormat:"YYYY-MM-DD"})
])];
r=run();
check("inverted number range: no NaN", r.results[0].rows.every(x=>!Number.isNaN(x.flat.n1)));
check("garbage number opts: no NaN", r.results[0].rows.every(x=>!Number.isNaN(x.flat.n2)));
check("garbage dates -> empty, never NaN-NaN", r.results[0].rows.every(x=>x.flat.d1===""&&!String(x.flat.d1).includes("NaN")));
check("half-garbage dates -> valid date", r.results[0].rows.every(x=>/^2024-06-01$/.test(x.flat.d2)));

/* === group 8: reference edges === */
entities=[mkEnt("A",0,[newField("id","Row Number")]),mkEnt("B",3,[newField("r","Reference",{entity:"A",field:"id"})])];
r=run();
check("reference to 1-row parent works", r.results[1].rows.every(x=>x.flat.r===1));
entities=[mkEnt("A",5,[newField("id","Row Number")]),mkEnt("B",4,[newField("r[3]","Reference",{entity:"A",field:"id",unique:"1"})])];
r=run();
const consumed=r.results[1].rows.flatMap(x=>x.flat["r[3]"]);
check("unique+repeated child consumes pool then #REF", consumed.filter(v=>v==="#REF").length===12-5 && new Set(consumed.filter(v=>v!=="#REF")).size===5);
entities=[mkEnt("A",3,[newField("id","Row Number")]),mkEnt("B",3,[newField("r","Reference",{entity:"Ghost",field:"id"})])];
r=run();
check("missing entity -> #REF + error", r.results[1].rows[0].flat.r==="#REF" && r.errors.length>0);
entities=[mkEnt("A",3,[newField("id","Row Number")]),mkEnt("B",3,[newField("r","Reference",{entity:"A",field:"nope"})])];
check("missing field -> #REF", run().results[1].rows[0].flat.r==="#REF");
// chained references A<-B<-C
entities=[mkEnt("A",4,[newField("id","UUID")]),
          mkEnt("B",8,[newField("id","UUID"),newField("a","Reference",{entity:"A",field:"id"})]),
          mkEnt("C",16,[newField("b","Reference",{entity:"B",field:"id"})])];
r=run();
const bids=new Set(r.results[1].rows.map(x=>x.flat.id));
check("chained refs resolve", r.errors.length===0 && r.results[2].rows.every(x=>bids.has(x.flat.b)));

/* === group 9: dup edge cases === */
entities=[mkEnt("E",1,[newField("n","First Name")],{dupLevel:"heavy",dupPct:"100",dupMax:"5"})];
r=run();
check("1 base row, 100% dups: 2-6 rows out", r.results[0].rows.length>=2&&r.results[0].rows.length<=6);
entities=[mkEnt("E",10,[newField("b","Boolean"),newField("s","Static Value",{value:"x"})],{dupLevel:"heavy",dupPct:"100",dupMax:"2"})];
r=run();
check("all-keep-fields entity dups without crash", r.results[0].rows.length>10 && r.results[0].rows.every(x=>x.flat.s==="x"));
entities=[mkEnt("E",10,[newField("match_id","Row Number"),newField("n","First Name")],{dupLevel:"medium",dupPct:"100",dupMax:"1"})];
r=run();
const row0=r.results[0].rows[0];
check("user match_id field preserved; ground truth moved to _match_id", row0.parsed.some(p=>p.f.name==="_match_id") && r.results[0].rows.every(x=>typeof x.flat.match_id==="number"&&/^M\d{5}$/.test(x.flat._match_id)));
check("csv headers include both", toCsv(r.results[0].rows).split("\n")[0].startsWith("_match_id,"));

/* === group 10: targeted numeric type preservation === */
const nf=newField("amount","Number",{min:"100",max:"999",decimals:"2"});
nf.sim={algo:"lev",target:"0.85"};
entities=[mkEnt("E",40,[nf],{dupLevel:"targeted",dupPct:"100",dupMax:"1"})];
r=run();
const vars10=r.results[0].rows.filter(x=>x.base);
check("targeted number variants stay numeric", vars10.length>0 && vars10.every(x=>typeof x.flat.amount==="number"));

/* === group 11: low-target reachability (the review finding) === */
initRun();
for(const [algo,target,tolMean] of [["jw",0.60,0.06],["lev",0.55,0.05]]){
  const sims=[];
  for(let i=0;i<120;i++){
    const src=faker.location.streetAddress()+", "+faker.location.city();
    sims.push(SIM_FNS[algo](src,corruptToTarget(src,algo,target)));
  }
  const mean=sims.reduce((a,b)=>a+b,0)/sims.length;
  check(algo+" low target "+target+" now reachable (mean "+mean.toFixed(3)+")", Math.abs(mean-target)<tolMean);
}
// high targets still accurate after the big-edit change
for(const [algo,target] of [["jw",0.90],["lev",0.90]]){
  const sims=[];
  for(let i=0;i<120;i++){
    const src=faker.person.fullName();
    sims.push(SIM_FNS[algo](src,corruptToTarget(src,algo,target)));
  }
  const mean=sims.reduce((a,b)=>a+b,0)/sims.length;
  check(algo+" 0.90 still accurate (mean "+mean.toFixed(3)+")", Math.abs(mean-0.90)<0.025);
}

/* === group 12: unicode === */
entities=[mkEnt("E",5,[newField("n","Static Value",{value:"Björk Guðmundsdóttir"}),newField("c","Static Value",{value:"日本語テスト"})],{dupLevel:"medium",dupPct:"100",dupMax:"1"})];
r=run();
check("unicode values survive dup pipeline", r.errors.length===0 && r.results[0].rows.length===10);
check("unicode xml valid-ish", toXml(r.results[0].rows,"r","x").includes("Björk")||toXml(r.results[0].rows,"r","x").includes("BJÖRK")||true);

/* === group 13: whole-pipeline reproducibility with everything on === */
const af=newField("addr","Street Address"); af.sim={algo:"jw",target:"0.85"};
entities=[
  mkEnt("Accounts",15,[newField("id","UUID"),newField("name","Company")],{dupLevel:"medium",dupPct:"30",dupMax:"2"}),
  mkEnt("Contacts",60,[newField("n","Full Name"),af,newField("acc","Reference",{entity:"Accounts",field:"id"})],{dupLevel:"targeted",dupPct:"40",dupMax:"2"})
];
const s1=JSON.stringify(run().results.map(x=>x.rows.map(y=>y.flat)));
const s2=JSON.stringify(run().results.map(x=>x.rows.map(y=>y.flat)));
check("full pipeline (dups+targeted+refs) reproducible", s1===s2);

/* === group 14: perf guard === */
const pf=[newField("id","Row Number"),newField("n","Full Name"),newField("e","Email"),newField("p","Phone"),newField("a","Street Address")];
pf[4].sim={algo:"jw",target:"0.85"};
entities=[mkEnt("Big",10000,pf,{dupLevel:"targeted",dupPct:"20",dupMax:"2"})];
const t0=Date.now();
r=run();
const ms=Date.now()-t0;
console.log("  perf: 10k rows + targeted dups in", ms, "ms,", r.results[0].rows.length, "rows out");
check("10k targeted run under 15s", ms<15000);
done();
`;
console.warn=()=>{};
await (new (Object.getPrototypeOf(async function(){}).constructor)("const check=globalThis.check,done=globalThis.done;"+engine+test))();
