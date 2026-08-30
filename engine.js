/* ---------------------------------------------------------------------------
   engine.js -- the generation core of Test Data Generator.

   No DOM, no globals, no build step: this module is the single implementation
   shared by the browser app (index.html), the HTTP API (api/) and the test
   suites (tests/). Everything here is deliberately synchronous, which is what
   makes the seed honest -- see runAll().

   Faker is injected rather than imported, because the browser gets it from the
   vendored classic script (faker.iife.js sets a FakerLib global) while Node
   evaluates that same bundle. One bundle, one catalog, identical output on
   both sides -- which is the whole point of a reproducibility API.
--------------------------------------------------------------------------- */
"use strict";

/* ---------- Faker binding ---------- */
let faker = null;
let HAS_FAKER = false;
let FAKER_METHODS = [];

/* Bind a faker instance (after faker-ext.js has extended it) and rebuild the
   method catalog. Safe to call more than once; the last call wins. */
function useFaker(instance){
  faker = instance || null;
  HAS_FAKER = !!instance;
  FAKER_METHODS = buildCatalog();
  return FAKER_METHODS;
}
function hasFaker(){ return HAS_FAKER; }
function getFaker(){ return faker; }
function getCatalog(){ return FAKER_METHODS; }

/* Pick up a bundle that a classic script already put on the global, which is
   how both the browser page and the Node hosts load it. */
if (typeof globalThis.FakerLib !== "undefined" && globalThis.FakerLib && globalThis.FakerLib.faker) {
  useFaker(globalThis.FakerLib.faker);
}

/* ---------- RNG (seedable) ---------- */
let _rng = Math.random;
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function rnd(){return _rng()}
function randint(min,max){return Math.floor(rnd()*(max-min+1))+min}
function pick(arr){return arr[Math.floor(rnd()*arr.length)]}

/* ---------- Fallback pools ---------- */
const POOL = {
  first:["Bob","Alice","Carlos","Dana","Elena","Frank","Grace","Hiro","Ivy","Jamal","Kira","Liam","Mona","Nia","Omar","Priya","Quinn","Rosa","Sam","Tara"],
  last:["Smith","Johnson","Lee","Garcia","Brown","Nguyen","Patel","Kim","Lopez","Miller","Davis","Chen","Walker","Young","Ali","Silva","Hansen","Kaur","Ortiz","Reed"],
  street:["Oak St","Maple Ave","Cedar Ln","Elm Dr","Pine Rd","Birch Blvd","Walnut Way","Spruce Ct","Ash Ter","Willow Pl"],
  city:["Springfield","Riverton","Lakeside","Fairview","Greenville","Bristol","Clinton","Madison","Georgetown","Salem"],
  state:["California","Texas","New York","Florida","Ohio","Georgia","Oregon","Nevada","Utah","Maine"],
  stateAbbr:["CA","TX","NY","FL","OH","GA","OR","NV","UT","ME"],
  country:["United States","Canada","Mexico","Germany","France","Japan","Brazil","India","Spain","Italy"],
  company:["Acme Corp","Globex","Initech","Umbra Labs","Vertex LLC","Nimbus Co","Quanta Group","Helix Inc","Orbit Systems","Zephyr Ltd"],
  job:["Engineer","Analyst","Designer","Manager","Consultant","Developer","Technician","Director","Specialist","Coordinator"],
  words:["alpha","bravo","delta","echo","kilo","lima","nova","orion","pixel","quartz","raven","sigma","talon","umbra","vector"]
};
function fk(path, fallback, args){
  if(HAS_FAKER){
    try{
      const parts=path.split(".");let fn=faker;
      for(const p of parts) fn=fn[p];
      if(typeof fn==="function") return fn.apply(null, args||[]);
    }catch(e){}
  }
  return fallback ? fallback() : "#unknown:"+path;
}
/* ---------- Faker method catalog (for autocomplete) ---------- */
/* Walks the loaded Faker instance so the full modern catalog is discoverable
   in the UI instead of having to be known and typed from memory. */
