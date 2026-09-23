"use strict";

/* ============================================================
   CURVA DE DEPRECIAÇÃO — v4
   Correções: doc.id no catálogo · desambiguação por CCT
   (nunca descarta) · decodificador de códigos posicionais
   ============================================================ */

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// ============================================
// CONFIG
// ============================================
const DEDUPLICAR          = true;
const USAR_CATALOGO_LOCAL = true;    // fallback da planilha; desligue quando o Firestore estiver completo
const CCT_PREFERIDA       = "4000K"; // usada quando o laudo não declara CCT
const POT_MAX_VALIDA      = 1500;    // acima disso é faixa concatenada (ex.: 2060 = "20W à 60W")
const TOL_POT_W           = 2;       // tolerância de busca de potência no catálogo

const CONFIG_CONTRATOS = {
  UDI: { tipo: "padrao", paths: ["Ensaios Laboratório/1º Marco/itens", "Ensaios Laboratório/2º Marco/itens", "Ensaios Laboratório/3º Marco/itens", "ensaios"] },
  PNZ: { tipo: "padrao", paths: ["Ensaios Laboratório/1º Marco/itens", "Ensaios Laboratório/2º Marco/itens", "Ensaios Laboratório/3º Marco/itens", "ensaios"] },
  CWB: { tipo: "cwb",    paths: ["2023/nao_informado/ensaios", "anos/2023/meses/nao_informado/ensaios", "2025/fevereiro/ensaios", "anos/2025/meses/fevereiro/ensaios", "2025/maio/ensaios", "anos/2025/meses/maio/ensaios", "ensaios"] },
  BASE_LIMPA: { tipo: "padrao", paths: ["ensaios"] }
};

const CORES = { medido: "#0F6E56", limite: "#E24B4A", eficiencia: "#BA7517", tendencia: "#64748B" };

const MESES = { janeiro:1,fevereiro:2,marco:3,abril:4,maio:5,junho:6,julho:7,agosto:8,setembro:9,outubro:10,novembro:11,dezembro:12,jan:1,fev:2,mar:3,abr:4,mai:5,jun:6,jul:7,ago:8,set:9,out:10,nov:11,dez:12 };

const VAZIOS = new Set(["","-","--","N/A","NA","NONE","NULL","UNDEFINED","NAN","NAO INFORMADO","NAO_INFORMADO","SEM INFORMACAO","SEM FAMILIA","SEM-FAMILIA","0"]);

// ============================================
// ESTADO
// ============================================
let chartFluxo = null, chartEfic = null;
let catalogo = [], idxSku = new Map(), idxFamPot = new Map(), potPorFamilia = new Map();
let grupos = {}, marcosAtuais = [];
let diagnostico = { erros: [], duplicatas: 0, semFamilia: [],
  catalogoDescartado: [], conflitosPotencia: [] };


// ============================================
// DICIONÁRIO DE FAMÍLIAS (ordem = prioridade)
// ============================================
const FAMILIAS = [
  // Tecnowatt
  { fam: "TAU-T",           rx: /\bTAU[\s\-]*T\b/ },
  { fam: "TAU",             rx: /\b(?:TW[\s\-]*)?TAU\b/ },
  { fam: "ESAT PRO",        rx: /\bESAT[\s\-]*PRO\b/ },
  { fam: "ESAT PLUS",       rx: /\bESAT[\s\-]*PLUS\b/ },
  { fam: "ESAT PLUS",       rx: /\bPLUS\s*\d{2,3}\s*W?\b/ },   // grafia truncada nos laudos
  { fam: "ESAT",            rx: /\bESAT\b/ },
  { fam: "LUMEFLEX FLOOD",  rx: /\bLUMEFLEX\b/ },
  { fam: "NATH S",          rx: /\bNATH\b/ },
  // Urbjet / Brightlux
  { fam: "ORNAMENTAL GRD",  rx: /\bORNAMENTAL\b/ },
  { fam: "HTB2",            rx: /\bHTB2\b/ },
  { fam: "HBMI",            rx: /\bHBMI\b/ },
  { fam: "HTS",             rx: /\bHTS[\s\-]*\d{3,4}/ },
  { fam: "HTC-PCL",         rx: /\bPCL\b/ },                    // cobre "HTC-PCL-0404" e "PCL0604"
  { fam: "ORI",             rx: /\bORI[\s\-]*\d{3,4}/ },
  // Orion — SEM \b no fim: os SKUs são "NENAI3", "NENAII3", "NENAIV3"
  { fam: "ORION NENA",      rx: /NENA/ },
  // Philips/Signify: a série é a família
  { fam: null, rx: /\bBRP\s*[\-]?\s*(\d{3})/, prefixo: "BRP" },
  // Kingsun: o SKU é a família
  { fam: null, rx: /\bRL\s*[\-]?\s*(\d{6,7})/, prefixo: "RL" }
];

// SKUs Tecnowatt: o código já determina família + potência
const ALIAS_SKU = {
  TW4001893:["TAU",30], TW4001896:["TAU",40], TW4001899:["TAU",50], TW4001902:["TAU",60],
  TW4002336:["TAU",72], TW4002339:["TAU",72], TW4003222:["TAU-T",63],
  TW4002161MS:["ESAT PLUS",80],  TW4002149MS:["ESAT PLUS",115],
  TW4002143MS:["ESAT PLUS",140], TW4002097MS:["ESAT PLUS",165],
  TW4002884MS:["ESAT PLUS",115],
  TW4002867MS:["ESAT PRO",80],   TW4002832MS:["ESAT PRO",152]
};

const FABRICANTES = [
  [/SIGNIFY|PHILIPS/, "PHILIPS"], [/TECNOWATT|TECNO\s*WATT/, "TECNOWATT"],
  [/KINGSUN/, "KINGSUN"], [/BRIGHTLUX/, "BRIGHTLUX"],
  [/URBJET/, "URBJET"], [/ORION/, "ORION"], [/LENCO/, "LENCO"]
];

// Fabricante canônico por família (evita "HTC" ou "Brightlux" como fabricante do mesmo produto)
const FAB_POR_FAMILIA = {
  "TAU":"TECNOWATT","TAU-T":"TECNOWATT","ESAT":"TECNOWATT","ESAT PLUS":"TECNOWATT",
  "ESAT PRO":"TECNOWATT","LUMEFLEX FLOOD":"TECNOWATT","NATH S":"TECNOWATT",
  "HTC-PCL":"URBJET","HTS":"URBJET","HTB2":"URBJET","ORNAMENTAL GRD":"URBJET",
  "HBMI":"BRIGHTLUX","ORI":"BRIGHTLUX","ORION NENA":"ORION"
};

// ============================================
// COMPLEMENTO LOCAL (planilha) — fallback
// [fabricante, familia, potW, fluxoLm, eficLmW, cct, l70]
// ============================================
const CATALOGO_LOCAL = [
  ["TECNOWATT","TAU",19,2858,150,"5000K",102000],["TECNOWATT","TAU",21,3187,152,"5000K",102000],
  ["TECNOWATT","TAU",28,3973,142,"5000K",102000],["TECNOWATT","TAU",30,4020,134,"4000K",102000],
  ["TECNOWATT","TAU",35,4569,131,"5000K",102000],["TECNOWATT","TAU",40,5320,133,"4000K",102000],
  ["TECNOWATT","TAU",50,6750,135,"4000K",102000],["TECNOWATT","TAU",60,7500,125,"4000K",102000],
  ["TECNOWATT","TAU",64,8079,126,"5000K",102000],["TECNOWATT","TAU",72,8712,121,"5000K",102000],
  ["TECNOWATT","TAU",80,8712,109,"5000K",102000],
  ["TECNOWATT","TAU-T",33,5423,164,null,102000],["TECNOWATT","TAU-T",43,7034,164,null,102000],
  ["TECNOWATT","TAU-T",54,8414,156,null,102000],["TECNOWATT","TAU-T",64,9612,150,null,102000],
  ["TECNOWATT","TAU-T",74,10821,146,null,102000],["TECNOWATT","TAU-T",83,12113,146,null,102000],
  ["TECNOWATT","ESAT",42,4326,103,null,102000],["TECNOWATT","ESAT",54,5670,105,null,102000],
  ["TECNOWATT","ESAT",100,10000,100,null,102000],["TECNOWATT","ESAT",115,11500,100,null,102000],
  ["TECNOWATT","ESAT",130,13130,101,null,102000],["TECNOWATT","ESAT",150,15000,100,null,102000],
  ["TECNOWATT","ESAT PLUS",60,7812,130,"5000K",66000],["TECNOWATT","ESAT PLUS",80,10510,131,"5000K",66000],
  ["TECNOWATT","ESAT PLUS",90,12225,136,"5000K",66000],["TECNOWATT","ESAT PLUS",115,15581,135,"5000K",66000],
  ["TECNOWATT","ESAT PLUS",140,18700,134,"5000K",66000],["TECNOWATT","ESAT PLUS",150,19977,133,"5000K",66000],
  ["TECNOWATT","ESAT PLUS",165,21116,128,"5000K",66000],["TECNOWATT","ESAT PLUS",175,21899,125,"5000K",66000],
  ["TECNOWATT","ESAT PLUS",190,23559,124,"5000K",66000],["TECNOWATT","ESAT PLUS",200,23350,117,"5000K",66000],
  ["TECNOWATT","NATH S",100,11700,117,null,102000],["TECNOWATT","NATH S",113,12769,113,null,102000],
  ["TECNOWATT","NATH S",130,14300,110,null,102000],["TECNOWATT","NATH S",147,15435,105,null,102000],
  ["TECNOWATT","NATH S",180,19800,110,null,102000],["TECNOWATT","NATH S",200,21400,107,null,102000],
  ["PHILIPS","BRP220",40,4000,100,"4000K",50000],["PHILIPS","BRP220",60,5400,100,"4000K",50000],
  ["PHILIPS","BRP221",42,6400,150,"4000K",78000],
  ["PHILIPS","BRP230",18,3000,167,null,50000],["PHILIPS","BRP230",31,5000,161,null,50000],
  ["PHILIPS","BRP230",42,6500,155,null,50000],["PHILIPS","BRP230",52,7800,150,null,50000],
  ["PHILIPS","BRP230",65,9000,138,null,50000],
  ["PHILIPS","BRP371",68,8000,120,"4000K",50000],["PHILIPS","BRP371",88,10500,120,"4000K",50000],
  ["PHILIPS","BRP371",114,12500,120,"4000K",50000],
  ["PHILIPS","BRP481",24,4300,179,null,78000],["PHILIPS","BRP481",27,5100,189,null,78000],
  ["PHILIPS","BRP481",33,6000,182,null,78000],["PHILIPS","BRP481",41,7300,178,null,78000],
  ["PHILIPS","BRP481",48,8500,177,null,78000],["PHILIPS","BRP481",55,9600,175,null,78000],
  ["PHILIPS","BRP482",56,10400,186,null,78000],["PHILIPS","BRP482",61,11300,185,null,78000],
  ["PHILIPS","BRP482",70,12600,180,null,78000],["PHILIPS","BRP482",76,13600,179,null,78000],
  ["PHILIPS","BRP482",83,14700,177,null,78000],["PHILIPS","BRP482",92,16000,174,null,78000],
  ["PHILIPS","BRP482",100,17200,172,null,78000],["PHILIPS","BRP482",105,17900,170,null,78000],
  ["PHILIPS","BRP482",110,18600,169,null,78000],
  ["PHILIPS","BRP483",113,20200,179,null,78000],["PHILIPS","BRP483",122,21600,177,null,78000],
  ["PHILIPS","BRP483",136,23600,174,null,78000],["PHILIPS","BRP483",150,25500,170,null,78000],
  ["PHILIPS","BRP483",165,27400,166,null,78000],
  ["PHILIPS","BRP484",169,29200,173,null,78000],["PHILIPS","BRP484",179,30700,172,null,78000],
  ["PHILIPS","BRP485",185,32800,177,null,78000],["PHILIPS","BRP486",195,35100,180,null,78000],
  ["URBJET","HTC-PCL",22,4356,198,"4000K",102000],["URBJET","HTC-PCL",30,5880,196,"4000K",102000],
  ["URBJET","HTC-PCL",50,9700,194,"4000K",102000],["URBJET","HTC-PCL",70,13370,191,"4000K",102000],
  ["URBJET","HTC-PCL",80,15040,188,"4000K",102000],["URBJET","HTC-PCL",100,18600,186,"4000K",102000],
  ["URBJET","HTC-PCL",120,21360,178,"4000K",102000],
  ["ORION","ORION NENA",26,4420,170,null,102000],["ORION","ORION NENA",38,6460,170,null,102000],
  ["ORION","ORION NENA",47,7990,170,null,102000],["ORION","ORION NENA",58,9860,170,null,102000],
  ["ORION","ORION NENA",69,11730,170,null,102000],["ORION","ORION NENA",78,13260,170,null,102000],
  ["ORION","ORION NENA",87,14790,170,null,102000],["ORION","ORION NENA",97,16490,170,null,102000],
  ["ORION","ORION NENA",116,19720,170,null,102000],["ORION","ORION NENA",148,25160,170,null,102000],
  ["ORION","ORION NENA",178,30260,170,null,102000],["ORION","ORION NENA",197,33490,170,null,102000],
  ["ORION","ORION NENA",239,40630,170,null,102000],["ORION","ORION NENA",259,44030,170,null,102000]
];