function buildCatalog(){
  if(!HAS_FAKER) return [];
  const SKIP=new Set(["helpers","definitions","rawDefinitions","locales","locale","localeFallback"]);
  const found=[];
  for(const mod of Object.keys(faker)){
    if(SKIP.has(mod)||mod.startsWith("_")) continue;
    const m=faker[mod];
    if(!m||typeof m!=="object") continue;
    /* Faker's own modules are class instances, so their methods live on the
       prototype. Custom modules (faker-ext.js) are plain objects, whose
       prototype is Object.prototype — walking that would offer hasOwnProperty,
       toString and friends as data types. */
    const proto=Object.getPrototypeOf(m);
    const inherited=(proto&&proto!==Object.prototype)?Object.getOwnPropertyNames(proto):[];
    const keys=new Set([...Object.keys(m),...inherited]);
    for(const k of keys){
      if(k==="constructor"||k.startsWith("_")) continue;
      let fn; try{fn=m[k];}catch(e){continue;}
      if(typeof fn==="function") found.push(mod+"."+k);
    }
  }
  /* Keep only methods that actually produce a value with no arguments, since
     that is how this tool calls them. Silence deprecation notices while probing. */
  const warn=console.warn; console.warn=()=>{};
  const usable=found.filter(path=>{
    const [mod,k]=path.split(".");
    try{ return faker[mod][k]()!==undefined; }catch(e){ return false; }
  });
  console.warn=warn;
  return usable.sort();
}

function uuid(){
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,c=>{
    const r=Math.floor(rnd()*16), v=c==="x"?r:(r&0x3|0x8);return v.toString(16);
  });
}

/* ---------- Field types ---------- */
const TYPES = {
  "Row Number":     {gen:(o,ctx)=>ctx.rowIndex+1},
  "First Name":     {gen:()=>fk("person.firstName",()=>pick(POOL.first))},
  "Last Name":      {gen:()=>fk("person.lastName",()=>pick(POOL.last))},
  "Full Name":      {gen:()=>fk("person.fullName",()=>pick(POOL.first)+" "+pick(POOL.last))},
  "Email":          {gen:()=>fk("internet.email",()=>pick(POOL.first).toLowerCase()+"."+pick(POOL.last).toLowerCase()+"@example.com")},
  "Phone":          {gen:()=>fk("phone.number",()=>"("+randint(200,989)+") "+randint(200,989)+"-"+String(randint(0,9999)).padStart(4,"0"))},
  "Street Address": {gen:()=>fk("location.streetAddress",()=>randint(10,9999)+" "+pick(POOL.street))},
  "City":           {gen:()=>fk("location.city",()=>pick(POOL.city))},
  "State":          {gen:()=>fk("location.state",()=>pick(POOL.state))},
  "State Abbr":     {gen:()=>fk("location.state",()=>pick(POOL.stateAbbr),[{abbreviated:true}])},
  "Zip Code":       {gen:()=>fk("location.zipCode",()=>String(randint(10000,99999)))},
  "Country":        {gen:()=>fk("location.country",()=>pick(POOL.country))},
  "Company":        {gen:()=>fk("company.name",()=>pick(POOL.company))},
  "Job Title":      {gen:()=>fk("person.jobTitle",()=>pick(POOL.job))},
  "Faker (any)":    {opts:{method:"commerce.productName"},
                     gen:(o)=>fk((o.method||"").trim(),null)},
  "UUID":           {gen:()=>uuid()},
  "Boolean":        {gen:()=>rnd()<0.5},
  "Number":         {opts:{min:"1",max:"100",decimals:"0"},
                     gen:(o)=>{let min=parseFloat(o.min),max=parseFloat(o.max);
                       if(!Number.isFinite(min))min=1; if(!Number.isFinite(max))max=100;
                       if(max<min)[min,max]=[max,min];
                       const d=Math.min(Math.max(parseInt(o.decimals)||0,0),8);
                       const v=min+rnd()*(max-min);return d>0?parseFloat(v.toFixed(d)):Math.round(v);}},
  "Date":           {opts:{from:"2024-01-01",to:"2026-08-27",dateFormat:"YYYY-MM-DD"},
                     gen:(o)=>{let a=Date.parse(o.from||"2024-01-01"),b=Date.parse(o.to||Date.now());
                       if(isNaN(a)&&isNaN(b))return "";
                       if(isNaN(a))a=b; if(isNaN(b))b=a;
                       const d=new Date(a+rnd()*(Math.max(b,a)-a));
                       const p=n=>String(n).padStart(2,"0");
                       const map={YYYY:d.getFullYear(),MM:p(d.getMonth()+1),DD:p(d.getDate()),HH:p(d.getHours()),mm:p(d.getMinutes()),ss:p(d.getSeconds())};
                       return (o.dateFormat||"YYYY-MM-DD").replace(/YYYY|MM|DD|HH|mm|ss/g,m=>map[m]);}},
  "Custom List":    {opts:{values:"red, green, blue"},
                     gen:(o)=>{const vs=(o.values||"").split(",").map(s=>s.trim()).filter(Boolean);
                       return vs.length?pick(vs):"";}},
  "Static Value":   {opts:{value:"fixed"}, gen:(o)=>o.value??""},
  "Lorem Words":    {opts:{count:"3"},
                     gen:(o)=>{const n=parseInt(o.count||3);const out=[];for(let k=0;k<n;k++)out.push(pick(POOL.words));return out.join(" ");}},
  "Reference":      {opts:{entity:"",field:"",unique:""},
                     gen:(o,ctx)=>{
                       const pool=ctx.registry&&ctx.registry[o.entity]&&ctx.registry[o.entity][o.field];
                       const err=m=>{if(ctx.errors&&ctx.errors.length<5&&!ctx.errors.includes(m))ctx.errors.push(m);};
                       if(!pool||!pool.length){
                         err("Reference "+(o.entity||"?")+"."+(o.field||"?")+": no values — the source must be an entity tab to the LEFT");
                         return "#REF";
                       }
                       if(o.unique==="1"){
                         let st=ctx.uniq.get(o);
                         if(!st){
                           st=pool.slice();
                           for(let k=st.length-1;k>0;k--){const j=Math.floor(rnd()*(k+1));[st[k],st[j]]=[st[j],st[k]];}
                           ctx.uniq.set(o,st);
                         }
                         if(!st.length){err("Reference "+o.entity+"."+o.field+": ran out of unique values — more rows here than in "+o.entity);return "#REF";}
                         return st.pop();
                       }
                       return pool[Math.floor(rnd()*pool.length)];
                     }},
  "Formula (JS)":   {opts:{expr:"normalize(field('name') + field('nick'))"}, formula:true, gen:()=>""}
};
const TYPE_NAMES = Object.keys(TYPES);