// ============================================
// UTILS
// ============================================
function fmt(n,d=1){return (n===null||n===undefined||isNaN(n))?"—":Number(n).toFixed(d);}
function fmtPerc(n){return (n!==null&&n!==undefined&&!isNaN(n))?fmt(n)+"%":"—";}
function fmtInt(n){return (n===null||n===undefined||isNaN(n))?"—":Number(n.toFixed(0)).toLocaleString("pt-BR");}
function pad2(n){return String(n).padStart(2,"0");}
function stripAcentos(s){return String(s??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"");}
function up(s){return stripAcentos(s).toUpperCase().trim();}
function norm(s){return up(s).replace(/[^A-Z0-9]/g,"");}
function initial(s){const t=String(s??"").trim();return t?t.charAt(0).toUpperCase():"?";}
function vazio(v){return (v===null||v===undefined||v==="")||VAZIOS.has(up(v));}

function parseNum(v){
  if(v===null||v===undefined||v==="") return NaN;
  if(typeof v==="number") return isFinite(v)?v:NaN;
  let s=String(v).trim().replace(/[^\d.,\-]/g,"");
  if(!s) return NaN;
  const p=s.includes("."), c=s.includes(",");
  if(p&&c) s=s.replace(/\./g,"").replace(",",".");
  else if(c) s=s.replace(",",".");
  else if(p&&/^-?\d{1,3}(\.\d{3})+$/.test(s)) s=s.replace(/\./g,"");
  const n=parseFloat(s);
  return isFinite(n)?n:NaN;
}
function safePerc(v,b){
  if(b===null||b===undefined||isNaN(b)||b<=0) return null;
  if(v===null||v===undefined||isNaN(v)) return null;
  return (v/b)*100;
}
function mediana(arr){
  const a=arr.slice().sort((x,y)=>x-y), n=a.length;
  if(!n) return NaN;
  return n%2 ? a[(n-1)/2] : (a[n/2-1]+a[n/2])/2;
}
function corDesvio(n,isNC=false){
  if(n===null||n===undefined||isNaN(n)) return "";
  if(isNC) return n>0?"color: var(--red-mid); font-weight: bold;":"color: var(--teal);";
  return n<0?"color: var(--red-mid); font-weight: bold;":"color: var(--teal);";
}
function pillClass(p){
  if(p===null||isNaN(p)) return "na";
  if(p>110) return "warn";              // nominal suspeito, não conformidade
  return p>=95?"ok":p>=90?"warn":"bad";
}
function pillLabel(p){
  if(p===null||isNaN(p)) return "N/A";
  if(p>110) return "⚠ Verificar nominal";
  return p>=95?"✓ Regular":p>=90?"⚠ Atenção":"✕ Crítico";
}

function escapeHtml(s){return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}

// ---------- datas ----------
function pareceData(v){
  if(v&&(typeof v.toDate==="function"||typeof v.seconds==="number")) return true;
  if(v instanceof Date) return !isNaN(v.getTime());
  const s=up(v).toLowerCase();
  if(!s||VAZIOS.has(s.toUpperCase())) return false;
  if(/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s)) return true;
  if(/^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}/.test(s)) return true;
  if(/^[a-z]+[\s/\-.]+\d{4}$/.test(s)&&MESES[s.split(/[\s/\-.]+/)[0]]!==undefined) return true;
  return /^(19|20)\d{2}$/.test(s);
}
function dataDoPath(path){
  if(!path) return null;
  const p=up(path).toLowerCase().split("/");
  const ano=p.find(x=>/^(19|20)\d{2}$/.test(x)), mes=p.find(x=>MESES[x]!==undefined);
  if(ano&&mes) return `01/${pad2(MESES[mes])}/${ano}`;
  return ano?`01/01/${ano}`:null;
}
function normalizarData(raw,pathHint){
  if(raw&&typeof raw.toDate==="function") raw=raw.toDate();
  else if(raw&&typeof raw.seconds==="number") raw=new Date(raw.seconds*1000);
  if(raw instanceof Date&&!isNaN(raw.getTime()))
    return `${pad2(raw.getDate())}/${pad2(raw.getMonth()+1)}/${raw.getFullYear()}`;
  const s=(raw??"").toString().trim();
  if(!s||VAZIOS.has(up(s))||["SEM DATA","S/ DATA"].includes(up(s)))
    return dataDoPath(pathHint)||"S/ Data";
  let m=s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if(m) return `${pad2(m[3])}/${pad2(m[2])}/${m[1]}`;
  m=s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if(m) return `${pad2(m[1])}/${pad2(m[2])}/${m[3].length===2?"20"+m[3]:m[3]}`;
  m=up(s).toLowerCase().match(/^([a-z]+)[\s/\-.]+(\d{4})$/);
  if(m&&MESES[m[1]]!==undefined) return `01/${pad2(MESES[m[1]])}/${m[2]}`;
  m=s.match(/^((19|20)\d{2})$/);
  if(m) return `01/01/${m[1]}`;
  return dataDoPath(pathHint)||s;
}
function parseDateString(d){
  if(!d||d==="S/ Data") return 0;
  const br=String(d).split("/");
  if(br.length===3){
    const [dd,mm,yy]=br.map(x=>parseInt(x,10));
    if(![dd,mm,yy].some(isNaN)) return yy*10000+mm*100+dd;
  }
  return 99999999;
}
function toDate(d){
  const k=parseDateString(d);
  if(k===0||k===99999999) return null;
  const p=String(d).split("/");
  const dt=new Date(+p[2],+p[1]-1,+p[0]);
  return isNaN(dt.getTime())?null:dt;
}
function diffDias(a,b){return Math.round((b-a)/86400000);}
function labelData(d){
  if(!d||d==="S/ Data") return "S/ Data";
  const p=String(d).split("/");
  return p.length===3?`${p[0]}/${p[1]}/${p[2].slice(-2)}`:d;
}
function dataParaTexto(dt){return `${pad2(dt.getDate())}/${pad2(dt.getMonth()+1)}/${dt.getFullYear()}`;}

// ---------- UI ----------
function showStatus(type,title,body=""){
  const icons={loading:"ti-loader-2",success:"ti-circle-check",warning:"ti-alert-triangle",error:"ti-alert-circle"};
  const el=document.getElementById("statusBanner"); if(!el) return;
  el.className=`status-banner visible ${type}`;
  el.innerHTML=`${type==="loading"?`<div class="spinner"></div>`:`<i class="ti ${icons[type]}"></i>`}
    <div class="status-text"><strong>${title}</strong>${body?`<span>${body}</span>`:""}</div>`;
}
function setMetricCard(id,value,sub,cls){
  const c=document.getElementById(id); if(!c) return;
  const v=c.querySelector(".metric-value"); if(v){v.className=`metric-value ${cls||""}`;v.textContent=value;}
  const s=c.querySelector(".metric-sub"); if(s&&sub!=null) s.textContent=sub;
}
window.toggleSubRow=function(id){
  const sr=document.getElementById(id); if(!sr) return;
  const icon=sr.previousElementSibling?.querySelector(".expand-icon");
  const aberto=sr.style.display!=="none";
  sr.style.display=aberto?"none":"table-row";
  if(icon) icon.style.transform=aberto?"rotate(0deg)":"rotate(90deg)";
};

// ============================================
// IDENTIDADE
// ============================================
/** Corrige typos que quebram os regexes (RLL0410284 -> RL0410284) */
function limparTexto(txt){
  return up(txt).replace(/[_.]+/g," ")
                .replace(/\bRLL(\d)/g,"RL$1")
                .replace(/\s+/g," ").trim();
}

function detectarFabricante(txt){
  const t=up(txt);
  for(const [rx,nome] of FABRICANTES) if(rx.test(t)) return nome;
  return null;
}

function detectarSku(txt){
  const t=limparTexto(txt);
  let m;
  if((m=t.match(/\bTW\s?(\d{7})\s?(MS)?\b/)))      return "TW"+m[1]+(m[2]||"");
  if((m=t.match(/\bRL\s?[\-]?\s?(\d{6,7})\b/)))     return "RL"+m[1];
  if((m=t.match(/\bHT[BCS][\w\-]{2,}\b/)))          return norm(m[0]);
  if((m=t.match(/\bHBMI[\w\-]{2,}\b/)))             return norm(m[0]);
  if((m=t.match(/\bORI[\s\-]?\d{4}[\w\-]*\b/)))     return norm(m[0]);
  if((m=t.match(/\bLP[\-\s]?NENA[\w.\-]*\b/)))      return norm(m[0]);
  if((m=t.match(/\bPCL[\s\-]?[0-9A-Z]{4}[\w\-]*\b/))) return "HTC"+norm(m[0]);
  return null;
}

function detectarFamilia(txt){
  const t = limparTexto(txt);
  for(const f of FAMILIAS){
    const m = t.match(f.rx);
    if(m) return f.fam || (f.prefixo + (m[1] ?? "")).trim();
  }
  return null;
}


/** Decodifica potência/CCT embutidas no código do produto */
function decodificarCodigo(txt){
  const t = limparTexto(txt);
  let m;

  // ORION: "026W3K0DME7P" -> 26 W / 3000 K
  if((m = t.match(/(\d{2,4})\s*W\s*([3-6])\s*K/)))
    return { pot:+m[1], cct:m[2]+"000K", curinga:false, via:"orion" };

  // Urbjet/Brightlux posicional: PCL-0604 / HTS-0203 / HBMI-0503 / ORI-1204
  // aceita bloco alfabético (AAAB) e X como curinga de variante
  if((m = t.match(/\b(?:PCL|HTS|HBMI|ORI)[\s\-]*([0-9A-Z]{3})([0-9A-Z])(?![0-9])/))){
    const bloco = m[1], dig = m[2];
    const pot = /^\d{3}$/.test(bloco) ? parseInt(bloco, 10) : null;
    const cct = /^[3-6]$/.test(dig)   ? dig + "000K"        : null;
    return {
      pot: (pot !== null && pot > 0) ? pot : null,
      cct,
      curinga: pot === null,                    // ex.: PCL-AAAB = documento-modelo
      via: "posicional"
    };
  }

  // HTB2-150X
  if((m = t.match(/\bHTB2[\s\-]*(\d{3})([0-9A-Z])?/))){
    const dig = m[2];
    return {
      pot:+m[1],
      cct: (dig && /^[3-6]$/.test(dig)) ? dig + "000K" : null,
      curinga:false, via:"htb2"
    };
  }

  return { pot:null, cct:null, curinga:false, via:null };
}


function detectarCct(txt){
  const t=limparTexto(txt);
  const achados=new Set();
  let m;
  const rx1=/\b([3-6])[.,]?0{3}\s*K\b/g;   // 4000K / 4.000K
  while((m=rx1.exec(t))) achados.add(m[1]+"000K");
  const rx2=/\b([3-6])\s?K\b/g;            // 4K
  while((m=rx2.exec(t))) achados.add(m[1]+"000K");
  const d=decodificarCodigo(t);
  if(d.cct) achados.add(d.cct);
  if(/\bNW\b/.test(t)) achados.add("4000K");
  if(/\bWW\b/.test(t)) achados.add("3000K");
  if(/\bCW\b/.test(t)) achados.add("5000K");
  // faixa (ex.: "4.000K - 5.000K") => universal
  if(achados.size!==1) return null;
  return achados.values().next().value;
}

function detectarPotenciaTexto(txt){
  const t=limparTexto(txt);
  const rx=/(^|[^A-Z0-9])(\d{1,4}(?:[.,]\d)?)\s*W(?![A-Z0-9])/g;
  const cands=[]; let m;
  while((m=rx.exec(t))){
    const v=parseNum(m[2]);
    if(!isNaN(v)&&v>=5&&v<=POT_MAX_VALIDA) cands.push(v);
  }
  if(cands.length) return cands[0];
  const d=decodificarCodigo(t);
  return (d.pot!==null&&d.pot>=5&&d.pot<=POT_MAX_VALIDA)?d.pot:null;
}

function detectarLed(txt){
  const m=limparTexto(txt).match(/LED\s*[\-]?\s*(\d{2,4})\s*[-/–]?\s*(\d{1,2})?\s*S?\b/);
  if(!m) return { ledNum:null, ledSeg:null };
  const n=parseInt(m[1],10);
  return { ledNum:(isNaN(n)||n<10)?null:n, ledSeg:m[2]?parseInt(m[2],10):null };
}

/**
 * Identidade canônica de um item (laudo ou catálogo).
 * Prioridade da potência: ALIAS_SKU > campo declarado > texto/código > medida.
 */
function identificar(textoLivre, potCampo, fabCampo, cctCampo){
  const txt = [textoLivre, fabCampo].filter(Boolean).join(" ");
  const sku = detectarSku(txt);
  let familia = null, pot = null, origemPot = null, conflitoPot = null;

  if(sku && ALIAS_SKU[sku]){ familia = ALIAS_SKU[sku][0]; pot = ALIAS_SKU[sku][1]; origemPot = "sku"; }
  if(!familia) familia = detectarFamilia(txt);
  if(!familia && sku) familia = sku;

  const pDecl  = parseNum(potCampo);
  const pTexto = detectarPotenciaTexto(txt);
  const declOk = !isNaN(pDecl) && pDecl >= 3 && pDecl <= POT_MAX_VALIDA;

  // conflito material entre o código do modelo e o campo declarado
  if(pot === null && declOk && pTexto !== null &&
     Math.abs(pDecl - pTexto) / Math.max(pDecl, pTexto) > 0.15){
    pot = pTexto; origemPot = "texto (conflito)";
    conflitoPot = { declarada: pDecl, texto: pTexto };
  }

  if(pot === null && declOk){ pot = pDecl;  origemPot = "declarada"; }
  if(pot === null && pTexto !== null){ pot = pTexto; origemPot = "texto"; }
  if(pot === null && !isNaN(pDecl) && pDecl > 0){ pot = pDecl; origemPot = "medida"; }

  const led = detectarLed(txt);
  const cct = detectarCct([cctCampo, txt].filter(Boolean).join(" "));

  return {
    fabricante: FAB_POR_FAMILIA[familia] || detectarFabricante(txt),
    familia, sku, pot, origemPot, cct, conflitoPot,
    ledNum: led.ledNum, ledSeg: led.ledSeg,
    texto: String(textoLivre || "").trim()
  };
}

/** Aproxima potência medida em circuito para a nominal cadastrada (±12%) */
function snapPotencia(familia,pot){
  if(!familia||pot===null) return pot;
  const set=potPorFamilia.get(familia);
  if(!set||!set.size) return pot;
  let melhor=null,dist=Infinity;
  set.forEach(p=>{const d=Math.abs(p-pot); if(d<dist){dist=d;melhor=p;}});
  return (melhor!==null&&dist/melhor<=0.12)?melhor:pot;
}

function chaveGrupo(idt){
  if(idt.familia&&idt.pot) return `${idt.familia}|${Math.round(idt.pot)}`;
  if(idt.familia)          return `${idt.familia}|?`;
  return "SEMFAMILIA|"+(norm(idt.texto).slice(0,30)||"VAZIO");
}
function rotuloGrupo(idt){
  if(idt.familia&&idt.pot) return `${idt.familia} ${Math.round(idt.pot)}W`;
  if(idt.familia)          return `${idt.familia} (potência não identificada)`;
  return idt.texto||"sem identificação";
}

// ============================================
// REPARO DO NOMINAL ("8.500 lm" -> 8.5)
// ============================================
function repararFluxo(fluxoRaw,pot,efic){
  let f=parseNum(fluxoRaw);
  if(isNaN(f)||f<=0) return { valor:NaN, reparado:false };
  const p=parseNum(pot), e=parseNum(efic);
  const alvo=(!isNaN(p)&&p>0) ? p*((!isNaN(e)&&e>20)?e:140) : null;
  if(alvo===null) return f<200 ? { valor:f*1000, reparado:true } : { valor:f, reparado:false };
  let melhor=f, dist=Math.abs(f-alvo);
  [f*10,f*100,f*1000].forEach(c=>{const d=Math.abs(c-alvo); if(d<dist){dist=d;melhor=c;}});
  return { valor:melhor, reparado:melhor!==f };
}
function plausivel(fluxo,pot){
  const p=parseNum(pot);
  if(isNaN(p)||p<=0||isNaN(fluxo)) return true;
  const lmw=fluxo/p;
  return lmw>=40&&lmw<=280;
}

// ============================================
// RESOLVEDOR DE CAMPOS
// ============================================
function normKey(k){return up(k).replace(/[^A-Z0-9]/g,"");}
function achatarDoc(obj, pref="", out={}, prof=0){
  if(!obj || typeof obj!=="object" || prof>6) return out;

  Object.keys(obj).forEach(k=>{
    const v   = obj[k];
    const cam = pref ? `${pref}.${k}` : k;
    const ts  = v && (typeof v.toDate==="function" || typeof v.seconds==="number");

    // 1) arrays: achata por índice (resultados[], amostras[], ensaios[]...)
    if(Array.isArray(v)){
      v.forEach((it,i)=>{
        const ci = `${cam}.${i}`;
        const tsi = it && (typeof it.toDate==="function" || typeof it.seconds==="number");
        if(it && typeof it==="object" && !tsi && !(it instanceof Date)){
          achatarDoc(it, ci, out, prof+1);
        } else {
          out[ci] = it;
        }
      });
      return;
    }

    // 2) objetos aninhados (exceto Timestamp/Date)
    if(v && typeof v==="object" && !ts && !(v instanceof Date)){
      achatarDoc(v, cam, out, prof+1);
      return;
    }

    // 3) folha
    out[cam] = v;
  });

  return out;
}
   
function buscarCampo(flat,cfg){
  let melhor=null,pts=-1;
  for(const cam of Object.keys(flat)){
    const v=flat[cam];
    if(v===null||v===undefined||v==="") continue;
    const nk=normKey(cam);
    let p=-1;
    cfg.inclui.forEach((rx,i)=>{ if(rx.test(nk)) p=Math.max(p,100-i*4); });
    if(p<0) continue;
    if(cfg.exclui&&cfg.exclui.some(rx=>rx.test(nk))) continue;
    (cfg.bonus||[]).forEach(([rx,b])=>{ if(rx.test(nk)) p+=b; });
    if(cfg.tipo==="num"){
      const n=parseNum(v);
      if(isNaN(n)||n<=0) continue;
      if(cfg.min!==undefined&&n<cfg.min) continue;
      if(cfg.max!==undefined&&n>cfg.max) continue;
    } else if(cfg.tipo==="texto"){
      const s=String(v).trim();
      if(!s||VAZIOS.has(up(s))) continue;
      if(cfg.maxLen&&s.length>cfg.maxLen) continue;
    } else if(cfg.tipo==="data"&&!pareceData(v)) continue;
    if(p>pts){ pts=p; melhor={caminho:cam,valor:v}; }
  }
  return melhor;
}

// Regras para documentos do CATÁLOGO (min baixo no fluxo: valores corrompidos entram para reparo)
const REGRAS_CAT = {
  fluxo:{tipo:"num",min:0.5,max:400000,inclui:[/FLUXOLUMINOSO/,/FLUXOTOTAL/,/^FLUXO/,/FLUXO/,/LUMENS/,/^LM$/],exclui:[/EFICAC/,/EFICIENC/,/PERCENT/,/MANTIDO/,/DEPRECI/,/MEDID/]},
  efic:{tipo:"num",min:20,max:400,inclui:[/EFICACIALUMINOSA/,/EFICACIA/,/EFICIENCIALUMINOSA/,/EFICIENCIA/,/LMW/],exclui:[/PERCENT/,/ENERGETIC/]},
  pot:{tipo:"num",min:3,max:POT_MAX_VALIDA,inclui:[/POTENCIAW/,/POTENCIANOMINAL/,/^POTENCIA/,/POTENCIA/,/WATT/,/^POT/],exclui:[/FATOR/,/FP$/,/DENSIDADE/]},
  cct:{tipo:"texto",maxLen:40,inclui:[/TEMPERATURACOR/,/TEMPERATURADECOR/,/TEMPERATURA/,/^CCT/,/CORRELAT/]},
  l70:{tipo:"num",min:100,max:500000,inclui:[/L70/,/VIDAUTILLEDS/,/VIDAUTIL/,/VIDA/]},
  modelo:{tipo:"texto",maxLen:160,inclui:[/^MODELO/,/MODELO/,/^CODIGO/,/CODIGOPRODUTO/,/^SKU/,/REFERENCIA/],exclui:[/FOTOMETR/,/DRIVER/]},
  familia:{tipo:"texto",maxLen:80,inclui:[/^FAMILIA/,/FAMILIA/,/LINHA/,/SERIE/]}
};