/* ---------- Ids ----------
   Ids exist so the UI can key rows across re-renders; generation never reads
   them. The counters live here only because newField() hands them out. */
let fid = 0;
let eid = 0;
function nextFieldId(){ return ++fid; }
function newEntity(name){
  return {id:++eid, name:name||("Entity"+eid), rows:"100", root:"records", record:"record", dupLevel:"off", dupPct:"20", dupMax:"2", fields:[]};
}
function newField(name,type,opts){
  const t = TYPES[type] || TYPES["First Name"];
  return {id:++fid, name:name||"field_"+fid, type:type||"First Name", opts:Object.assign({},t.opts||{},opts||{})};
}


/* ---------- Name parsing ---------- */
function parseName(name){
  const segs = name.split(".").map(raw=>{
    let key=raw, repeat=null, attr=false;
    const m = key.match(/\[(\d+)(?:-(\d+))?\]$/);
    if(m){
      let lo=parseInt(m[1]), hi=m[2]?parseInt(m[2]):parseInt(m[1]);
      if(hi<lo)[lo,hi]=[hi,lo];
      repeat={min:lo,max:hi};key=key.slice(0,m.index);
    }
    if(key.startsWith("@")){attr=true;key=key.slice(1);}
    return {key,repeat,attr};
  });
  return segs;
}
function repeatPrefix(segs){
  const idx = segs.findIndex(s=>s.repeat);
  if(idx<0) return null;
  return {idx, path:segs.slice(0,idx+1).map(s=>s.key).join("."), spec:segs[idx].repeat};
}

/* ---------- Formula helpers ---------- */
const HELPERS = {
  normalize:s=>String(s??"").toLowerCase().replace(/[^a-z0-9]/g,""),
  concat:(...a)=>a.join(""),
  pad:(v,len,ch)=>String(v??"").padStart(len,ch||"0"),
  rand:(min,max)=>randint(min,max)
};
function evalFormula(expr, flat, i){
  const field = (n)=>{const v=flat[n];return Array.isArray(v)?(v[i!==undefined?i:0] ?? v[0]):v;};
  const fieldsFn = (n)=>{const v=flat[n];return Array.isArray(v)?v:[v];};
  const f = new Function("field","fields","normalize","concat","pad","rand","i","row",
    '"use strict"; return ('+expr+');');
  return f(field, fieldsFn, HELPERS.normalize, HELPERS.concat, HELPERS.pad, HELPERS.rand, i??0, flat);
}

/* ---------- Generation ---------- */
/* Seeds both streams: our own RNG and faker's. Pass a seed to reproduce a run;
   pass "" / undefined to get a fresh random one back. */
function initRun(seedInput){
  const raw = seedInput===undefined || seedInput===null ? "" : String(seedInput).trim();
  const parsed = raw==="" ? NaN : parseInt(raw,10);
  const seed = Number.isFinite(parsed) ? parsed : Math.floor(Math.random()*1e9);
  _rng = mulberry32(seed);
  if(HAS_FAKER && faker.seed) try{faker.seed(seed);}catch(e){}
  return seed;
}
function generateRows(flds, n, registry, errors){
  const rows=[];
  const uniq=new Map();
  const parsed = flds.map(f=>({f, segs:parseName(f.name.trim()), rp:null}));
  parsed.forEach(p=>p.rp=repeatPrefix(p.segs));
  for(let r=0;r<n;r++){
    const flat={};        // fieldName -> value | array
    const counts={};      // repeatPath -> count for this row
    const ctx={rowIndex:r, registry, uniq, errors};
    // pass 1: non-formula
    for(const p of parsed){
      const t=TYPES[p.f.type]; if(!t||t.formula) continue;
      if(p.rp){
        const c = counts[p.rp.path] ?? (counts[p.rp.path]=randint(p.rp.spec.min,p.rp.spec.max));
        const arr=[]; for(let k=0;k<c;k++) arr.push(t.gen(p.f.opts,ctx));
        flat[p.f.name]=arr;
      }else{
        flat[p.f.name]=t.gen(p.f.opts,ctx);
      }
    }
    // pass 2: formulas (in field order; can reference earlier formulas)
    for(const p of parsed){
      const t=TYPES[p.f.type]; if(!t||!t.formula) continue;
      const expr=p.f.opts.expr||'""';
      try{
        if(p.rp){
          const c = counts[p.rp.path] ?? (counts[p.rp.path]=randint(p.rp.spec.min,p.rp.spec.max));
          const arr=[]; for(let k=0;k<c;k++) arr.push(evalFormula(expr,flat,k));
          flat[p.f.name]=arr;
        }else{
          flat[p.f.name]=evalFormula(expr,flat,undefined);
        }
      }catch(e){
        flat[p.f.name]="#ERR";
        if(errors.length<3) errors.push(p.f.name+": "+e.message);
      }
    }
    rows.push({flat,parsed});
  }
  return {rows};
}

/* ---------- Nesting ---------- */
function buildTree(row){
  // node: {children:{}, attrs:{}, values:[], arrays:{key:[node,...]}}
  const mk=()=>({children:{},attrs:{},value:undefined,arrays:{}});
  const root=mk();
  for(const p of row.parsed){
    const v=row.flat[p.f.name];
    insert(root,p.segs,0,v);
  }
  function insert(node,segs,si,val){
    const s=segs[si], last=si===segs.length-1;
    if(s.repeat){
      const arr=Array.isArray(val)?val:[val];
      if(!node.arrays[s.key]) node.arrays[s.key]=arr.map(()=>mk());
      const nodes=node.arrays[s.key];
      while(nodes.length<arr.length) nodes.push(mk());
      arr.forEach((v,k)=>{
        if(last){nodes[k].value=v;}
        else insert(nodes[k],segs,si+1,v);
      });
      return;
    }
    if(last){
      if(s.attr) node.attrs[s.key]=val;
      else{
        if(!node.children[s.key]) node.children[s.key]=mk();
        node.children[s.key].value=val;
      }
      return;
    }
    if(!node.children[s.key]) node.children[s.key]=mk();
    insert(node.children[s.key],segs,si+1,val);
  }
  return root;
}