// Regras para documentos de ENSAIO
const REGRAS = {
  fabricante:{tipo:"texto",maxLen:60,inclui:[/^FABRICANTE/,/FABRICANTE/,/^MARCA/,/MANUFACTUR/,/FORNECEDOR/],exclui:[/CNPJ/,/ENDERECO/,/CIDADE/,/CONTATO/]},
  modelo:{tipo:"texto",maxLen:160,inclui:[/MODELOLUMINARIA/,/^MODELO/,/MODELO/,/^MODEL/,/CODIGOPRODUTO/,/REFERENCIA/,/PRODUTO/,/DESCRICAO/],exclui:[/MODELOFOTOMETR/,/MODELODRIVER/],bonus:[[/DESCRICAO/,-30]]},
  potencia:{tipo:"num",min:3,max:3000,inclui:[/POTENCIADECLARAD/,/POTENCIANOMINAL/,/^POTENCIA/,/POTENCIA/,/WATT/],exclui:[/FATOR/,/FP$/,/DENSIDADE/],bonus:[[/DECLARAD|NOMINAL|CATALOGO/,25],[/MEDID|REAL|CIRCUITO/,-12]]},
  fluxo:{tipo:"num",min:50,max:300000,inclui:[/FLUXOLUMINOSO/,/FLUXOTOTAL/,/^FLUXO/,/FLUXO/,/LUMENS/],exclui:[/EFICAC/,/EFICIENC/,/PERCENT/,/MANTIDO/],bonus:[[/MEDID|REAL|ENSAIO|LUMINARIA/,25],[/DECLARAD|NOMINAL|CATALOGO/,-25]]},
  eficacia:{tipo:"num",min:10,max:400,inclui:[/EFICACIA/,/EFICIENCIALUMINOSA/,/EFICIENCIA/,/LMW/],exclui:[/PERCENT/,/ENERGETIC/],bonus:[[/MEDID|REAL|ENSAIO|TOTAL/,25],[/DECLARAD|NOMINAL/,-25]]},
  cct:{tipo:"texto",maxLen:40,inclui:[/TEMPERATURACOR/,/TEMPERATURA/,/^CCT/,/CORRELAT/]},
  data:{tipo:"data",inclui:[/DATARECEB/,/RECEBIMENTOAMOSTRA/,/RECEBIMENTO/,/DATAENSAIO/,/DATARELATORIO/,/DATAEMISSAO/,/^DATA/,/^DT/],exclui:[/VALIDADE/,/CALIBRAC/,/FABRICACAO/]},
  identificador:{tipo:"texto",maxLen:200,inclui:[/^RELATORIO/,/RELATORIO/,/LAUDO/,/CERTIFICADO/,/PROTOCOLO/,/NUMEROENSAIO/,/ARQUIVO/]}
};

// ============================================
// CATÁLOGO
// ============================================
function registrarEntrada(e){
  catalogo.push(e);
  if(e.sku&&!idxSku.has(e.sku)) idxSku.set(e.sku,e);
  if(e.familia&&e.pot){
    const k=`${e.familia}|${Math.round(e.pot)}`;
    if(!idxFamPot.has(k)) idxFamPot.set(k,[]);
    idxFamPot.get(k).push(e);
    if(!potPorFamilia.has(e.familia)) potPorFamilia.set(e.familia,new Set());
    potPorFamilia.get(e.familia).add(Math.round(e.pot));
  }
}

async function carregarCatalogo(){
  catalogo=[]; idxSku=new Map(); idxFamPot=new Map(); potPorFamilia=new Map();
  diagnostico.catalogoDescartado=[];
  let lidos=0, ignorados=0, derivadas=0, ambiguas=0, semFluxo=0;
  const pendentes=[];   // registro diferido: permite ordenar por qualidade antes de indexar

  try{
    const snap = await db.collectionGroup("modelos").get();

    snap.forEach(doc=>{
      // 1) só o catálogo: collectionGroup casa qualquer subcoleção "modelos" do banco
      if(!doc.ref.path.startsWith("modelos_base/")) return;

      const d = doc.data() || {};
      const nChaves = Object.keys(d).length;
      // 2) placeholders: { _exists:true } ou documento vazio
      if(nChaves === 0 || (d._exists !== undefined && nChaves <= 1)){ ignorados++; return; }
      lidos++;

      const flat = achatarDoc(d);
      const pai  = doc.ref.parent.parent ? doc.ref.parent.parent.id : "";

      const rModelo  = buscarCampo(flat, REGRAS_CAT.modelo);
      const rFamilia = buscarCampo(flat, REGRAS_CAT.familia);
      const rPot     = buscarCampo(flat, REGRAS_CAT.pot);
      const rFluxo   = buscarCampo(flat, REGRAS_CAT.fluxo);
      const rEfic    = buscarCampo(flat, REGRAS_CAT.efic);
      const rCct     = buscarCampo(flat, REGRAS_CAT.cct);
      const rL70     = buscarCampo(flat, REGRAS_CAT.l70);

      const modelo = rModelo  ? String(rModelo.valor).trim()  : "";
      const famDoc = rFamilia ? String(rFamilia.valor).trim() : pai;

      // doc.id participa da identificação (os códigos posicionais vivem no id)
      const texto = [modelo, doc.id, famDoc, pai].filter(x=>!vazio(x)).join(" ");

      const idt  = identificar(texto, rPot ? rPot.valor : null, famDoc, rCct ? rCct.valor : null);
      const efic = rEfic ? parseNum(rEfic.valor) : NaN;

      // 3) resgate da potência via fluxo ÷ eficácia — só quando a escala é inequívoca
      let potDerivada = false, notaDeriv = null, derivAmbigua = false;
      if(idt.pot === null && !isNaN(efic) && efic > 20){
        const base = parseNum(rFluxo ? rFluxo.valor : null);
        if(!isNaN(base) && base > 0){
          const cands = [];
          [1,10,100,1000].forEach(esc=>{
            const fx = base*esc, p = fx/efic;
            // exige potência plausível E fluxo em faixa de luminária pública
            if(p >= 3 && p <= POT_MAX_VALIDA && fx >= 800 && fx <= 200000)
              cands.push({ esc, pot:Math.round(p), fx });
          });
          if(cands.length === 1){
            idt.pot = cands[0].pot; potDerivada = true;
            notaDeriv = `potência derivada de ${fmtInt(cands[0].fx)} lm ÷ ${fmt(efic)} lm/W`;
          } else if(cands.length > 1){
            derivAmbigua = true;   // ex.: 850/8500 lm → 5W ou 50W: não se adivinha
            notaDeriv = `escala do fluxo ambígua (${cands.map(c=>c.pot+"W").join(" ou ")})`;
          }
        }
      }

      if(!idt.familia || !idt.pot){
        const dec = decodificarCodigo(texto);
        diagnostico.catalogoDescartado.push({
          path: doc.ref.path, docId: doc.id, modelo, familia_doc: famDoc, pai,
          motivo: !idt.familia    ? "família não reconhecida"
                : derivAmbigua    ? notaDeriv
                : dec.curinga     ? "código curinga (ex.: PCL-AAAB) sem campo de potência"
                                  : "sem potência identificável",
          pot_campo:   rPot   ? rPot.valor   : null,
          fluxo_campo: rFluxo ? rFluxo.valor : null,
          efic_campo:  rEfic  ? rEfic.valor  : null,
          campos: Object.keys(flat).slice(0,25).join(", ")
        });
        if(derivAmbigua) ambiguas++;
        return;
      }
      if(potDerivada) derivadas++;

      const rep = repararFluxo(rFluxo ? rFluxo.valor : null, idt.pot, efic);
      const fluxoOk = !isNaN(rep.valor) && rep.valor > 0;
      if(!fluxoOk) semFluxo++;

      let l70 = rL70 ? parseNum(rL70.valor) : NaN;
      if(!isNaN(l70) && l70 > 0 && l70 < 1000) l70 *= 1000;   // "102,000" lido como 102

      pendentes.push({
        origem:"firestore", path:doc.ref.path, docId:doc.id,
        label: modelo || doc.id,
        fabricante: idt.fabricante || detectarFabricante(famDoc+" "+pai) || famDoc || "—",
        familia: idt.familia, pot: Math.round(idt.pot),
        sku: idt.sku, cct: idt.cct, ledNum: idt.ledNum,
        fluxo: rep.valor, fluxoReparado: rep.reparado,
        efic: isNaN(efic) ? NaN : efic, l70,
        potDerivada, semFluxo: !fluxoOk, nota: notaDeriv,
        // 4) potência derivada torna plausivel() circular (fluxo/pot === efic por construção)
        suspeito: !fluxoOk || potDerivada || !plausivel(rep.valor, idt.pot)
      });
    });
  }catch(err){
    console.error("Falha ao ler catálogo:", err);
    showStatus("error","Erro de conexão","Não foi possível ler modelos_base.");
  }

  // 5) indexa as boas primeiro: idxSku e preferirEntrada são "first-wins" na prática
  const qualidade = e => (e.semFluxo?4:0) + (e.suspeito?2:0) + (e.potDerivada?1:0);
  pendentes.sort((a,b)=> qualidade(a)-qualidade(b)
                      || String(a.familia).localeCompare(String(b.familia))
                      || a.pot-b.pot);
  pendentes.forEach(registrarEntrada);

  // Complemento local: só onde o Firestore não tem entrada confiável
  let locais = 0;
  if(USAR_CATALOGO_LOCAL){
    CATALOGO_LOCAL.forEach(([fab,fam,pot,fluxo,efic,cct,l70])=>{
      const ok = (idxFamPot.get(`${fam}|${pot}`)||[])
        .some(e => e.origem==="firestore" && e.fluxo>0 && !e.suspeito && !e.potDerivada);
      if(ok) return;
      registrarEntrada({
        origem:"local", path:"local://planilha", docId:`${fam}-${pot}W`,
        label:`${fam} ${pot}W`, fabricante:fab, familia:fam, pot, sku:null,
        cct, ledNum:null, fluxo, fluxoReparado:false, efic, l70,
        potDerivada:false, semFluxo:false, nota:null, suspeito:false
      });
      locais++;
    });
  }

  const reparados = catalogo.filter(e=>e.fluxoReparado).length;
  const btn = document.getElementById("btnAnalisar"); if(btn) btn.disabled = false;
  const txt = document.getElementById("connText");
  if(txt) txt.textContent = `Catálogo: ${catalogo.length} refs · ${potPorFamilia.size} famílias`;

  if(!catalogo.length)
    showStatus("error","Catálogo vazio","Nenhuma referência indexada — verifique modelos_base e as regras do Firestore.");

  console.info(
    `[catálogo] docs: ${lidos} lidos, ${ignorados} placeholders · ` +
    `indexados: ${catalogo.length-locais} Firestore + ${locais} local · ` +
    `reparados: ${reparados} · pot. derivada: ${derivadas} · escala ambígua: ${ambiguas} · ` +
    `sem fluxo: ${semFluxo} · descartados: ${diagnostico.catalogoDescartado.length}\n` +
    `Diagnóstico: catalogoDescartado("HTC") · catalogoDe("HTC") · inspecionarCatalogo("HTC") · nominaisReparados()`
  );
}



// ============================================
// RESOLUÇÃO DO NOMINAL — nunca descarta por ambiguidade
// ============================================
function preferirEntrada(cands){
  const fs=cands.filter(c=>c.origem==="firestore"&&c.fluxo>0&&!c.suspeito);
  const pool=fs.length?fs:cands.filter(c=>c.fluxo>0);
  if(!pool.length) return cands[0];
  if(pool.length===1) return pool[0];
  const med=mediana(pool.map(c=>c.fluxo));
  return pool.reduce((a,b)=>Math.abs(b.fluxo-med)<Math.abs(a.fluxo-med)?b:a);
}

function escolherVariante(cands,idt){
  const notas=[];
  if(cands.length===1) return { ref:cands[0], via:"família+potência", notas };

  // 1) CCT exata do laudo
  if(idt.cct){
    const c=cands.filter(e=>e.cct===idt.cct);
    if(c.length) return { ref:preferirEntrada(c), via:`família+potência+CCT ${idt.cct}`, notas };
  }
  // 2) código LED (Philips)
  if(idt.ledNum){
    const c=cands.filter(e=>e.ledNum===idt.ledNum);
    if(c.length) return { ref:preferirEntrada(c), via:`família+potência+LED${idt.ledNum}`, notas };
  }
  // 3) variantes com fluxo equivalente (<=2%)
  const fl=cands.map(c=>c.fluxo).filter(v=>v>0);
  if(fl.length&&(Math.max(...fl)-Math.min(...fl))/Math.max(...fl)<=0.02)
    return { ref:preferirEntrada(cands), via:"família+potência (variantes equivalentes)", notas };
  // 4) CCT padrão do contrato
  const p=cands.filter(e=>e.cct===CCT_PREFERIDA);
  if(p.length){
    notas.push(`${cands.length} CCTs no catálogo — usada a padrão ${CCT_PREFERIDA}`);
    return { ref:preferirEntrada(p), via:`família+potência (CCT padrão ${CCT_PREFERIDA})`, notas, ambiguo:true };
  }
  // 5) sem CCT declarada no catálogo
  const sc=cands.filter(e=>!e.cct);
  if(sc.length){
    notas.push(`${cands.length} variantes — usada a sem CCT declarada`);
    return { ref:preferirEntrada(sc), via:"família+potência (variante universal)", notas, ambiguo:true };
  }
  // 6) mediana
  notas.push(`${cands.length} variantes divergentes (${fl.join(" / ")} lm) — usada a mediana`);
  return { ref:preferirEntrada(cands), via:"família+potência (mediana das variantes)", notas, ambiguo:true };
}

function resolverNominal(idt){
  
  if(idt.sku && idxSku.has(idt.sku)){
    const e = idxSku.get(idt.sku);
    const ok = idt.pot===null || !e.pot ||
               Math.abs(e.pot-idt.pot)/Math.max(e.pot,idt.pot) <= 0.15;
    if(ok) return { ref:e, via:"SKU", notas:[] };
    // potência divergente: não usa o SKU, cai para família+potência
  }
  if(!idt.familia) return { ref:null, motivo:"família não reconhecida no texto do laudo" };

  const disp=Array.from(potPorFamilia.get(idt.familia)||[]).sort((a,b)=>a-b);

  if(idt.pot===null){
    if(disp.length===1){
      const c=idxFamPot.get(`${idt.familia}|${disp[0]}`);
      const r=escolherVariante(c,idt);
      r.notas.push(`potência do laudo ausente — família só possui ${disp[0]}W`);
      r.via+=" (potência inferida)";
      return r;
    }
    return { ref:null, motivo:"potência não identificada no laudo", disponiveis:disp };
  }

  const alvo=Math.round(idt.pot);
  let cands=idxFamPot.get(`${idt.familia}|${alvo}`)||[];
  let ajuste=0;
  for(let d=1;d<=TOL_POT_W&&!cands.length;d++){
    const a=(idxFamPot.get(`${idt.familia}|${alvo+d}`)||[]);
    const b=(idxFamPot.get(`${idt.familia}|${alvo-d}`)||[]);
    if(a.length||b.length){ cands=a.concat(b); ajuste=d; }
  }

  if(!cands.length){
    return {
      ref:null, disponiveis:disp,
      motivo: disp.length
        ? `família ${idt.familia} existe, mas sem ${alvo}W (catálogo tem: ${disp.join(", ")}W)`
        : `família ${idt.familia} inexistente no catálogo`
    };
  }

  const r=escolherVariante(cands,idt);
  if(ajuste) r.notas.push(`potência ajustada em ±${ajuste}W (laudo ${alvo}W → catálogo ${r.ref.pot}W)`);
  return r;
}

// ============================================
// EXTRAÇÃO DOS ENSAIOS
// ============================================
function extrairCampos(d, doc, tipo){
  const flat = achatarDoc(d);
  let fab, mod, pot, fluxo, efic, ident, dataRec, cct;

  const temLegadoCwb = d["FABRICANTE"] !== undefined
                    || d["FLUXO LUMINOSO (LM)"] !== undefined
                    || d["MODELO"] !== undefined;

  // --- A) extrator 5.x: chaves / datas / declarado / medido / identificacao ---
  if(d.identificacao || d.medido || d.chaves){
    const id = d.identificacao || {}, me = d.medido || {},
          de = d.declarado || {},     ch = d.chaves || {};
    fab   = id.fabricante_norm || id.marca || ch.fabricante_chave;
    mod   = id.modelo || ch.modelo_chave || ch.chave_completa;
    pot   = id.potencia_nominal_w ?? de.potencia_w ?? ch.potencia_chave;
    fluxo = parseNum(me.fluxo_luminoso_lm ?? me.fluxo_luminoso_luminaria_lm);
    efic  = parseNum(me.eficiencia_luminosa_lm_w ?? me.eficacia_lm_w);
    cct   = id.temperatura_cor ?? me.temperatura_cor;
    dataRec = d.datas?.recebimento_amostra ?? d.datas?.emissao;
    ident = d._doc_id || doc.id;

  // --- B) legado CWB: chaves planas em maiúsculas ---
  } else if(temLegadoCwb){
    fab   = d["FABRICANTE"];
    mod   = d["MODELO"];
    pot   = d["POTENCIA DECLARADO (W)"] ?? d["POTENCIA (W)"] ?? d["POTENCIA DECLARADA (W)"];
    fluxo = parseNum(d["FLUXO LUMINOSO (LM)"] ?? d["FLUXO (LM)"]);
    efic  = parseNum(d["EFICACIA (LM/W)"] ?? d["EFICIENCIA (LM/W)"]);
    ident = d["RELATORIO"] ?? d["RELATORIO N"];
    dataRec = d["DATA RECEBIMENTO"] ?? d["DATA_RECEBIMENTO"] ?? d["DATA"];
    cct   = d["TEMPERATURA DE COR (K)"] ?? d["TEMPERATURA"];

  // --- C) extrator antigo: metadata / dados_tecnicos ---
  } else if(d.dados_tecnicos || d.metadata){
    const m = d.metadata || {}, t = d.dados_tecnicos || {};
    fab = m.fabricante; mod = m.modelo;
    pot = t.potenciaDeclarada ?? m.potencia ?? m.potencia_w ?? t.potenciaTotalCircuito;
    fluxo = parseNum(t.fluxoLuminosoLuminaria ?? t.fluxoLuminoso);
    efic  = parseNum(t.eficienciaLuminosaTotal ?? t.eficiencia);
    ident = m.arquivo;
    dataRec = m.data_recebimento ?? d.datas?.recebimento_amostra ?? t.dataRecebimentoAmostra;
    cct = t.temperaturaCor ?? m.temperatura_cor;
  }

  // --- fallback genérico por pontuação de campos ---
  if(vazio(fab)){ const r=buscarCampo(flat,REGRAS.fabricante); if(r) fab=r.valor; }
  if(vazio(mod)){ const r=buscarCampo(flat,REGRAS.modelo);     if(r) mod=r.valor; }
  if(isNaN(parseNum(pot))){   const r=buscarCampo(flat,REGRAS.potencia); if(r) pot=r.valor; }
  if(isNaN(parseNum(fluxo))){ const r=buscarCampo(flat,REGRAS.fluxo);    if(r) fluxo=parseNum(r.valor); }
  if(isNaN(parseNum(efic))){  const r=buscarCampo(flat,REGRAS.eficacia); if(r) efic=parseNum(r.valor); }
  if(vazio(cct)){     const r=buscarCampo(flat,REGRAS.cct);           if(r) cct=r.valor; }
  if(vazio(dataRec)){ const r=buscarCampo(flat,REGRAS.data);          if(r) dataRec=r.valor; }
  if(vazio(ident)){   const r=buscarCampo(flat,REGRAS.identificador); if(r) ident=r.valor; }

  const textoBusca = [mod, doc.id, fab].filter(x=>!vazio(x)).join(" ");

  return {
    fab: vazio(fab) ? "" : String(fab).trim(),
    mod: vazio(mod) ? String(doc.id) : String(mod).trim(),
    textoBusca, pot, cct,
    fluxo: parseNum(fluxo), efic: parseNum(efic),
    ident: vazio(ident) ? String(doc.id) : String(ident).trim(),
    dataRec
  };
}


// ============================================
// VARREDURA
// ============================================
function novoMarco(){return {somaFluxo:0,somaEfic:0,qtd:0,qtdEfic:0,amostras:[]};}
function fingerprint(c,data){
  return [norm(c.ident),norm(c.mod),isNaN(c.fluxo)?"-":c.fluxo.toFixed(1),isNaN(c.efic)?"-":c.efic.toFixed(2),data].join("|");
}