/* ---------- Serializers ---------- */
function xesc(s){return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function nodeToXml(name,node,ind){
  const pad="  ".repeat(ind);
  let attrs=Object.entries(node.attrs).map(([k,v])=>` ${k}="${xesc(v)}"`).join("");
  const kids=[];
  for(const [k,ch] of Object.entries(node.children)) kids.push(nodeToXml(k,ch,ind+1));
  for(const [k,arr] of Object.entries(node.arrays)) arr.forEach(ch=>kids.push(nodeToXml(k,ch,ind+1)));
  if(kids.length===0){
    const v=node.value===undefined?"":xesc(node.value);
    return `${pad}<${name}${attrs}>${v}</${name}>`;
  }
  const inner=node.value!==undefined?("  ".repeat(ind+1)+xesc(node.value)+"\n"):"";
  return `${pad}<${name}${attrs}>\n${inner}${kids.join("\n")}\n${pad}</${name}>`;
}
function toXml(rows,rootEl,recEl){
  const body=rows.map(r=>nodeToXml(recEl,buildTree(r),1)).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${rootEl}>\n${body}\n</${rootEl}>`;
}
function nodeToObj(node){
  const hasKids=Object.keys(node.children).length||Object.keys(node.arrays).length||Object.keys(node.attrs).length;
  if(!hasKids) return node.value===undefined?null:node.value;
  const o={};
  for(const [k,v] of Object.entries(node.attrs)) o[k]=v;
  for(const [k,ch] of Object.entries(node.children)) o[k]=nodeToObj(ch);
  for(const [k,arr] of Object.entries(node.arrays)) o[k]=arr.map(nodeToObj);
  if(node.value!==undefined) o._value=node.value;
  return o;
}
function toJson(rows){return JSON.stringify(rows.map(r=>nodeToObj(buildTree(r))),null,2);}
function toCsv(rows){
  if(!rows.length) return "";
  const headers=rows[0].parsed.map(p=>p.f.name);
  const esc=v=>{const s=Array.isArray(v)?v.join("|"):String(v??"");return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
  const lines=[headers.map(esc).join(",")];
  for(const r of rows) lines.push(headers.map(h=>esc(r.flat[h])).join(","));
  return lines.join("\n");
}

/* ---------- Similarity metrics (dependency-free) ---------- */
function jaroWinkler(a,b){
  a=String(a);b=String(b);
  if(a===b) return 1;
  const la=a.length,lb=b.length;
  if(!la||!lb) return 0;
  const md=Math.max(0,Math.floor(Math.max(la,lb)/2)-1);
  const am=new Array(la).fill(false),bm=new Array(lb).fill(false);
  let m=0;
  for(let i=0;i<la;i++){
    for(let j=Math.max(0,i-md);j<Math.min(lb,i+md+1);j++){
      if(!bm[j]&&a[i]===b[j]){am[i]=bm[j]=true;m++;break;}
    }
  }
  if(!m) return 0;
  let t=0,k=0;
  for(let i=0;i<la;i++) if(am[i]){while(!bm[k])k++;if(a[i]!==b[k])t++;k++;}
  const j=(m/la+m/lb+(m-t/2)/m)/3;
  let l=0; while(l<4&&l<la&&l<lb&&a[l]===b[l])l++;
  return j+l*0.1*(1-j);
}
function levSim(a,b){
  a=String(a);b=String(b);
  const la=a.length,lb=b.length;
  if(!la&&!lb) return 1;
  let prev=Array.from({length:lb+1},(_,j)=>j);
  for(let i=1;i<=la;i++){
    const cur=[i];
    for(let j=1;j<=lb;j++)
      cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));
    prev=cur;
  }
  return 1-prev[lb]/Math.max(la,lb);
}
const SIM_FNS={jw:jaroWinkler,lev:levSim};

/* One small seeded edit; replacement characters match the string's alphabet. */
function editOnce(s){
  s=String(s); if(!s.length) return "x";
  const pool=/^[0-9\s().,+-]*$/.test(s)?"0123456789":"abcdefghijklmnopqrstuvwxyz";
  const ch=pool[randint(0,pool.length-1)];
  const i=randint(0,s.length-1), op=randint(0,3);
  if(op===0&&s.length>1){const j=Math.min(i,s.length-2);return s.slice(0,j)+s[j+1]+s[j]+s.slice(j+2);}
  if(op===1&&s.length>2) return s.slice(0,i)+s.slice(i+1);
  if(op===2) return s.slice(0,i)+ch+s.slice(i+1);
  const k=randint(0,s.length);
  return s.slice(0,k)+ch+s.slice(k);
}
/* Degrade s0 one edit at a time until similarity lands in a band around the
   target; on overshoot restart from the original; return the closest found.
   Similarity is quantized (short strings take coarse steps), so this is
   best-effort — the preview reports what was actually achieved. */
function bigEdit(s){
  s=String(s);
  const words=s.split(" ").filter(Boolean);
  if(words.length>1&&randint(0,1)){          // move a word: wrecks prefixes and order
    const i=randint(0,words.length-1);
    const [w]=words.splice(i,1);
    words.splice(randint(0,words.length),0,w);
    const r=words.join(" ");
    if(r!==s) return r;
  }
  if(s.length>4){                            // drop a small chunk
    const n=randint(2,Math.min(4,s.length-2));
    const i=randint(0,s.length-n);
    return s.slice(0,i)+s.slice(i+n);
  }
  return editOnce(s);
}
function corruptToTarget(s0,algo,target){
  s0=String(s0);
  const sim=SIM_FNS[algo]||jaroWinkler, tol=0.02;
  if(!s0.length||target>=0.995) return s0;
  let cur=s0, best=s0, bestGap=1-target;
  const iters=target<0.75?220:80;
  for(let it=0;it<iters;it++){
    const cand=(target<0.85&&rnd()<0.25)?bigEdit(cur):editOnce(cur);
    const cs=sim(s0,cand);
    if(cs>=target-tol&&cs<=target+tol) return cand;
    const gap=Math.abs(cs-target);
    if(gap<bestGap){best=cand;bestGap=gap;}
    cur=cs>target?cand:s0;
  }
  return best;
}

/* ---------- Duplicate variants (for testing matching / dedup) ----------
   A fraction of records get fuzzed copies; original and copies share a
   match_id so a matcher's output can be scored against ground truth. */
function fieldKind(f){
  const m=(f.type==="Faker (any)"?(f.opts.method||""):"").toLowerCase();
  if(f.type==="Email"||m.includes("email")) return "email";
  if(f.type==="Phone"||m.includes("phone")) return "phone";
  if(f.type==="Date") return "date";
  if(f.type==="Number") return "number";
  if(f.type==="Zip Code") return "digits";
  if(f.type==="UUID") return "uuid";
  if(f.type==="Row Number"||f.type==="Boolean"||f.type==="Static Value"||f.type==="Reference") return "keep";
  return "string";
}
function _typo(s){
  s=String(s); if(s.length<2) return s+s[0];
  const i=randint(0,s.length-2), op=randint(0,2);
  if(op===0) return s.slice(0,i)+s[i+1]+s[i]+s.slice(i+2);
  if(op===1) return s.slice(0,i)+s.slice(i+1);
  return s.slice(0,i)+s[i]+s.slice(i);
}
function _flipCase(s){s=String(s);const op=randint(0,2);
  return op===0?s.toUpperCase():op===1?s.toLowerCase():s.charAt(0).toLowerCase()+s.slice(1);}
function _space(s){s=String(s);if(!s.length)return s;const i=randint(0,s.length-1);
  return randint(0,1)?s+" ":s.slice(0,i)+"  "+s.slice(i);}
function _digitSwap(s){
  s=String(s);const ds=[];for(let i=0;i<s.length;i++)if(s[i]>="0"&&s[i]<="9")ds.push(i);
  if(!ds.length) return s;
  const i=pick(ds);
  return s.slice(0,i)+String((parseInt(s[i])+randint(1,9))%10)+s.slice(i+1);
}
function _phoneFmt(s){
  const d=String(s).replace(/\D/g,""); if(d.length<7) return _digitSwap(s);
  const t=d.slice(-10), op=randint(0,2);
  if(op===0) return d;
  if(op===1) return t.slice(0,3)+"-"+t.slice(3,6)+"-"+t.slice(6);
  return "("+t.slice(0,3)+") "+t.slice(3,6)+"-"+t.slice(6);
}
function _dateShift(s,allowSwap){
  const m=String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(!m) return _digitSwap(s);
  if(allowSwap&&parseInt(m[3])<=12&&m[2]!==m[3]&&randint(0,1))
    return m[1]+"-"+m[3]+"-"+m[2]+String(s).slice(10);      // MM/DD transposed
  const d=new Date(Date.parse(m[0])+(randint(0,1)?1:-1)*86400000);
  const p=n=>String(n).padStart(2,"0");
  return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+String(s).slice(10);
}
function _emailFuzz(s){
  s=String(s); const at=s.indexOf("@"); if(at<1) return _typo(s);
  const op=randint(0,2);
  if(op===0) return s.slice(0,at).replace(/\./g,"")+s.slice(at);
  if(op===1) return _typo(s.slice(0,at))+s.slice(at);
  return s.toLowerCase();
}
function damageValue(kind,lvl,v){
  if(v===null||v===undefined||v==="") return v;
  if(kind==="email")  return lvl==="light"?_flipCase(v):_emailFuzz(v);
  if(kind==="phone")  return _phoneFmt(v);
  if(kind==="date")   return _dateShift(v,lvl==="heavy");
  if(kind==="digits") return _digitSwap(v);
  if(kind==="number") return typeof v==="number"?v+randint(-1,1):v;
  if(lvl==="light")   return randint(0,1)?_flipCase(v):_space(v);
  if(lvl==="medium"){const op=randint(0,2);return op===0?_typo(v):op===1?_flipCase(v):_space(v);}
  const op=randint(0,3);
  return op===0?_typo(_typo(v)):op===1?_typo(v):op===2?"":_flipCase(v);
}
function damageRow(en,flat,lvl){
  const c={}; for(const k in flat){const v=flat[k];c[k]=Array.isArray(v)?v.slice():v;}
  /* a duplicate is a distinct system record: regenerate its system identifiers */
  for(const f of en.fields) if(fieldKind(f)==="uuid")
    c[f.name]=Array.isArray(c[f.name])?c[f.name].map(()=>uuid()):uuid();
  if(lvl==="targeted"){
    for(const f of en.fields){
      if(!f.sim||!f.sim.algo||fieldKind(f)==="keep"||fieldKind(f)==="uuid") continue;
      const t=Math.min(Math.max(parseFloat(f.sim.target)||0.9,0.5),1);
      const v=c[f.name];
      const cor=x=>{
        const r=corruptToTarget(x,f.sim.algo,t);
        return (typeof x==="number"&&r!==""&&!isNaN(Number(r)))?Number(r):r;
      };
      if(Array.isArray(v)) c[f.name]=v.map(x=>x===null||x===undefined||x===""?x:cor(x));
      else if(v!==undefined&&v!==null&&v!=="") c[f.name]=cor(v);
    }
    return c;
  }
  const cand=en.fields.filter(f=>{
    const k=fieldKind(f);
    if(k==="keep"||k==="uuid") return false;
    if(lvl!=="heavy"&&k==="number") return false;
    if(lvl==="light"&&(k==="date"||k==="digits")) return false;
    const v=c[f.name]; return v!==undefined&&v!==null&&v!=="";
  });
  if(!cand.length) return c;
  const n=Math.min(lvl==="light"?1:lvl==="medium"?randint(1,2):randint(2,3),cand.length);
  const idxs=cand.map((_,i)=>i);
  for(let k=idxs.length-1;k>0;k--){const j=Math.floor(rnd()*(k+1));[idxs[k],idxs[j]]=[idxs[j],idxs[k]];}
  for(const ix of idxs.slice(0,n)){
    const f=cand[ix], kind=fieldKind(f), v=c[f.name];
    if(Array.isArray(v)){ if(v.length){const j=randint(0,v.length-1);v[j]=damageValue(kind,lvl,v[j]);} }
    else c[f.name]=damageValue(kind,lvl,v);
  }
  return c;
}
function applyDuplicates(en,rows){
  const lvl=en.dupLevel;
  const pct=Math.min(Math.max(parseInt(en.dupPct)||20,1),100);
  const maxV=Math.min(Math.max(parseInt(en.dupMax)||2,1),5);
  let mkey="match_id";
  while(en.fields.some(f=>f.name.trim()===mkey)) mkey="_"+mkey;
  const mseg={f:{name:mkey,type:"Static Value",opts:{}},
              segs:[{key:mkey,repeat:null,attr:false}], rp:null};
  const parsed=[mseg,...rows[0].parsed];
  const out=[];
  rows.forEach((r,ix)=>{
    const mid="M"+String(ix+1).padStart(5,"0");
    r.flat[mkey]=mid;
    out.push({flat:r.flat,parsed});
    if(rnd()*100<pct){
      const n=randint(1,maxV);
      for(let k=0;k<n;k++){
        const c=damageRow(en,r.flat,lvl);
        c[mkey]=mid;
        out.push({flat:c,parsed,base:r.flat});
      }
    }
  });
  for(let k=out.length-1;k>0;k--){const j=Math.floor(rnd()*(k+1));[out[k],out[j]]=[out[j],out[k]];}
  const rn=en.fields.filter(f=>f.type==="Row Number").map(f=>f.name);
  if(rn.length) out.forEach((r,i)=>rn.forEach(nm=>{if(!Array.isArray(r.flat[nm]))r.flat[nm]=i+1;}));
  return out;
}

/* ---------- Run: entities in tab order, sharing a value registry ----------
   Entities are generated left to right so a Reference field can only point at
   an entity already generated -- that ordering is the contract the UI states.

   This function is synchronous from initRun() to the last row on purpose. The
   RNG is module state, so an await anywhere inside would let a second caller
   reseed mid-run and silently corrupt both results. Node's single thread makes
   that safe as long as it stays synchronous; keep it that way. */
function entRowCount(en){
  const n=parseInt(en.rows,10);
  return Math.min(Math.max(Number.isFinite(n)?n:100,1),10000);
}
function runAll(entities, countFor, seedInput){
  const seed=initRun(seedInput);
  const errors=[], registry={}, results=[];
  for(const en of entities){
    let {rows}=generateRows(en.fields, countFor(en), registry, errors);
    if(en.dupLevel&&en.dupLevel!=="off"&&rows.length&&en.fields.length) rows=applyDuplicates(en,rows);
    const reg={};
    for(const f of en.fields){
      const vals=[];
      for(const r of rows){const v=r.flat[f.name];if(Array.isArray(v))vals.push(...v);else if(v!==undefined)vals.push(v);}
      reg[f.name]=vals;
    }
    registry[en.name]=reg;
    results.push({en,rows});
  }
  return {results,errors,seed,registry};
}

/* ---------- Serialize one entity's rows in the requested format ---------- */
function serializeRows(rows, en, fmt){
  if(fmt==="xml") return {out:toXml(rows,en.root||"records",en.record||"record"),mime:"application/xml",ext:"xml"};
  if(fmt==="csv") return {out:toCsv(rows),mime:"text/csv",ext:"csv"};
  return {out:toJson(rows),mime:"application/json",ext:"json"};
}
/* Rows as plain JS values, for callers that want to re-serialize themselves. */
function rowsToObjects(rows){ return rows.map(r=>nodeToObj(buildTree(r))); }

export {
  /* faker binding */
  useFaker, hasFaker, getFaker, getCatalog, fk, FAKER_METHODS,
  /* randomness */
  mulberry32, rnd, randint, pick, uuid, POOL,
  /* types + model */
  TYPES, TYPE_NAMES, newEntity, newField, nextFieldId,
  /* names + formulas */
  parseName, repeatPrefix, HELPERS, evalFormula,
  /* generation */
  initRun, generateRows, entRowCount, runAll,
  /* shaping + output */
  buildTree, nodeToObj, rowsToObjects, toXml, toJson, toCsv, serializeRows,
  /* similarity + duplicates */
  jaroWinkler, levSim, SIM_FNS, fieldKind, corruptToTarget,
  damageValue, damageRow, applyDuplicates
};