async function analisarContrato(){
  const contratoId=document.getElementById("contratoSelect").value;
  const btn=document.getElementById("btnAnalisar");
  btn.disabled=true; btn.innerHTML=`<div class="spinner"></div> Varrendo...`;
  showStatus("loading","Varrendo laboratório...",`Contrato ${contratoId}`);
  document.getElementById("masterSection").style.display="none";
  document.getElementById("detailSection").style.display="none";

  grupos={}; marcosAtuais=[];
  diagnostico.erros=[]; diagnostico.duplicatas=0; diagnostico.semFamilia=[];
  diagnostico.conflitosPotencia=[];          // zera junto com os demais

  const cfg=CONFIG_CONTRATOS[contratoId]||{tipo:"padrao",paths:["ensaios"]};
  const datas=new Set(), vistos=new Set();
  let total=0,comNominal=0,semNominal=0,pathsLidos=0;

  try{
    for(const path of cfg.paths){
      let snap;
      try{ snap=await db.collection("contratos").doc(contratoId).collection(path).get(); }
      catch(e){ console.warn("Path inacessível:",path); continue; }
      if(snap.empty) continue;
      pathsLidos++;

      snap.forEach(doc=>{
        try{
          const d=doc.data(); if(!d) return;
          const c=extrairCampos(d,doc,cfg.tipo);
          const dataRec=normalizarData(c.dataRec,path);

          if(DEDUPLICAR){
            const fp=fingerprint(c,dataRec);
            if(vistos.has(fp)){ diagnostico.duplicatas++; return; }
            vistos.add(fp);
          }

          const idt=identificar(c.textoBusca,c.pot,c.fab,c.cct);
          if(idt.origemPot==="medida") idt.pot=snapPotencia(idt.familia,idt.pot);
          if(!idt.familia) diagnostico.semFamilia.push({id:c.ident,texto:c.textoBusca.slice(0,100)});

          // registra o conflito; a nota no grupo é aplicada depois de 'g' existir
          if(idt.conflitoPot){
            diagnostico.conflitosPotencia.push({
              id:c.ident, modelo:c.mod,
              declarada_W:idt.conflitoPot.declarada,
              codigo_W:idt.conflitoPot.texto,
              usada_W:idt.pot,
              grupo:rotuloGrupo(idt)
            });
          }

          datas.add(dataRec); total++;

          const res=resolverNominal(idt);
          const chave=chaveGrupo(idt);

          if(!grupos[chave]){
            grupos[chave]={
              id:chave, label:rotuloGrupo(idt),
              familia:idt.familia||"Não identificada",
              fabricante:idt.fabricante||res.ref?.fabricante||c.fab||"Desconhecido",
              pot:idt.pot, nominal:res.ref||null,
              motivoSemNominal:res.ref?null:res.motivo,
              disponiveis:res.disponiveis||[], via:res.via||null,
              notas:res.notas||[], ambiguo:!!res.ambiguo,
              variantes:new Map(), marcos:{}
            };
          }
          const g=grupos[chave];
          if(!g.nominal&&res.ref){
            g.nominal=res.ref; g.via=res.via; g.notas=res.notas||[];
            g.ambiguo=!!res.ambiguo; g.motivoSemNominal=null;
          }

          // agora sim: 'g' existe
          if(idt.conflitoPot){
            const nota=`laudo ${c.ident}: campo declarado ${idt.conflitoPot.declarada}W ≠ código ${idt.conflitoPot.texto}W — agrupado pelo código`;
            if(!g.notas.includes(nota)) g.notas.push(nota);
            g.ambiguo=true;
          }

          g.variantes.set(c.mod,(g.variantes.get(c.mod)||0)+1);
          if(res.ref) comNominal++; else semNominal++;

          if(!g.marcos[dataRec]) g.marcos[dataRec]=novoMarco();
          const m=g.marcos[dataRec];
          const fOk=!isNaN(c.fluxo)&&c.fluxo>0, eOk=!isNaN(c.efic)&&c.efic>0;
          if(fOk){ m.somaFluxo+=c.fluxo; m.qtd++; }
          if(eOk){ m.somaEfic+=c.efic; m.qtdEfic++; }
          m.amostras.push({id:c.ident,modeloOriginal:c.mod,fluxo:fOk?c.fluxo:NaN,efic:eOk?c.efic:NaN});
        }catch(e){
          diagnostico.erros.push({path,docId:doc.id,msg:e.message});
        }
      });
    }

    marcosAtuais=Array.from(datas).sort((a,b)=>parseDateString(a)-parseDateString(b));

    if(!total){
      const extra = diagnostico.erros.length
        ? ` ${diagnostico.erros.length} documento(s) falharam — veja console.table(diagnostico.erros).`
        : "";
      showStatus("warning","Contrato vazio",
        `Nenhum ensaio processado (${pathsLidos} coleção(ões) lida(s)).${extra}`);
      if(diagnostico.erros.length) console.table(diagnostico.erros);
      return;
    }

    const lacunas=Object.values(grupos).filter(g=>!g.nominal);
    const ambiguos=Object.values(grupos).filter(g=>g.ambiguo).length;
    let msg=`${total} luminárias · ${Object.keys(grupos).length} modelos · ${marcosAtuais.length} data(s). `
          + `Com nominal: ${comNominal} · Sem nominal: ${semNominal}.`;
    if(ambiguos) msg+=` ${ambiguos} modelo(s) com variantes/conflitos resolvidos por regra.`;
    if(diagnostico.conflitosPotencia.length)
      msg+=` ${diagnostico.conflitosPotencia.length} laudo(s) com potência divergente — rode conflitosPotencia().`;
    if(diagnostico.duplicatas) msg+=` ${diagnostico.duplicatas} duplicata(s) descartada(s).`;
    if(diagnostico.erros.length) msg+=` ${diagnostico.erros.length} erro(s) de leitura.`;
    if(lacunas.length) msg+=` ${lacunas.length} sem referência — rode faltantes().`;

    showStatus(lacunas.length?"warning":"success","Varredura concluída",msg);
    if(lacunas.length) console.table(window.faltantes());
    if(diagnostico.conflitosPotencia.length) console.table(diagnostico.conflitosPotencia);
    renderMasterTable();
  }catch(err){
    console.error(err);
    showStatus("error","Erro ao processar",err.message||String(err));
  }finally{
    btn.disabled=false;
    btn.innerHTML=`<i class="ti ti-radar"></i> Varrer Contrato`;
  }
}


// ============================================
// TABELA MESTRE
// ============================================
function datasOrdenadas(g){
  return Object.keys(g.marcos).filter(d=>g.marcos[d].amostras.length>0)
    .sort((a,b)=>parseDateString(a)-parseDateString(b));
}
function totalAmostras(g){return Object.values(g.marcos).reduce((s,m)=>s+m.amostras.length,0);}

function tag(txt,cor,title){
  return `<span title="${escapeHtml(title||"")}" style="font-size:.7rem;color:${cor};border:1px solid ${cor};border-radius:4px;padding:1px 4px;margin-left:4px;cursor:help;">${txt}</span>`;
}

function renderMasterTable(){
  const tbody=document.getElementById("masterTableBody");
  tbody.innerHTML="";

  Object.values(grupos)
    .sort((a,b)=>(!!a.nominal===!!b.nominal)?totalAmostras(b)-totalAmostras(a):(a.nominal?-1:1))
    .forEach(g=>{
      const nom=g.nominal;
      const fluxoNom=nom?parseNum(nom.fluxo):NaN;
      const ok=!isNaN(fluxoNom)&&fluxoNom>0;
      const datas=datasOrdenadas(g);
      let ultimo=null,tot=0;
      datas.forEach(d=>{tot+=g.marcos[d].amostras.length; if(g.marcos[d].qtd>0) ultimo=g.marcos[d];});
      const mF=ultimo?ultimo.somaFluxo/ultimo.qtd:null;
      const perc=(mF!==null&&ok)?safePerc(mF,fluxoNom):null;

      const tags=[];
      if(!nom) tags.push(tag("SEM REFERÊNCIA","#E24B4A",g.motivoSemNominal));
      else{
        if(nom.origem==="local") tags.push(tag("LOCAL","#BA7517","Nominal da planilha local — migrar para o Firestore"));
        if(nom.fluxoReparado)    tags.push(tag("REPARADO","#0F6E56","Nominal do Firestore estava corrompido (ex.: 8.5 = 8.500) e foi reparado"));
        if(g.ambiguo)            tags.push(tag("VARIANTES","#BA7517",g.notas.join(" · ")));
        if(perc!==null&&(perc>110||perc<60)) tags.push(tag("VERIFICAR NOMINAL","#E24B4A",`Manutenção ${fmtPerc(perc)} — nominal provavelmente incorreto`));
      }
      if(g.variantes.size>1) tags.push(tag(`${g.variantes.size} grafias`,"var(--text-muted)",Array.from(g.variantes.keys()).join(" | ")));
      if(datas.length>1) tags.push(`<span style="font-size:.7rem;color:var(--text-muted);margin-left:4px;">${datas.length} datas</span>`);

      const tr=document.createElement("tr");
      tr.onclick=()=>renderDetailView(g.id,tr);
      tr.innerHTML=`
        <td><span class="step-badge" style="background:${nom?"var(--brand-mid)":"var(--text-muted)"}">${initial(g.fabricante)}</span> ${escapeHtml(g.fabricante)}</td>
        <td><strong>${escapeHtml(g.label)}</strong>${tags.join("")}</td>
        <td class="num">${tot}</td>
        <td class="num">${ok?fluxoNom.toLocaleString("pt-BR")+" lm":"—"}</td>
        <td class="num">${fmtPerc(perc)}</td>
        <td><span class="pill ${pillClass(perc)}">${pillLabel(perc)}</span></td>`;
      tbody.appendChild(tr);
    });

  document.getElementById("masterSection").style.display="block";
}

// ============================================
// DEPRECIAÇÃO
// ============================================
function regressaoLinear(pts){
  const n=pts.length; if(n<2) return null;
  const mx=pts.reduce((s,p)=>s+p.x,0)/n, my=pts.reduce((s,p)=>s+p.y,0)/n;
  let num=0,den=0;
  pts.forEach(p=>{num+=(p.x-mx)*(p.y-my); den+=(p.x-mx)**2;});
  if(!den) return null;
  const b=num/den, a=my-b*mx;
  let sse=0,sst=0;
  pts.forEach(p=>{const yh=a+b*p.x; sse+=(p.y-yh)**2; sst+=(p.y-my)**2;});
  return {a,b,r2:sst>0?1-sse/sst:null,n};
}
function analisarDepreciacao(linhas, temNominal){
  const pts = [];
  let t0 = null, semData = 0, semMedida = 0, semNominal = 0;

  linhas.forEach(l=>{
    const dt = toDate(l.marcoData);
    const temMedida = l.mFluxo !== null && !isNaN(l.mFluxo) && l.mFluxo > 0;

    if(!dt) semData++;
    if(!temMedida) semMedida++;
    else if(l.percFluxo === null || isNaN(l.percFluxo)) semNominal++;

    if(!dt || l.percFluxo === null || isNaN(l.percFluxo)) return;
    if(!t0) t0 = dt;                                  // linhas já vêm ordenadas por data
    pts.push({ x: diffDias(t0, dt), y: l.percFluxo, data: l.marcoData });
  });

  if(pts.length < 2){
    const total = linhas.length;
    const det = [];
    if(semMedida)  det.push(`${semMedida} data(s) sem fluxo medido extraído do laudo`);
    if(semNominal) det.push(`${semNominal} data(s) com medição, mas sem nominal comparável`);
    if(semData)    det.push(`${semData} data(s) não interpretável(is)`);

    let motivo;
    if(total === 0)                  motivo = "nenhuma amostra no grupo";
    else if(!temNominal)             motivo = "sem referência nominal — impossível calcular manutenção";
    else if(pts.length === 1)        motivo = `apenas 1 data com medição válida (mínimo 2)${det.length?" · "+det.join(" · "):""}`;
    else                             motivo = det.length ? det.join(" · ") : "sem pontos válidos";

    return { valido:false, motivo, diag:{ total, semData, semMedida, semNominal, pontos:pts.length } };
  }

  const reg = regressaoLinear(pts);
  if(!reg) return { valido:false, motivo:"todas as medições na mesma data (sem eixo temporal)" };

  const janela = pts[pts.length-1].x - pts[0].x;
  const taxaAno = reg.b * 365;

  let cruza90 = null;
  if(reg.b < -1e-9){
    const d90 = (90 - reg.a) / reg.b;
    if(isFinite(d90) && d90 > 0){
      const dt = new Date(toDate(pts[0].data).getTime() + d90 * 86400000);
      cruza90 = { data: dataParaTexto(dt), passado: d90 <= janela };
    }
  }

  return {
    valido:true, pts, reg, taxaAno, janela, cruza90,
    prever: x => reg.a + reg.b * x,
    t0: pts[0].data, tn: pts[pts.length-1].data
  };
}
function stripDepreciacao(dep, temNominal, motivo, notas){
  const extra = (notas && notas.length)
    ? `<div style="padding:6px 14px;background:#FFFBEB;border-left:3px solid #BA7517;font-size:.78rem;color:var(--text-secondary);">${escapeHtml(notas.join(" · "))}</div>`
    : "";

  if(!temNominal)
    return extra + `<div style="padding:10px 14px;background:#FEF2F2;border-left:3px solid var(--red);font-size:.82rem;color:var(--text-secondary);">
      Sem curva: ${escapeHtml(motivo || "modelo sem referência nominal")}.</div>`;

  if(!dep.valido){
    const d = dep.diag;
    // falta de medição é problema de extração, não de datas → destaque em âmbar
    const extracao = d && d.semMedida > 0;
    const cor = extracao ? "#BA7517" : "var(--border-strong)";
    const bg  = extracao ? "#FFFBEB" : "#F8FAFC";
    const dica = extracao
      ? ` <span style="color:var(--text-muted);font-style:italic;">verifique o mapeamento de campos com inspecionar()</span>`
      : "";
    return extra + `<div style="padding:10px 14px;background:${bg};border-left:3px solid ${cor};font-size:.82rem;color:var(--text-secondary);">
      Sem curva temporal: ${escapeHtml(dep.motivo)}.${dica}</div>`;
  }

  const cor = dep.taxaAno < -1 ? "var(--red-mid)" : dep.taxaAno < 0 ? "var(--text-primary)" : "var(--teal)";
  const proj = dep.cruza90
    ? (dep.cruza90.passado
        ? `<strong style="color:var(--red-mid)">já abaixo de 90%</strong> (${dep.cruza90.data})`
        : `atinge 90% em <strong>${dep.cruza90.data}</strong>`)
    : "sem tendência de queda";

  return extra + `<div style="display:flex;flex-wrap:wrap;gap:18px;padding:10px 14px;background:#F8FAFC;border-left:3px solid ${cor};font-size:.82rem;color:var(--text-secondary);">
    <span>Janela: <strong>${escapeHtml(dep.t0)} → ${escapeHtml(dep.tn)}</strong> (${dep.janela} dias, ${dep.pts.length} pontos)</span>
    <span>Variação: <strong style="color:${cor}">${dep.taxaAno<0?"":"+"}${fmt(dep.taxaAno,2)} p.p./ano</strong></span>
    <span>R²: <strong>${dep.reg.r2!==null?fmt(dep.reg.r2*100,0)+"%":"—"}</strong></span>
    <span>Projeção: ${proj}</span>
    <span style="color:var(--text-muted);font-style:italic;">série por data de recebimento (lotes), não por horas de operação</span>
  </div>`;
}


// ============================================
// DETALHE
// ============================================
function renderDetailView(id,tr){
  document.querySelectorAll("#masterTableBody tr").forEach(r=>r.classList.remove("active"));
  if(tr) tr.classList.add("active");
  const g=grupos[id]; if(!g) return;
  
  const nom=g.nominal;
  const fluxoNom=nom?parseNum(nom.fluxo):NaN;
  const eficNom =nom?parseNum(nom.efic):NaN;
  const fOk=!isNaN(fluxoNom)&&fluxoNom>0, eOk=!isNaN(eficNom)&&eficNom>0;

  const grafias=Array.from(g.variantes.entries()).sort((a,b)=>b[1]-a[1])
    .map(([n,q])=>`${escapeHtml(n)} (${q})`).join(" · ");

  const infoRef=nom
    ? `<br><small style="color:var(--text-muted);font-weight:400;">Referência: <strong>${escapeHtml(nom.label)}</strong>${nom.cct?" · "+nom.cct:""} · ${nom.origem==="local"?"planilha local":"Firestore"} · via ${escapeHtml(g.via||"-")}${nom.fluxoReparado?" · nominal reparado":""}${nom.l70?" · L70 "+fmtInt(nom.l70)+" h":""}</small>`
    : `<br><small style="color:var(--red);font-weight:400;">${escapeHtml(g.motivoSemNominal||"sem referência")}</small>`;

  document.getElementById("lblModeloSelecionado").innerHTML=
    `<i class="ti ti-device-computer-camera"></i> ${escapeHtml(g.label)}
     <span style="font-size:.8rem;color:var(--text-muted);font-weight:400;margin-left:12px;">(${escapeHtml(g.fabricante)} · família ${escapeHtml(g.familia)})</span>
     ${infoRef}
     ${g.variantes.size>1?`<br><small style="color:var(--text-muted);font-weight:400;">Grafias agrupadas: ${grafias}</small>`:""}`;

  const datas=datasOrdenadas(g);
  const mediasF=[fOk?100:null], mediasE=[eOk?100:null], linhas=[];
  let ultF=null,ultE=null,ultData="Sem dados";

  datas.forEach(dt=>{

    const m=g.marcos[dt];
    const mF=m.qtd?m.somaFluxo/m.qtd:NaN;
    const mE=m.qtdEfic?m.somaEfic/m.qtdEfic:NaN;
    const pF=fOk?safePerc(mF,fluxoNom):null;
    const pE=eOk?safePerc(mE,eficNom):null;
    mediasF.push(pF); mediasE.push(pE);
    if(pF!==null) ultF=pF;
    if(pE!==null) ultE=pE;
    ultData=dt;
    linhas.push({
      marcoData:dt, qtd:m.amostras.length, mFluxo:mF, percFluxo:pF,
      desvioLm:(fOk&&!isNaN(mF))?mF-fluxoNom:null,
      ncF:pF!==null?100-pF:null, mEfic:mE, percEfic:pE,
      ncE:pE!==null?100-pE:null, amostras:m.amostras
    });
  });
  const dep = analisarDepreciacao(linhas, fOk);
  const trend=[null];
  if(dep.valido){
    const t0=toDate(dep.t0);
    datas.forEach(d=>{const dt=toDate(d); trend.push(dt?dep.prever(diffDias(t0,dt)):null);});
  }

  setMetricCard("metFluxoNom",fOk?`${fluxoNom.toLocaleString("pt-BR")} lm`:"—",
    nom?(nom.origem==="local"?"Nominal (local)":"Nominal (catálogo)"):"Sem referência","");
  setMetricCard("metEficNom",eOk?`${fmt(eficNom)} lm/W`:"—","Nominal","");
  setMetricCard("metFluxoUlt",ultF!==null?fmtPerc(ultF):"—",
    dep.valido?`Ref: ${ultData} · ${dep.taxaAno<0?"":"+"}${fmt(dep.taxaAno,2)} p.p./ano`:`Ref: ${ultData}`,
    ultF===null?"":ultF>=95?"positive":ultF>=90?"warning":"negative");
  setMetricCard("metEficUlt",ultE!==null?fmtPerc(ultE):"—",`Ref: ${ultData}`,
    ultE===null?"":ultE>=95?"positive":ultE>=90?"warning":"negative");

  renderCharts(mediasF,mediasE,["Nominal",...datas.map(labelData)],datas,trend,dep);

  const wrap=document.querySelector("#detailSection .results-table-wrapper");
  wrap.innerHTML=`${stripDepreciacao(dep,fOk,g.motivoSemNominal,g.notas)}
    <table class="results-table"><thead><tr>
      <th>Data (Recebimento)</th><th class="num">Qtd</th><th class="num">Fluxo (lm)</th>
      <th class="num">Desvio (lm)</th><th class="num">Manut. (%)</th><th class="num">NC Fluxo</th>
      <th class="num">Efic. (lm/W)</th><th class="num">NC Efic.</th><th>Status</th>
    </tr></thead><tbody id="detailTableBody">
      <tr style="background:#F8FAFC;">
        <td><strong>Nominal (referência)</strong></td><td class="num">—</td>
        <td class="num">${fOk?fluxoNom.toLocaleString("pt-BR"):"—"}</td>
        <td class="num" style="color:var(--text-muted)">0</td>
        <td class="num">${fOk?"100,0%":"—"}</td>
        <td class="num" style="color:var(--text-muted)">${fOk?"0,0%":"—"}</td>
        <td class="num">${eOk?fmt(eficNom):"—"}</td>
        <td class="num" style="color:var(--text-muted)">${eOk?"0,0%":"—"}</td>
        <td><span class="pill ok">Referência</span></td>
      </tr></tbody></table>`;

  const tbody=document.getElementById("detailTableBody");
  const t0=dep.valido?toDate(dep.t0):null;
  let html="";

  linhas.forEach((r,i)=>{
    const exp=r.amostras.length>1, sid=`subrow-${i}`;
    const dt=toDate(r.marcoData);
    const dias=(t0&&dt)?`<span style="font-size:.72rem;color:var(--text-muted);margin-left:6px;">+${diffDias(t0,dt)}d</span>`:"";
    html+=`<tr ${exp?`class="expandable-row" onclick="toggleSubRow('${sid}')"`:""}>
      <td>${exp?'<i class="ti ti-chevron-right expand-icon"></i> ':'<span style="display:inline-block;width:16px;"></span>'}<strong>${escapeHtml(r.marcoData)}</strong>${dias}</td>
      <td class="num">${r.qtd} un.</td>
      <td class="num">${fmtInt(r.mFluxo)}</td>
      <td class="num" style="${corDesvio(r.desvioLm)}">${r.desvioLm>0?"+":""}${fmtInt(r.desvioLm)}</td>
      <td class="num"><strong>${fmtPerc(r.percFluxo)}</strong></td>
      <td class="num" style="${corDesvio(r.ncF,true)}">${fmtPerc(r.ncF)}</td>
      <td class="num">${fmt(r.mEfic)}</td>
      <td class="num" style="${corDesvio(r.ncE,true)}">${fmtPerc(r.ncE)}</td>
      <td><span class="pill ${pillClass(r.percFluxo)}">${pillLabel(r.percFluxo)}</span></td></tr>`;

    if(!exp) return;
    const subs=r.amostras.map(a=>{
      const dv=(fOk&&!isNaN(a.fluxo))?a.fluxo-fluxoNom:null;
      const pf=fOk?safePerc(a.fluxo,fluxoNom):null;
      const pe=eOk?safePerc(a.efic,eficNom):null;
      return `<tr class="sub-item-row">
        <td style="padding-left:2rem;font-size:.8rem;color:var(--text-secondary);max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(a.id)} — ${escapeHtml(a.modeloOriginal)}"><i class="ti ti-file-analytics"></i> ${escapeHtml(a.id)}</td>
        <td class="num" style="font-size:.8rem;">1 un.</td>
        <td class="num" style="font-size:.8rem;">${fmtInt(a.fluxo)}</td>
        <td class="num" style="font-size:.8rem;${corDesvio(dv)}">${dv>0?"+":""}${fmtInt(dv)}</td>
        <td class="num" style="font-size:.8rem;">${fmtPerc(pf)}</td>
        <td class="num" style="font-size:.8rem;${corDesvio(pf!==null?100-pf:null,true)}">${fmtPerc(pf!==null?100-pf:null)}</td>
        <td class="num" style="font-size:.8rem;">${fmt(a.efic)}</td>
        <td class="num" style="font-size:.8rem;${corDesvio(pe!==null?100-pe:null,true)}">${fmtPerc(pe!==null?100-pe:null)}</td>
        <td><span class="pill ${pillClass(pf)}" style="transform:scale(.85);transform-origin:left;">${pillLabel(pf)}</span></td></tr>`;
    }).join("");
    html+=`<tr id="${sid}" style="display:none;background:#F8FAFC;"><td colspan="9" style="padding:0;">
      <table class="results-table sub-table" style="width:100%;"><tbody>${subs}</tbody></table></td></tr>`;
  });

  tbody.insertAdjacentHTML("beforeend",html);
  const det=document.getElementById("detailSection");
  det.style.display="flex";
  det.scrollIntoView({behavior:"smooth",block:"start"});
}

// ============================================
// GRÁFICOS
// ============================================
function renderCharts(mF,mE,labels,datasFull,trend,dep){
  const vals=[...mF,...mE,...(trend||[])].filter(v=>v!==null&&!isNaN(v));
  const yMin=Math.min(85,Math.floor(((vals.length?Math.min(...vals,100):90)-5)/5)*5);
  const yMax=Math.max(105,Math.ceil(((vals.length?Math.max(...vals,100):105)+5)/5)*5);
  const t0=dep&&dep.valido?toDate(dep.t0):null;

  const opts={
    responsive:true,maintainAspectRatio:false,
    interaction:{mode:"index",intersect:false},
    plugins:{
      legend:{display:false},
      tooltip:{callbacks:{
        title:it=>{
          const i=it[0].dataIndex;
          if(i===0) return "Nominal (referência)";
          const d=datasFull?.[i-1]||it[0].label, dt=toDate(d);
          return (t0&&dt)?`${d}  (+${diffDias(t0,dt)} dias)`:d;
        },
        label:c=>`${c.dataset.label}: ${fmtPerc(c.parsed.y)}`
      }}
    },
    scales:{
      x:{ticks:{font:{size:11},maxRotation:45,autoSkip:false},grid:{color:"#F1F5F9"}},
      y:{min:yMin,max:yMax,ticks:{font:{size:11},callback:v=>v+"%"},grid:{color:"#F1F5F9"}}
    }
  };

  const limite={id:"limitLine",afterDraw(ch){
    const {ctx,scales:{y,x}}=ch, y90=y.getPixelForValue(90);
    if(y90>y.bottom||y90<y.top) return;
    ctx.save(); ctx.setLineDash([6,4]); ctx.strokeStyle=CORES.limite; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.moveTo(x.left,y90); ctx.lineTo(x.right,y90); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle=CORES.limite; ctx.font="10px Inter, sans-serif";
    ctx.fillText("limite 90%",x.right-58,y90-4); ctx.restore();
  }};

  const ds=[{label:"Fluxo medido",data:mF,borderColor:CORES.medido,
    backgroundColor:"rgba(15,110,86,.07)",borderWidth:2.5,pointRadius:6,
    pointBackgroundColor:"#fff",fill:true,spanGaps:true,order:1}];
  if(trend?.some(v=>v!==null&&!isNaN(v))) ds.push({label:"Tendência",data:trend,
    borderColor:CORES.tendencia,borderWidth:1.5,borderDash:[4,4],pointRadius:0,fill:false,spanGaps:true,order:2});

  if(chartFluxo) chartFluxo.destroy();
  chartFluxo=new Chart(document.getElementById("chartFluxo").getContext("2d"),
    {type:"line",data:{labels,datasets:ds},options:opts,plugins:[limite]});

  if(chartEfic) chartEfic.destroy();
  chartEfic=new Chart(document.getElementById("chartEfic").getContext("2d"),{
    type:"line",
    data:{labels,datasets:[{label:"Eficiência medida",data:mE,borderColor:CORES.eficiencia,
      backgroundColor:"rgba(186,117,23,.07)",borderWidth:2.5,pointRadius:6,
      pointBackgroundColor:"#fff",fill:true,spanGaps:true,borderDash:[6,3]}]},
    options:opts,plugins:[limite]
  });
}

// ============================================
// DIAGNÓSTICO (console)
// ============================================
window.faltantes=function(){
  const r=Object.values(grupos).filter(g=>!g.nominal).map(g=>({
    modelo:g.label,fabricante:g.fabricante,familia:g.familia,potencia_W:g.pot,
    amostras:totalAmostras(g),datas:Object.keys(g.marcos).length,
    motivo:g.motivoSemNominal,potencias_no_catalogo:(g.disponiveis||[]).join(", "),
    exemplo_grafia:Array.from(g.variantes.keys())[0]
  })).sort((a,b)=>b.amostras-a.amostras);
  console.table(r); return r;
};
window.catalogoDescartado = function(filtro){
  const f = up(filtro || "");
  const r = diagnostico.catalogoDescartado.filter(x => !f
    || up(x.docId).includes(f) || up(x.path).includes(f)
    || up(x.familia_doc || "").includes(f) || up(x.modelo || "").includes(f));
  console.table(r.map(({campos, ...rest}) => rest));   // 'campos' polui a tabela
  return r;                                           // retorno completo p/ inspeção
};

window.catalogoDe = function(fam){
  const f = up(fam || "");
  const r = catalogo
    .filter(e => !f || up(e.familia).includes(f) || up(e.docId).includes(f) || up(e.label).includes(f))
    .map(e => ({
      familia:e.familia, pot_W:e.pot, fluxo_lm:e.fluxo, efic:e.efic, cct:e.cct,
      origem:e.origem, reparado:e.fluxoReparado, pot_derivada:!!e.potDerivada,
      sem_fluxo:!!e.semFluxo, suspeito:e.suspeito, doc:e.docId
    }))
    .sort((a,b)=> String(a.familia).localeCompare(String(b.familia))
               || a.pot_W - b.pot_W
               || String(a.cct).localeCompare(String(b.cct)));
  console.table(r); return r;
};

/** Dump achatado de documentos do CATÁLOGO que casam com o filtro */
window.inspecionarCatalogo = async function(filtro, limite=5){
  const f = up(filtro || "");
  const snap = await db.collectionGroup("modelos").get();
  let n = 0;
  snap.forEach(doc=>{
    if(n >= limite) return;
    if(!doc.ref.path.startsWith("modelos_base/")) return;
    if(f && !up(doc.id + " " + doc.ref.path).includes(f)) return;
    n++;
    console.groupCollapsed(doc.ref.path);
    console.log(achatarDoc(doc.data() || {}));
    console.groupEnd();
  });
  if(!n) console.warn(`Nenhum documento de catálogo casou com "${filtro}".`);
};

/** Dump de ENSAIOS: documento achatado + resultado de extrairCampos */
window.inspecionar = async function(contratoId, filtro, limite=5){
  const cfg = CONFIG_CONTRATOS[contratoId] || { tipo:"padrao", paths:["ensaios"] };
  let n = 0;
  for(const path of cfg.paths){
    let snap;
    try{ snap = await db.collection("contratos").doc(contratoId).collection(path).get(); }
    catch(e){ continue; }
    snap.forEach(doc=>{
      if(n >= limite) return;
      if(filtro && !norm(doc.id).includes(norm(filtro))) return;
      n++;
      const d = doc.data() || {};
      console.groupCollapsed(`${path}/${doc.id}`);
      console.log("achatado:", achatarDoc(d));
      console.log("extraído:", extrairCampos(d, doc, cfg.tipo));
      console.groupEnd();
    });
  }
  if(!n) console.warn(`Nenhum ensaio casou com "${filtro}" em ${contratoId}.`);
};

window.nominaisReparados=function(){
  const r=catalogo.filter(e=>e.fluxoReparado)
    .map(e=>({modelo:e.label,familia:e.familia,pot_W:e.pot,fluxo_corrigido:e.fluxo,path:e.path}));
  console.table(r); return r;
};
window.implausiveis = function(){
  const r = Object.values(grupos).filter(g=>{
    if(!g.nominal || !(g.nominal.fluxo > 0)) return false;
    let u = null;
    datasOrdenadas(g).forEach(x => { if(g.marcos[x].qtd > 0) u = g.marcos[x]; });
    if(!u) return false;
    const p = safePerc(u.somaFluxo/u.qtd, g.nominal.fluxo);
    return p !== null && (p > 110 || p < 60);
  }).map(g=>{
    let u = null;
    datasOrdenadas(g).forEach(x => { if(g.marcos[x].qtd > 0) u = g.marcos[x]; });
    const p = safePerc(u.somaFluxo/u.qtd, g.nominal.fluxo);
    return {
      modelo:g.label, manutencao_pct:+p.toFixed(1),
      medido_lm:Math.round(u.somaFluxo/u.qtd), nominal_lm:g.nominal.fluxo,
      origem:g.nominal.origem, pot_derivada:!!g.nominal.potDerivada,
      doc:g.nominal.docId, via:g.via, amostras:totalAmostras(g),
      hipotese: p>110 ? "nominal subestimado ou variante errada" : "nominal superestimado ou falha de medição"
    };
  }).sort((a,b)=>Math.abs(b.manutencao_pct-100)-Math.abs(a.manutencao_pct-100));
  console.table(r); return r;
};

window.semFamilia=function(){console.table(diagnostico.semFamilia.slice(0,200));return diagnostico.semFamilia;};
window.auditoria=function(){
  const r=Object.values(grupos).map(g=>({
    chave:g.id,modelo:g.label,fabricante:g.fabricante,grafias:g.variantes.size,
    amostras:totalAmostras(g),datas:Object.keys(g.marcos).length,
    nominal:g.nominal?`${g.nominal.fluxo} lm (${g.nominal.origem})`:"—",
    via:g.via||g.motivoSemNominal,notas:(g.notas||[]).join(" · ")
  })).sort((a,b)=>b.amostras-a.amostras);
  console.table(r); return r;
};
window.exportarCSV = function(fn = window.faltantes, nome = "faltantes", ...args){
  const rows = fn(...args);
  if(!Array.isArray(rows) || !rows.length){ console.warn("Nada a exportar."); return; }
  const head = Object.keys(rows[0]).filter(h => h !== "campos");
  const csv = [head.join(";")].concat(
    rows.map(r => head.map(h => `"${String(r[h] ?? "").replace(/"/g,'""')}"`).join(";"))
  ).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\uFEFF"+csv], {type:"text/csv;charset=utf-8;"}));
  a.download = `${nome}_${Date.now()}.csv`; a.click();
};

window.conflitosPotencia = function(){
  const r = diagnostico.conflitosPotencia || [];
  console.table(r); return r;
};


// ============================================
// INIT
// ============================================
window.addEventListener("DOMContentLoaded",()=>{
  const btn=document.getElementById("btnAnalisar");
  if(btn){btn.disabled=true; btn.addEventListener("click",analisarContrato);}
  carregarCatalogo();
});
