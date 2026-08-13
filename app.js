"use strict";

// ============================================
// FIREBASE INIT
// ============================================
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const db = firebase.firestore();

// ============================================
// STATE & CONFIG
// ============================================
let chartFluxo = null;
let chartEfic = null;
let catalogoModelos = [];
let catalogoPorBase = new Map();   // "BRP221" -> [cat, cat, ...]
let cacheMatch = new Map();        // chaveAssinatura -> cat | null
let dadosAgrupadosContrato = {};
let marcosAtuais = [];
let errosLeitura = [];
let duplicatasIgnoradas = 0;

const DEDUPLICAR = true; // paths espelhados (ex.: "2025/maio" e "anos/2025/meses/maio")

const CONFIG_CONTRATOS = {
  "UDI": {
    tipo: "padrao",
    paths: [
      "Ensaios Laboratório/1º Marco/itens",
      "Ensaios Laboratório/2º Marco/itens",
      "Ensaios Laboratório/3º Marco/itens",
      "ensaios"
    ]
  },
  "PNZ": {
    tipo: "padrao",
    paths: [
      "Ensaios Laboratório/1º Marco/itens",
      "Ensaios Laboratório/2º Marco/itens",
      "Ensaios Laboratório/3º Marco/itens",
      "ensaios"
    ]
  },
  "CWB": {
    tipo: "cwb",
    paths: [
      "2023/nao_informado/ensaios",
      "anos/2023/meses/nao_informado/ensaios",
      "2025/fevereiro/ensaios",
      "anos/2025/meses/fevereiro/ensaios",
      "2025/maio/ensaios",
      "anos/2025/meses/maio/ensaios",
      "ensaios"
    ]
  },
  "BASE_LIMPA": {
    tipo: "padrao",
    paths: ["ensaios"]
  }
};

const CORES = {
  medido: "#0F6E56",
  limite: "#E24B4A",
  eficiencia: "#BA7517",
  tendencia: "#64748B"
};

const MESES = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
  jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12
};

// Tokens que NUNCA podem ser lidos como código base do produto
const NAO_BASE = new Set(["LED", "NW", "WW", "CW", "DW", "W", "P", "UB", "SRG", "DALI", "IP", "IK", "V", "HZ"]);

const VAZIOS = new Set(["", "-", "--", "N/A", "NA", "NONE", "NULL", "UNDEFINED", "NAN",
                        "NAO INFORMADO", "NAO_INFORMADO", "SEM INFORMACAO", "0"]);

// ============================================
// UTILS BÁSICOS
// ============================================
function fmt(n, dec = 1) {
  return (n === null || n === undefined || isNaN(n)) ? "—" : Number(n).toFixed(dec);
}
function fmtPerc(n) {
  return (n !== null && n !== undefined && !isNaN(n)) ? fmt(n) + "%" : "—";
}
function fmtInt(n) {
  return (n === null || n === undefined || isNaN(n)) ? "—" : Number(n.toFixed(0)).toLocaleString("pt-BR");
}
function pad2(n) { return String(n).padStart(2, "0"); }

function stripAcentos(s) {
  return String(s === null || s === undefined ? "" : s)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Primeira letra segura — corrige "Cannot read properties of undefined (reading 'charAt')" */
function initial(s) {
  const t = String(s === null || s === undefined ? "" : s).trim();
  return t.length ? t.charAt(0).toUpperCase() : "?";
}

function vazio(v) {
  if (v === null || v === undefined || v === "") return true;
  return VAZIOS.has(stripAcentos(v).toUpperCase().trim());
}

/** Converte string/number em float tratando separadores BR e US */
function parseNum(v) {
  if (v === null || v === undefined || v === "") return NaN;
  if (typeof v === "number") return isFinite(v) ? v : NaN;

  let s = String(v).trim().replace(/[^\d.,\-]/g, "");
  if (!s) return NaN;

  const temPonto = s.includes(".");
  const temVirgula = s.includes(",");

  if (temPonto && temVirgula) s = s.replace(/\./g, "").replace(",", ".");
  else if (temVirgula) s = s.replace(",", ".");
  else if (temPonto && /^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");

  const n = parseFloat(s);
  return isFinite(n) ? n : NaN;
}

function safePerc(valor, base) {
  if (base === null || base === undefined || isNaN(base) || base <= 0) return null;
  if (valor === null || valor === undefined || isNaN(valor)) return null;
  return (valor / base) * 100;
}

function corDesvio(n, isNC = false) {
  if (n === null || n === undefined || isNaN(n)) return "";
  if (isNC) return n > 0 ? "color: var(--red-mid); font-weight: bold;" : "color: var(--teal);";
  return n < 0 ? "color: var(--red-mid); font-weight: bold;" : "color: var(--teal);";
}

function pillClass(perc) {
  if (perc === null || perc === undefined || isNaN(perc)) return "na";
  if (perc >= 95) return "ok";
  if (perc >= 90) return "warn";
  return "bad";
}

function pillLabel(perc) {
  if (perc === null || perc === undefined || isNaN(perc)) return "N/A";
  if (perc >= 95) return "✓ Regular";
  if (perc >= 90) return "⚠ Atenção";
  return "✕ Crítico";
}

function escapeHtml(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ============================================
// UTILS DE DATA
// ============================================
function pareceData(v) {
  if (v && (typeof v.toDate === "function" || typeof v.seconds === "number")) return true;
  if (v instanceof Date) return !isNaN(v.getTime());
  const s = stripAcentos(v).trim().toLowerCase();
  if (!s || VAZIOS.has(s.toUpperCase())) return false;
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s)) return true;
  if (/^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}/.test(s)) return true;
  if (/^[a-z]+[\s/\-.]+\d{4}$/.test(s) && MESES[s.split(/[\s/\-.]+/)[0]] !== undefined) return true;
  if (/^(19|20)\d{2}$/.test(s)) return true;
  return false;
}

function dataDoPath(path) {
  if (!path) return null;
  const partes = stripAcentos(path).toLowerCase().split("/");
  const ano = partes.find(p => /^(19|20)\d{2}$/.test(p));
  const mes = partes.find(p => MESES[p] !== undefined);
  if (ano && mes) return `01/${pad2(MESES[mes])}/${ano}`;
  if (ano) return `01/01/${ano}`;
  return null;
}

function normalizarData(raw, pathHint) {
  if (raw && typeof raw.toDate === "function") raw = raw.toDate();
  else if (raw && typeof raw.seconds === "number") raw = new Date(raw.seconds * 1000);

  if (raw instanceof Date && !isNaN(raw.getTime())) {
    return `${pad2(raw.getDate())}/${pad2(raw.getMonth() + 1)}/${raw.getFullYear()}`;
  }

  const s = (raw === null || raw === undefined) ? "" : String(raw).trim();
  if (!s || VAZIOS.has(stripAcentos(s).toUpperCase()) ||
      ["sem data", "s/ data"].includes(stripAcentos(s).toLowerCase())) {
    return dataDoPath(pathHint) || "S/ Data";
  }

  const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return `${pad2(iso[3])}/${pad2(iso[2])}/${iso[1]}`;

  const br = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (br) {
    const ano = br[3].length === 2 ? "20" + br[3] : br[3];
    return `${pad2(br[1])}/${pad2(br[2])}/${ano}`;
  }

  const mesAno = stripAcentos(s).toLowerCase().match(/^([a-z]+)[\s/\-.]+(\d{4})$/);
  if (mesAno && MESES[mesAno[1]] !== undefined) {
    return `01/${pad2(MESES[mesAno[1]])}/${mesAno[2]}`;
  }

  const soAno = s.match(/^((19|20)\d{2})$/);
  if (soAno) return `01/01/${soAno[1]}`;

  return dataDoPath(pathHint) || s;
}

/** Chave inteira YYYYMMDD para ordenação */
function parseDateString(dStr) {
  if (!dStr || dStr === "S/ Data") return 0;
  const s = String(dStr).trim();

  const br = s.split("/");
  if (br.length === 3) {
    const d = parseInt(br[0], 10), m = parseInt(br[1], 10), y = parseInt(br[2], 10);
    if (!isNaN(d) && !isNaN(m) && !isNaN(y)) return y * 10000 + m * 100 + d;
  }
  const iso = s.split("-");
  if (iso.length === 3) {
    const y = parseInt(iso[0], 10), m = parseInt(iso[1], 10), d = parseInt(iso[2], 10);
    if (!isNaN(y) && !isNaN(m) && !isNaN(d)) return y * 10000 + m * 100 + d;
  }
  return 99999999;
}

/** Date real (para cálculo de intervalo em dias) — null se não datável */
function toDate(dStr) {
  const k = parseDateString(dStr);
  if (k === 0 || k === 99999999) return null;
  const p = String(dStr).split("/");
  if (p.length !== 3) return null;
  const dt = new Date(Number(p[2]), Number(p[1]) - 1, Number(p[0]));
  return isNaN(dt.getTime()) ? null : dt;
}

function diffDias(a, b) {
  return Math.round((b - a) / 86400000);
}

function labelData(dStr) {
  if (!dStr || dStr === "S/ Data") return "S/ Data";
  const p = String(dStr).split("/");
  return p.length === 3 ? `${p[0]}/${p[1]}/${p[2].slice(-2)}` : dStr;
}

function dataParaTexto(dt) {
  return `${pad2(dt.getDate())}/${pad2(dt.getMonth() + 1)}/${dt.getFullYear()}`;
}

// ============================================
// UI HELPERS
// ============================================
function showStatus(type, title, body = "") {
  const icons = {
    loading: "ti-loader-2", success: "ti-circle-check",
    warning: "ti-alert-triangle", error: "ti-alert-circle"
  };
  const el = document.getElementById("statusBanner");
  if (!el) return;
  el.className = `status-banner visible ${type}`;
  el.innerHTML = `
    ${type === "loading" ? `<div class="spinner"></div>` : `<i class="ti ${icons[type]}"></i>`}
    <div class="status-text"><strong>${title}</strong>${body ? `<span>${body}</span>` : ""}</div>`;
}

function setMetricCard(id, value, sub, deltaClass) {
  const card = document.getElementById(id);
  if (!card) return;
  const v = card.querySelector(".metric-value");
  if (v) { v.className = `metric-value ${deltaClass || ""}`; v.textContent = value; }
  const s = card.querySelector(".metric-sub");
  if (s && sub !== null && sub !== undefined) s.textContent = sub;
}

window.toggleSubRow = function (subRowId) {
  const subRow = document.getElementById(subRowId);
  if (!subRow) return;
  const parent = subRow.previousElementSibling;
  const icon = parent ? parent.querySelector(".expand-icon") : null;
  const aberto = subRow.style.display !== "none";
  subRow.style.display = aberto ? "none" : "table-row";
  if (icon) icon.style.transform = aberto ? "rotate(0deg)" : "rotate(90deg)";
};

// ============================================
// ASSINATURA TÉCNICA DO MODELO
// ============================================
/**
 * "BRP221 LED64-6S/NW 42W DW1 P7 0-10 UB" ->
 * { base:"BRP221", ledNum:64, ledSeg:6, pot:42, optica:"DW1", cct:"NW" }
 */
function extrairAssinatura(modStr, potDeclarada) {
  const bruto = stripAcentos(modStr).toUpperCase().replace(/[_.]+/g, " ").trim();
  const compact = bruto.replace(/[^A-Z0-9]/g, "");

  // --- Código base (obrigatório para cruzar com catálogo) ---
  let base = null;
  const candidatos = [...bruto.matchAll(/\b([A-Z]{2,5})\s*-?\s*(\d{2,4})[A-Z]?\b/g)]
    .filter(m => !NAO_BASE.has(m[1]));
    
  if (candidatos.length) {
    base = candidatos[0][1] + candidatos[0][2];
  } else {
    const alt = compact.match(/^[A-Z]{2,5}\d{2,4}/);
    if (alt && !NAO_BASE.has(alt[0].replace(/\d+/g, ""))) {
      base = alt[0];
    } else {
      // NOVO FALLBACK: Se não achar o formato estrito (ex: BRP220), 
      // usa a primeira palavra/token válida (ex: ESAT, LUMEFLEX, ORNAMENTAL, LPNENAI3)
      const primeiraPalavra = bruto.split(/[\s-]/)[0].replace(/[^A-Z0-9]/g, "");
      if (primeiraPalavra.length >= 3 && !NAO_BASE.has(primeiraPalavra)) {
        base = primeiraPalavra;
      }
    }
  }

  // --- Código LED (LED45-5S, LED73, LED 189-6S) ---
  let ledNum = null, ledSeg = null;
  const mLed = bruto.match(/LED\s*-?\s*(\d{1,4})\s*[-/–]?\s*(\d{1,2})?\s*S?\b/);
  if (mLed) {
    const n = parseInt(mLed[1], 10);
    // Códigos truncados por OCR (ex.: "LED6S") são descartados e reconciliados depois
    if (!isNaN(n) && n >= 10) {
      ledNum = n;
      if (mLed[2]) ledSeg = parseInt(mLed[2], 10);
    }
  }

  // --- Potência ---
  let pot = parseNum(potDeclarada);
  if (isNaN(pot) || pot <= 0) {
    const cands = [...bruto.matchAll(/(\d{1,4}(?:[.,]\d)?)\s*W\b/g)]
      .map(m => parseNum(m[1]))
      .filter(v => !isNaN(v) && v >= 5 && v <= 2000);
    pot = cands.length ? cands[0] : null;
  }
  if (pot !== null && (isNaN(pot) || pot <= 0)) pot = null;

  // --- Óptica / driver (DW1, DME, DML, DMLN, DN2) ---
  let optica = null;
  const mOpt = compact.match(/D(W\d|M[A-Z]{1,2}|N\d)/);
  if (mOpt) optica = "D" + mOpt[1];

  // --- Temperatura de cor ---
  let cct = null;
  const mCct = bruto.match(/\b(NW|WW|CW|DW)\b/);
  if (mCct) cct = mCct[1];

  return { base, ledNum, ledSeg, pot, optica, cct, compact, bruto };
}

/** Chave de agrupamento derivada da assinatura */
function chaveAssinatura(sig) {
  if (!sig || !sig.base) {
    const pot = (sig && sig.pot) ? "#" + Math.round(sig.pot) + "W" : "";
    return "RAW::" + ((sig && sig.compact) || "SEMMODELO").slice(0, 40) + pot;
  }
  const led = sig.ledNum ? `LED${sig.ledNum}${sig.ledSeg ? "-" + sig.ledSeg + "S" : ""}` : "LED?";
  const pot = sig.pot ? Math.round(sig.pot) + "W" : "?W";
  return `${sig.base}|${led}|${pot}|${sig.optica || "-"}`;
}

/** ÚNICA definição — aceita texto de fallback quando não há código base */
function assinaturaLegivel(sig, fallbackTexto) {
  if (!sig || !sig.base) {
    const t = String(fallbackTexto || "").trim();
    return (t && t !== "Sem modelo") ? t : "sem código identificável";
  }
  const p = [sig.base];
  if (sig.ledNum) p.push(`LED${sig.ledNum}${sig.ledSeg ? "-" + sig.ledSeg + "S" : ""}`);
  if (sig.cct) p.push(sig.cct);
  if (sig.pot) p.push(Math.round(sig.pot) + "W");
  if (sig.optica) p.push(sig.optica);
  return p.join(" ");
}

// ============================================
// RESOLVEDOR GENÉRICO DE CAMPOS
// ============================================
function normKey(k) {
  return stripAcentos(k).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Achata objetos aninhados: { medido: { fluxo: 1 } } -> { "medido.fluxo": 1 } */
function achatarDoc(obj, prefixo = "", saida = {}, prof = 0) {
  if (!obj || typeof obj !== "object" || prof > 4) return saida;
  Object.keys(obj).forEach(k => {
    const v = obj[k];
    const caminho = prefixo ? `${prefixo}.${k}` : k;
    const ehTimestamp = v && (typeof v.toDate === "function" || typeof v.seconds === "number");
    if (v && typeof v === "object" && !Array.isArray(v) && !ehTimestamp && !(v instanceof Date)) {
      achatarDoc(v, caminho, saida, prof + 1);
    } else {
      saida[caminho] = v;
    }
  });
  return saida;
}

function buscarCampo(flat, cfg) {
  let melhor = null, melhorPts = -1;

  for (const caminho of Object.keys(flat)) {
    const v = flat[caminho];
    if (v === null || v === undefined || v === "") continue;

    const nk = normKey(caminho);

    let pts = -1;
    cfg.inclui.forEach((rx, i) => { if (rx.test(nk)) pts = Math.max(pts, 100 - i * 4); });
    if (pts < 0) continue;
    if (cfg.exclui && cfg.exclui.some(rx => rx.test(nk))) continue;

    (cfg.bonus || []).forEach(par => { if (par[0].test(nk)) pts += par[1]; });

    if (cfg.tipo === "num") {
      const n = parseNum(v);
      if (isNaN(n) || n <= 0) continue;
      if (cfg.min !== undefined && n < cfg.min) continue;
      if (cfg.max !== undefined && n > cfg.max) continue;
    } else if (cfg.tipo === "texto") {
      const s = String(v).trim();
      if (!s || VAZIOS.has(stripAcentos(s).toUpperCase())) continue;
      if (cfg.maxLen && s.length > cfg.maxLen) continue;
    } else if (cfg.tipo === "data") {
      if (!pareceData(v)) continue;
    }

    if (pts > melhorPts) { melhorPts = pts; melhor = { caminho, valor: v }; }
  }
  return melhor;
}

const REGRAS = {
  fabricante: {
    tipo: "texto", maxLen: 60,
    inclui: [/^FABRICANTE/, /FABRICANTE/, /^MARCA/, /MANUFACTUR/, /FORNECEDOR/],
    exclui: [/CNPJ/, /ENDERECO/, /CIDADE/, /CONTATO/]
  },
  modelo: {
    tipo: "texto", maxLen: 120,
    inclui: [/MODELOLUMINARIA/, /^MODELO/, /MODELO/, /^MODEL/, /CODIGOPRODUTO/, /REFERENCIA/, /PRODUTO/, /DESCRICAO/],
    exclui: [/MODELOFOTOMETR/, /ARQUIVO/, /FAMILIA/, /MODELODRIVER/],
    bonus: [[/DESCRICAO/, -30]]
  },
  potencia: {
    tipo: "num", min: 3, max: 3000,
    inclui: [/POTENCIADECLARAD/, /POTENCIANOMINAL/, /^POTENCIA/, /POTENCIA/, /WATT/, /^POTW/],
    exclui: [/FATOR/, /FP$/, /DENSIDADE/],
    bonus: [[/DECLARAD|NOMINAL|CATALOGO/, 20], [/MEDID|REAL|ENSAIO/, -8]]
  },
  fluxo: {
    tipo: "num", min: 50, max: 300000,
    inclui: [/FLUXOLUMINOSO/, /FLUXOTOTAL/, /^FLUXO/, /FLUXO/, /LUMENS/, /LUMINOSOLM/],
    exclui: [/EFICAC/, /EFICIENC/, /PERCENT/, /MANTIDO/],
    bonus: [[/MEDID|REAL|ENSAIO|LUMINARIA/, 25], [/DECLARAD|NOMINAL|CATALOGO|FABRICANTE/, -25]]
  },
  eficacia: {
    tipo: "num", min: 10, max: 400,
    inclui: [/EFICACIA/, /EFICIENCIALUMINOSA/, /EFICIENCIA/, /LMW/, /RENDIMENTO/],
    exclui: [/PERCENT/, /ENERGETIC/],
    bonus: [[/MEDID|REAL|ENSAIO|TOTAL/, 25], [/DECLARAD|NOMINAL|CATALOGO/, -25]]
  },
  data: {
    tipo: "data",
    inclui: [/DATARECEB/, /RECEBIMENTOAMOSTRA/, /RECEBIMENTO/, /DATAENSAIO/, /DATARELATORIO/,
             /DATAEMISSAO/, /DATAAMOSTRA/, /^DATA/, /^DT/],
    exclui: [/VALIDADE/, /CALIBRAC/, /FABRICACAO/]
  },
  identificador: {
    tipo: "texto", maxLen: 160,
    inclui: [/^RELATORIO/, /RELATORIO/, /LAUDO/, /CERTIFICADO/, /PROTOCOLO/, /NUMEROENSAIO/, /ARQUIVO/]
  }
};

/** Extrai fabricante/modelo do doc.id (ex.: PHILIPS__BRP220__BRP220-LED45-42W-) */
function inferirDeDocId(docId) {
  const partes = String(docId || "").split(/__+/)
    .map(p => p.replace(/[-_]+/g, " ").trim()).filter(Boolean);
  let fab = null, mod = null;
  partes.forEach(p => {
    if (/LED/i.test(p) || /\d/.test(p)) {
      if (!mod || p.length > mod.length) mod = p;
    } else if (!fab && /^[A-Za-z\s.]{3,}$/.test(p)) {
      fab = p;
    }
  });
  return { fab, mod };
}

// ============================================
// 1. CATÁLOGO + ÍNDICE
// ============================================
async function carregarCatalogoMaster() {
  try {
    const snap = await db.collectionGroup("modelos").get();
    catalogoModelos = [];
    catalogoPorBase = new Map();
    cacheMatch = new Map();
    let ignorados = 0;

    snap.forEach(doc => {
      if (!doc.ref.parent.parent) return;
      const data = doc.data() || {};
      const modeloStr = String(data.modelo || data.modelo_base || doc.id || "").trim();
      const sig = extrairAssinatura(modeloStr, data.potencia_W);

      // Registro sem código base não pode ser usado no cruzamento:
      // era isso que fazia BRP220/BRP221/BRP481 colapsarem num único grupo.
      if (!sig.base) { ignorados++; return; }

      const cat = {
        id: doc.id,
        // Usa o campo 'familia' do documento, ou tenta o avô como último recurso
        familiaId: data.familia || (doc.ref.parent.parent ? doc.ref.parent.parent.id : "Sem Familia"),
        data,
        label: modeloStr,
        sig,
        _famUpper: String(data.familia || (doc.ref.parent.parent ? doc.ref.parent.parent.id : "")).toUpperCase()
      };

      catalogoModelos.push(cat);
      if (!catalogoPorBase.has(sig.base)) catalogoPorBase.set(sig.base, []);
      catalogoPorBase.get(sig.base).push(cat);
    });

    if (ignorados) {
      console.warn(`Catálogo: ${ignorados} modelo(s) ignorado(s) por não ter código base identificável.`);
    }

    const btn = document.getElementById("btnAnalisar");
    if (btn) btn.disabled = false;

    const connText = document.getElementById("connText");
    if (connText) {
      connText.textContent = `Catálogo Sincronizado (${catalogoModelos.length} modelos / ${catalogoPorBase.size} códigos base)`;
    }
  } catch (err) {
    console.error("Erro ao carregar catálogo base:", err);
    showStatus("error", "Erro de Conexão", "Não foi possível carregar os modelos base do Firestore.");
    const connText = document.getElementById("connText");
    const badge = document.getElementById("connBadge");
    if (connText) connText.textContent = "Erro de Conexão";
    if (badge) {
      badge.style.background = "var(--red-light)";
      badge.style.color = "var(--red)";
    }
  }
}

// ============================================
// 2. CRUZAMENTO ESTRITO COM O CATÁLOGO
// ============================================
function pontuarMatch(labSig, cat, labFab) {
  const catSig = cat.sig;

  // Eliminatória 1: código base idêntico
  if (!labSig.base || !catSig.base || labSig.base !== catSig.base) return 0;

  let pts = 100;

  // Eliminatória 2: código LED
  if (labSig.ledNum && catSig.ledNum) {
    if (labSig.ledNum !== catSig.ledNum) return 0;
    pts += 40;
    if (labSig.ledSeg && catSig.ledSeg) {
      if (labSig.ledSeg !== catSig.ledSeg) return 0;
      pts += 10;
    }
  }

  // Eliminatória 3: potência (±3 W)
  if (labSig.pot && catSig.pot) {
    if (Math.abs(labSig.pot - catSig.pot) > 3) return 0;
    pts += 30;
  }

  // Eliminatória 4: óptica / driver
  if (labSig.optica && catSig.optica) {
    if (labSig.optica !== catSig.optica) return 0;
    pts += 20;
  }

  // Desempate
  if (labSig.cct && catSig.cct && labSig.cct === catSig.cct) pts += 5;

  const fabU = String(labFab || "").toUpperCase();
  if (fabU && cat._famUpper && (fabU.includes(cat._famUpper) || cat._famUpper.includes(fabU))) pts += 15;

  return pts;
}

function encontrarModeloBase(labFab, labSig) {
  if (!labSig || !labSig.base) return null;

  const chaveCache = chaveAssinatura(labSig) + "@" + String(labFab || "").toUpperCase();
  if (cacheMatch.has(chaveCache)) return cacheMatch.get(chaveCache);

  const candidatos = catalogoPorBase.get(labSig.base) || [];
  let melhor = null, melhorPts = 0, empates = 0;

  for (const cat of candidatos) {
    const pts = pontuarMatch(labSig, cat, labFab);
    if (pts <= 0) continue;
    if (pts > melhorPts) { melhorPts = pts; melhor = cat; empates = 1; }
    else if (pts === melhorPts) empates++;
  }

  // Empate entre registros diferentes indica catálogo ambíguo: não arrisca o cruzamento
  if (melhor && empates > 1 && melhorPts < 140) {
    console.warn(`Match ambíguo para "${labSig.bruto}" (${empates} candidatos, ${melhorPts} pts).`);
    melhor = null;
  }

  cacheMatch.set(chaveCache, melhor);
  return melhor;
}

// ============================================
// 3. EXTRAÇÃO DE CAMPOS (schema conhecido + resolvedor genérico)
// ============================================
function extrairCampos(d, doc, tipoContrato) {
  const flat = achatarDoc(d);
  let fab, mod, pot, fluxo, efic, identificador, dataRec;

  // --- 1) Schemas conhecidos (rápido) ---
  if (tipoContrato === "cwb") {
    fab = d["FABRICANTE"];
    mod = d["MODELO"];
    pot = d["POTENCIA DECLARADO (W)"] ?? d["POTENCIA (W)"];
    fluxo = parseNum(d["FLUXO LUMINOSO (LM)"]);
    efic = parseNum(d["EFICACIA (LM/W)"]);
    identificador = d["RELATORIO"];
    dataRec = d["DATA RECEBIMENTO"] ?? d["DATA_RECEBIMENTO"];
  } else if (d.identificacao && d.medido) {
    fab = d.identificacao.fabricante_norm || d.identificacao.marca;
    mod = d.identificacao.modelo;
    pot = d.identificacao.potencia_nominal_w ?? (d.declarado && d.declarado.potencia_w);
    fluxo = parseNum(d.medido.fluxo_luminoso_lm);
    efic = parseNum(d.medido.eficiencia_luminosa_lm_w);
    identificador = d._doc_id;
    dataRec = d.datas && d.datas.recebimento_amostra;
  } else if (d.dados_tecnicos || d.metadata) {
    const meta = d.metadata || {};
    const tec = d.dados_tecnicos || {};
    fab = meta.fabricante;
    mod = meta.modelo;
    pot = meta.potencia_w ?? tec.potenciaTotal;
    fluxo = parseNum(tec.fluxoLuminosoLuminaria);
    efic = parseNum(tec.eficienciaLuminosaTotal);
    identificador = meta.arquivo;
    dataRec = meta.data_recebimento ?? (d.datas && d.datas.recebimento_amostra);
  }

  // --- 2) Resolvedor genérico preenche o que faltou ---
  if (vazio(fab))             { const r = buscarCampo(flat, REGRAS.fabricante);    if (r) fab = r.valor; }
  if (vazio(mod))             { const r = buscarCampo(flat, REGRAS.modelo);        if (r) mod = r.valor; }
  if (isNaN(parseNum(pot)))   { const r = buscarCampo(flat, REGRAS.potencia);      if (r) pot = r.valor; }
  if (isNaN(parseNum(fluxo))) { const r = buscarCampo(flat, REGRAS.fluxo);         if (r) fluxo = parseNum(r.valor); }
  if (isNaN(parseNum(efic)))  { const r = buscarCampo(flat, REGRAS.eficacia);      if (r) efic = parseNum(r.valor); }
  if (vazio(dataRec))         { const r = buscarCampo(flat, REGRAS.data);          if (r) dataRec = r.valor; }
  if (vazio(identificador))   { const r = buscarCampo(flat, REGRAS.identificador); if (r) identificador = r.valor; }

  // --- 3) Último recurso: o próprio doc.id ---
  if (vazio(mod) || vazio(fab)) {
    const inf = inferirDeDocId(doc.id);
    if (vazio(mod) && inf.mod) mod = inf.mod;
    if (vazio(fab) && inf.fab) fab = inf.fab;
  }

  return {
    fab: vazio(fab) ? "Desconhecido" : String(fab).trim(),
    mod: vazio(mod) ? "Sem modelo" : String(mod).trim(),
    pot,
    fluxo: parseNum(fluxo),
    efic: parseNum(efic),
    identificador: vazio(identificador) ? String(doc.id) : String(identificador).trim(),
    dataRec
  };
}

// ============================================
// 4. VARREDURA DO CONTRATO
// ============================================
function garantirGrupo(modId, dados) {
  if (!dadosAgrupadosContrato[modId]) {
    dadosAgrupadosContrato[modId] = Object.assign({
      id: modId, variantes: new Map(), marcos: {}
    }, dados);
  }
  return dadosAgrupadosContrato[modId];
}

function novoMarco() {
  return { somaFluxo: 0, somaEfic: 0, qtd: 0, qtdEfic: 0, amostras: [] };
}

function mesclarGrupos(destino, origem) {
  origem.variantes.forEach((qtd, nome) => {
    destino.variantes.set(nome, (destino.variantes.get(nome) || 0) + qtd);
  });
  Object.keys(origem.marcos).forEach(data => {
    const o = origem.marcos[data];
    if (!destino.marcos[data]) destino.marcos[data] = novoMarco();
    const dst = destino.marcos[data];
    dst.somaFluxo += o.somaFluxo;
    dst.somaEfic += o.somaEfic;
    dst.qtd += o.qtd;
    dst.qtdEfic += o.qtdEfic;
    dst.amostras.push(...o.amostras);
  });
}

/** Absorve grupos com código LED truncado por OCR, mas só quando o destino é inequívoco */
function reconciliarGrupos() {
  const incompletos = Object.values(dadosAgrupadosContrato)
    .filter(g => g.isFallback && g.sig && g.sig.base && !g.sig.ledNum);
  let fundidos = 0;

  incompletos.forEach(g => {
    if (!dadosAgrupadosContrato[g.id]) return; // já absorvido
    const alvos = Object.values(dadosAgrupadosContrato).filter(t =>
      t.id !== g.id && t.sig && t.sig.base === g.sig.base && t.sig.ledNum &&
      (t.sig.optica || null) === (g.sig.optica || null) &&
      (!t.sig.pot || !g.sig.pot || Math.abs(t.sig.pot - g.sig.pot) <= 3)
    );
    if (alvos.length === 1) {
      mesclarGrupos(alvos[0], g);
      delete dadosAgrupadosContrato[g.id];
      fundidos++;
    }
  });
  return fundidos;
}

/** Sanidade: nenhum grupo pode conter mais de um código base */
function validarIntegridadeGrupos() {
  Object.values(dadosAgrupadosContrato).forEach(g => {
    const bases = new Set();
    g.variantes.forEach((_, nome) => {
      const b = extrairAssinatura(nome, null).base;
      if (b) bases.add(b);
    });
    g.basesDistintas = Array.from(bases);
    if (bases.size > 1) {
      console.error(`AGRUPAMENTO INCORRETO em "${g.label}": ${g.basesDistintas.join(", ")}`,
                    Array.from(g.variantes.keys()));
    }
  });
}

function fingerprint(c, dataRec) {
  return [
    stripAcentos(c.identificador).toUpperCase().replace(/\s+/g, ""),
    stripAcentos(c.mod).toUpperCase().replace(/[^A-Z0-9]/g, ""),
    isNaN(c.fluxo) ? "-" : c.fluxo.toFixed(1),
    isNaN(c.efic) ? "-" : c.efic.toFixed(2),
    dataRec
  ].join("|");
}

async function analisarContrato() {
  const contratoId = document.getElementById("contratoSelect").value;
  const btn = document.getElementById("btnAnalisar");

  btn.disabled = true;
  btn.innerHTML = `<div class="spinner"></div> Varrendo...`;
  showStatus("loading", "Analisando Laboratório...", `Lendo dados e datas do contrato ${contratoId}...`);

  document.getElementById("masterSection").style.display = "none";
  document.getElementById("detailSection").style.display = "none";

  dadosAgrupadosContrato = {};
  marcosAtuais = [];
  errosLeitura = [];
  duplicatasIgnoradas = 0;

  const configAtual = CONFIG_CONTRATOS[contratoId] || { tipo: "padrao", paths: ["ensaios"] };
  const datasSet = new Set();
  const vistos = new Set();

  let totalAmostras = 0, mapeadas = 0, naoMapeadas = 0, pathsLidos = 0;

  try {
    for (const path of configAtual.paths) {
      let snap;
      try {
        snap = await db.collection("contratos").doc(contratoId).collection(path).get();
      } catch (errPath) {
        console.warn(`Path inacessível: ${path}`, errPath);
        continue;
      }
      if (snap.empty) continue;
      pathsLidos++;

      snap.forEach(doc => {
        try {
          const d = doc.data();
          if (!d) return;

          const c = extrairCampos(d, doc, configAtual.tipo);
          const dataRec = normalizarData(c.dataRec, path);

          if (DEDUPLICAR) {
            const fp = fingerprint(c, dataRec);
            if (vistos.has(fp)) { duplicatasIgnoradas++; return; }
            vistos.add(fp);
          }

          const sig = extrairAssinatura(c.mod, c.pot);
          datasSet.add(dataRec);
          totalAmostras++;

          const modeloBase = encontrarModeloBase(c.fab, sig);
          let modId, grupoNovo;

          if (modeloBase) {
            mapeadas++;
            modId = `CAT::${modeloBase.familiaId}::${modeloBase.id}`;
            grupoNovo = {
              label: modeloBase.label || modeloBase.id,
              familia: String(modeloBase.familiaId || modeloBase.data.familia || c.fab || "Desconhecido"),
              nominal: modeloBase.data || {},
              sig: modeloBase.sig,
              isFallback: false
            };
          } else {
            naoMapeadas++;
            modId = "LAB::" + chaveAssinatura(sig);
            grupoNovo = {
              label: assinaturaLegivel(sig, c.mod),
              familia: c.fab,
              nominal: { fluxo_luminoso_lm: null, eficiencia_lm_w: null },
              sig,
              isFallback: true
            };
          }

          const grupo = garantirGrupo(modId, grupoNovo);
          grupo.variantes.set(c.mod, (grupo.variantes.get(c.mod) || 0) + 1);

          if (!grupo.marcos[dataRec]) grupo.marcos[dataRec] = novoMarco();
          const ref = grupo.marcos[dataRec];

          const fluxoValido = !isNaN(c.fluxo) && c.fluxo > 0;
          const eficValida = !isNaN(c.efic) && c.efic > 0;
          if (fluxoValido) { ref.somaFluxo += c.fluxo; ref.qtd++; }
          if (eficValida) { ref.somaEfic += c.efic; ref.qtdEfic++; }

          ref.amostras.push({
            id: c.identificador,
            modeloOriginal: c.mod,
            fluxo: fluxoValido ? c.fluxo : NaN,
            efic: eficValida ? c.efic : NaN
          });
        } catch (errDoc) {
          errosLeitura.push({ path, docId: doc.id, msg: errDoc.message });
          console.warn(`Falha ao ler doc ${path}/${doc.id}:`, errDoc);
        }
      });
    }

    const fundidos = reconciliarGrupos();
    validarIntegridadeGrupos();

    marcosAtuais = Array.from(datasSet).sort((a, b) => parseDateString(a) - parseDateString(b));

    if (totalAmostras === 0) {
      showStatus("warning", "Contrato Vazio",
        `Nenhum documento de ensaio encontrado (${pathsLidos} coleção(ões) acessível(is)).`);
      return;
    }

    const qtdModelos = Object.keys(dadosAgrupadosContrato).length;
    let msg = `${totalAmostras} luminárias · ${qtdModelos} modelos · ${marcosAtuais.length} data(s) de recebimento. `
            + `Com nominal no catálogo: ${mapeadas} · Sem nominal: ${naoMapeadas}.`;
    if (fundidos) msg += ` ${fundidos} grupo(s) truncado(s) reconciliado(s).`;
    if (duplicatasIgnoradas) msg += ` ${duplicatasIgnoradas} registro(s) duplicado(s) descartado(s).`;
    if (errosLeitura.length) msg += ` ${errosLeitura.length} documento(s) ignorado(s) por erro de leitura.`;

    showStatus(errosLeitura.length ? "warning" : "success", "Varredura Concluída", msg);
    renderMasterTable();
  } catch (err) {
    console.error("Erro na varredura:", err);
    showStatus("error", "Erro ao processar dados", err.message || String(err));
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="ti ti-radar"></i> Varrer Contrato`;
  }
}

// ============================================
// 5. TABELA MESTRE
// ============================================
function datasOrdenadas(modelo) {
  return Object.keys(modelo.marcos)
    .filter(d => modelo.marcos[d].amostras.length > 0)
    .sort((a, b) => parseDateString(a) - parseDateString(b));
}

function totalAmostrasModelo(modelo) {
  return Object.values(modelo.marcos).reduce((s, m) => s + m.amostras.length, 0);
}

function renderMasterTable() {
  const tbody = document.getElementById("masterTableBody");
  tbody.innerHTML = "";

  const lista = Object.values(dadosAgrupadosContrato).sort((a, b) => {
    if (a.isFallback !== b.isFallback) return a.isFallback ? 1 : -1;
    return totalAmostrasModelo(b) - totalAmostrasModelo(a);
  });

  lista.forEach(modelo => {
    const fluxoNominal = parseNum(modelo.nominal.fluxo_luminoso_lm);
    const nominalValido = !isNaN(fluxoNominal) && fluxoNominal > 0;

    const datas = datasOrdenadas(modelo);
    let ultimoComDados = null, total = 0;
    datas.forEach(d => {
      total += modelo.marcos[d].amostras.length;
      if (modelo.marcos[d].qtd > 0) ultimoComDados = modelo.marcos[d];
    });

    const mFluxo = ultimoComDados ? ultimoComDados.somaFluxo / ultimoComDados.qtd : null;
    const percManut = (mFluxo !== null && nominalValido) ? safePerc(mFluxo, fluxoNominal) : null;
    const fam = String(modelo.familia || "Desconhecido");

    const tagFallback = modelo.isFallback
      ? `<span style="font-size:0.7rem;color:#E24B4A;border:1px solid #E24B4A;border-radius:4px;padding:1px 4px;margin-left:4px;">SEM NOMINAL</span>`
      : "";

    const tagVariantes = modelo.variantes.size > 1
      ? `<span style="font-size:0.7rem;color:var(--text-muted);border:1px solid var(--border-strong);border-radius:4px;padding:1px 4px;margin-left:4px;cursor:help;"
              title="${escapeHtml(Array.from(modelo.variantes.keys()).join(" | "))}">${modelo.variantes.size} grafias</span>`
      : "";

    const tagAlerta = (modelo.basesDistintas && modelo.basesDistintas.length > 1)
      ? `<span style="font-size:0.7rem;color:#fff;background:#E24B4A;border-radius:4px;padding:1px 4px;margin-left:4px;">REVISAR</span>`
      : "";

    const tagDatas = datas.length > 1
      ? `<span style="font-size:0.7rem;color:var(--text-muted);margin-left:4px;">${datas.length} datas</span>`
      : "";

    const tr = document.createElement("tr");
    tr.onclick = () => renderDetailView(modelo.id, tr);
    tr.innerHTML = `
      <td>
        <span class="step-badge" style="background:${modelo.isFallback ? 'var(--text-muted)' : 'var(--brand-mid)'}">${initial(fam)}</span>
        ${escapeHtml(fam.replace(/_/g, " "))}
      </td>
      <td><strong>${escapeHtml(modelo.label || modelo.id)}</strong>${tagFallback}${tagVariantes}${tagDatas}${tagAlerta}</td>
      <td class="num">${total}</td>
      <td class="num">${nominalValido ? fluxoNominal.toLocaleString("pt-BR") + " lm" : "—"}</td>
      <td class="num">${fmtPerc(percManut)}</td>
      <td><span class="pill ${pillClass(percManut)}">${pillLabel(percManut)}</span></td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById("masterSection").style.display = "block";
}

// ============================================
// 6. DEPRECIAÇÃO AO LONGO DO TEMPO
// ============================================
function regressaoLinear(pontos) {
  const n = pontos.length;
  if (n < 2) return null;

  const mx = pontos.reduce((s, p) => s + p.x, 0) / n;
  const my = pontos.reduce((s, p) => s + p.y, 0) / n;

  let num = 0, den = 0;
  pontos.forEach(p => { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; });
  if (den === 0) return null;

  const b = num / den;          // %/dia
  const a = my - b * mx;

  let sse = 0, sst = 0;
  pontos.forEach(p => { const yh = a + b * p.x; sse += (p.y - yh) ** 2; sst += (p.y - my) ** 2; });
  const r2 = sst > 0 ? 1 - sse / sst : null;

  return { a, b, r2, n };
}

/**
 * Recebe as linhas do detalhe e devolve tendência de depreciação do fluxo.
 * x = dias decorridos desde a primeira data datável do modelo.
 */
function analisarDepreciacao(linhas, campoPerc) {
  const pontos = [];
  let t0 = null;

  linhas.forEach(l => {
    const dt = toDate(l.marcoData);
    const y = l[campoPerc];
    if (!dt || y === null || y === undefined || isNaN(y)) return;
    if (!t0) t0 = dt;
    pontos.push({ x: diffDias(t0, dt), y, data: l.marcoData, qtd: l.qtd });
  });

  if (pontos.length < 2) {
    return { valido: false, pontos, motivo: pontos.length === 1
      ? "apenas uma data datável — sem série temporal"
      : "sem datas válidas para série temporal" };
  }

  const reg = regressaoLinear(pontos);
  if (!reg) return { valido: false, pontos, motivo: "datas idênticas — sem variação de tempo" };

  const janelaDias = pontos[pontos.length - 1].x - pontos[0].x;
  const taxaAno = reg.b * 365;

  let cruza90 = null;
  if (reg.b < -1e-9) {
    const dias90 = (90 - reg.a) / reg.b;
    if (isFinite(dias90) && dias90 > 0) {
      const dt = new Date(toDate(pontos[0].data).getTime() + dias90 * 86400000);
      cruza90 = { dias: Math.round(dias90), data: dataParaTexto(dt), passado: dias90 <= janelaDias };
    }
  }

  return {
    valido: true, pontos, reg, taxaAno, janelaDias, cruza90,
    prever: x => reg.a + reg.b * x,
    t0: pontos[0].data,
    tn: pontos[pontos.length - 1].data
  };
}

function stripDepreciacao(dep, temNominal) {
  if (!temNominal) {
    return `<div style="padding:10px 14px;background:#FEF2F2;border-left:3px solid var(--red);font-size:0.82rem;color:var(--text-secondary);">
      Curva de depreciação indisponível: modelo sem fluxo nominal no catálogo.
    </div>`;
  }
  if (!dep.valido) {
    return `<div style="padding:10px 14px;background:#F8FAFC;border-left:3px solid var(--border-strong);font-size:0.82rem;color:var(--text-secondary);">
      Curva de depreciação indisponível: ${escapeHtml(dep.motivo)}.
    </div>`;
  }

  const sinal = dep.taxaAno < 0 ? "" : "+";
  const cor = dep.taxaAno < -1 ? "var(--red-mid)" : dep.taxaAno < 0 ? "var(--text-primary)" : "var(--teal)";
  const r2 = dep.reg.r2 !== null ? fmt(dep.reg.r2 * 100, 0) + "%" : "—";

  const proj = dep.cruza90
    ? (dep.cruza90.passado
        ? `<strong style="color:var(--red-mid)">já abaixo de 90%</strong> (cruzou em ${dep.cruza90.data})`
        : `atinge 90% em <strong>${dep.cruza90.data}</strong>`)
    : "sem tendência de queda projetável";

  return `
    <div style="display:flex;flex-wrap:wrap;gap:18px;padding:10px 14px;background:#F8FAFC;
                border-left:3px solid ${cor};font-size:0.82rem;color:var(--text-secondary);">
      <span>Janela: <strong>${escapeHtml(dep.t0)} → ${escapeHtml(dep.tn)}</strong> (${dep.janelaDias} dias, ${dep.pontos.length} pontos)</span>
      <span>Depreciação: <strong style="color:${cor}">${sinal}${fmt(dep.taxaAno, 2)} p.p./ano</strong></span>
      <span>Aderência da reta (R²): <strong>${r2}</strong></span>
      <span>Projeção: ${proj}</span>
    </div>`;
}

// ============================================
// 7. DETALHE
// ============================================
function renderDetailView(modeloId, trElement) {
  document.querySelectorAll("#masterTableBody tr").forEach(tr => tr.classList.remove("active"));
  if (trElement) trElement.classList.add("active");

  const modelo = dadosAgrupadosContrato[modeloId];
  if (!modelo) return;

  const avisoNominal = modelo.isFallback
    ? `<br><small style="color:var(--red);font-weight:normal;">Sem dados nominais do fabricante no Firestore. Cálculos de depreciação desativados.</small>`
    : "";

  const grafias = Array.from(modelo.variantes.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([nome, qtd]) => `${escapeHtml(nome)} (${qtd})`)
    .join(" · ");

  const avisoVariantes = modelo.variantes.size > 1
    ? `<br><small style="color:var(--text-muted);font-weight:normal;">Assinatura: <strong>${escapeHtml(assinaturaLegivel(modelo.sig, modelo.label))}</strong> — grafias agrupadas: ${grafias}</small>`
    : "";

  document.getElementById("lblModeloSelecionado").innerHTML =
    `<i class="ti ti-device-computer-camera"></i> Análise: ${escapeHtml(modelo.label)}
     <span style="font-size:0.8rem;color:var(--text-muted);font-weight:400;margin-left:12px;">(Família: ${escapeHtml(modelo.familia)})</span>
     ${avisoNominal}${avisoVariantes}`;

  const fluxoNominal = parseNum(modelo.nominal.fluxo_luminoso_lm);
  const eficNominal = parseNum(modelo.nominal.eficiencia_lm_w);
  const fluxoNominalValido = !isNaN(fluxoNominal) && fluxoNominal > 0;
  const eficNominalValido = !isNaN(eficNominal) && eficNominal > 0;

  const datas = datasOrdenadas(modelo);

  const mediasFluxo = [fluxoNominalValido ? 100 : null];
  const mediasEfic = [eficNominalValido ? 100 : null];
  const linhasTabela = [];

  let ultPercFluxo = null, ultPercEfic = null, ultData = "Sem dados";

  datas.forEach(marcoData => {
    const dm = modelo.marcos[marcoData];
    const mFluxo = dm.qtd > 0 ? dm.somaFluxo / dm.qtd : NaN;
    const mEfic = dm.qtdEfic > 0 ? dm.somaEfic / dm.qtdEfic : NaN;

    const percFluxo = fluxoNominalValido ? safePerc(mFluxo, fluxoNominal) : null;
    const percEfic = eficNominalValido ? safePerc(mEfic, eficNominal) : null;
    const desvioLm = (fluxoNominalValido && !isNaN(mFluxo)) ? mFluxo - fluxoNominal : null;

    mediasFluxo.push(percFluxo);
    mediasEfic.push(percEfic);
    if (percFluxo !== null) ultPercFluxo = percFluxo;
    if (percEfic !== null) ultPercEfic = percEfic;
    ultData = marcoData;

    linhasTabela.push({
      marcoData, qtd: dm.amostras.length,
      mFluxo, percFluxo, desvioLm,
      ncFluxoPerc: percFluxo !== null ? 100 - percFluxo : null,
      mEfic, percEfic,
      ncEficPerc: percEfic !== null ? 100 - percEfic : null,
      amostras: dm.amostras
    });
  });

  // --- Tendência de depreciação (fluxo) ---
  const dep = analisarDepreciacao(linhasTabela, "percFluxo");

  // Série da reta alinhada às categorias do gráfico (índice 0 = Nominal)
  const trendFluxo = [null];
  if (dep.valido) {
    const t0 = toDate(dep.t0);
    datas.forEach(d => {
      const dt = toDate(d);
      trendFluxo.push(dt ? dep.prever(diffDias(t0, dt)) : null);
    });
  }

  setMetricCard("metFluxoNom", fluxoNominalValido ? `${fluxoNominal.toLocaleString("pt-BR")} lm` : "—", "Nominal catálogo", "");
  setMetricCard("metEficNom", eficNominalValido ? `${fmt(eficNominal)} lm/W` : "—", "Nominal catálogo", "");

  if (ultPercFluxo !== null) {
    const sub = dep.valido
      ? `Ref: ${ultData} · ${dep.taxaAno < 0 ? "" : "+"}${fmt(dep.taxaAno, 2)} p.p./ano`
      : `Ref: ${ultData}`;
    setMetricCard("metFluxoUlt", fmtPerc(ultPercFluxo), sub,
      ultPercFluxo >= 95 ? "positive" : ultPercFluxo >= 90 ? "warning" : "negative");
  } else {
    setMetricCard("metFluxoUlt", "—", "Manutenção (falta catálogo)", "");
  }

  if (ultPercEfic !== null) {
    setMetricCard("metEficUlt", fmtPerc(ultPercEfic), `Ref: ${ultData}`,
      ultPercEfic >= 95 ? "positive" : ultPercEfic >= 90 ? "warning" : "negative");
  } else {
    setMetricCard("metEficUlt", "—", "Sem dados cruzados", "");
  }

  renderCharts(mediasFluxo, mediasEfic, ["Nominal", ...datas.map(labelData)], datas, trendFluxo, dep);

  const wrapper = document.querySelector("#detailSection .results-table-wrapper");
  wrapper.innerHTML = `
    ${stripDepreciacao(dep, fluxoNominalValido)}
    <table class="results-table">
      <thead>
        <tr>
          <th>Data (Recebimento)</th>
          <th class="num">Qtd</th>
          <th class="num">Fluxo (lm)</th>
          <th class="num">Desvio (lm)</th>
          <th class="num">Manut. (%)</th>
          <th class="num">NC Fluxo</th>
          <th class="num">Efic. (lm/W)</th>
          <th class="num">NC Efic.</th>
          <th>Status Inmetro</th>
        </tr>
      </thead>
      <tbody id="detailTableBody">
        <tr style="background:#F8FAFC;">
          <td><strong>Nominal (Catálogo)</strong></td>
          <td class="num">—</td>
          <td class="num">${fluxoNominalValido ? fluxoNominal.toLocaleString("pt-BR") : "—"}</td>
          <td class="num" style="color:var(--text-muted)">0</td>
          <td class="num">${fluxoNominalValido ? "100,0%" : "—"}</td>
          <td class="num" style="color:var(--text-muted)">${fluxoNominalValido ? "0,0%" : "—"}</td>
          <td class="num">${eficNominalValido ? fmt(eficNominal) : "—"}</td>
          <td class="num" style="color:var(--text-muted)">${eficNominalValido ? "0,0%" : "—"}</td>
          <td><span class="pill ok">Referência</span></td>
        </tr>
      </tbody>
    </table>`;

  const tbody = document.getElementById("detailTableBody");
  const t0Dep = dep.valido ? toDate(dep.t0) : null;
  let html = "";

  linhasTabela.forEach((r, idx) => {
    const expansivel = r.amostras && r.amostras.length > 1;
    const subRowId = `subrow-${idx}`;
    const sinal = (r.desvioLm !== null && r.desvioLm > 0) ? "+" : "";

    const dt = toDate(r.marcoData);
    const decorrido = (t0Dep && dt) ? `<span style="font-size:0.72rem;color:var(--text-muted);margin-left:6px;">+${diffDias(t0Dep, dt)}d</span>` : "";

    html += `
      <tr ${expansivel ? `class="expandable-row" onclick="toggleSubRow('${subRowId}')" title="Clique para ver luminárias individuais"` : ""}>
        <td>
          ${expansivel ? '<i class="ti ti-chevron-right expand-icon"></i> ' : '<span style="display:inline-block;width:16px;"></span>'}
          <strong>${escapeHtml(r.marcoData)}</strong>${decorrido}
        </td>
        <td class="num">${r.qtd} un.</td>
        <td class="num">${fmtInt(r.mFluxo)}</td>
        <td class="num" style="${corDesvio(r.desvioLm, false)}">${sinal}${fmtInt(r.desvioLm)}</td>
        <td class="num"><strong>${fmtPerc(r.percFluxo)}</strong></td>
        <td class="num" style="${corDesvio(r.ncFluxoPerc, true)}">${fmtPerc(r.ncFluxoPerc)}</td>
        <td class="num">${fmt(r.mEfic)}</td>
        <td class="num" style="${corDesvio(r.ncEficPerc, true)}">${fmtPerc(r.ncEficPerc)}</td>
        <td><span class="pill ${pillClass(r.percFluxo)}">${pillLabel(r.percFluxo)}</span></td>
      </tr>`;

    if (!expansivel) return;

    const subRows = r.amostras.map(a => {
      const aDesvio = (fluxoNominalValido && !isNaN(a.fluxo)) ? a.fluxo - fluxoNominal : null;
      const aPercF = fluxoNominalValido ? safePerc(a.fluxo, fluxoNominal) : null;
      const aNcF = aPercF !== null ? 100 - aPercF : null;
      const aPercE = eficNominalValido ? safePerc(a.efic, eficNominal) : null;
      const aNcE = aPercE !== null ? 100 - aPercE : null;
      const s2 = (aDesvio !== null && aDesvio > 0) ? "+" : "";

      return `
        <tr class="sub-item-row">
          <td style="padding-left:2rem;font-size:0.8rem;color:var(--text-secondary);max-width:250px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
              title="${escapeHtml(a.id)} — ${escapeHtml(a.modeloOriginal || "")}">
            <i class="ti ti-file-analytics"></i> ${escapeHtml(a.id)}
          </td>
          <td class="num" style="font-size:0.8rem;">1 un.</td>
          <td class="num" style="font-size:0.8rem;">${fmtInt(a.fluxo)}</td>
          <td class="num" style="font-size:0.8rem;${corDesvio(aDesvio, false)}">${s2}${fmtInt(aDesvio)}</td>
          <td class="num" style="font-size:0.8rem;">${fmtPerc(aPercF)}</td>
          <td class="num" style="font-size:0.8rem;${corDesvio(aNcF, true)}">${fmtPerc(aNcF)}</td>
          <td class="num" style="font-size:0.8rem;">${fmt(a.efic)}</td>
          <td class="num" style="font-size:0.8rem;${corDesvio(aNcE, true)}">${fmtPerc(aNcE)}</td>
          <td><span class="pill ${pillClass(aPercF)}" style="transform:scale(0.85);transform-origin:left;">${pillLabel(aPercF)}</span></td>
        </tr>`;
    }).join("");

    html += `
      <tr id="${subRowId}" style="display:none;background:#F8FAFC;border-top:none;">
        <td colspan="9" style="padding:0;">
          <table class="results-table sub-table" style="width:100%;border-top:1px solid var(--border-strong);border-bottom:2px solid var(--border-strong);box-shadow:inset 0 2px 4px rgba(0,0,0,0.02);">
            <tbody>${subRows}</tbody>
          </table>
        </td>
      </tr>`;
  });

  tbody.insertAdjacentHTML("beforeend", html);

  const detail = document.getElementById("detailSection");
  detail.style.display = "flex";
  detail.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ============================================
// 8. GRÁFICOS
// ============================================
function renderCharts(mediasFluxo, mediasEfic, labels, datasFull, trendFluxo, dep) {
  const vals = [...mediasFluxo, ...mediasEfic, ...(trendFluxo || [])]
    .filter(v => v !== null && v !== undefined && !isNaN(v));
  const minVal = vals.length ? Math.min(...vals, 100) : 90;
  const maxVal = vals.length ? Math.max(...vals, 100) : 105;
  const yMin = Math.min(85, Math.floor((minVal - 5) / 5) * 5);
  const yMax = Math.max(105, Math.ceil((maxVal + 5) / 5) * 5);

  const t0 = (dep && dep.valido) ? toDate(dep.t0) : null;

  const baseOpts = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: items => {
            const i = items[0].dataIndex;
            if (i === 0) return "Nominal (catálogo)";
            const d = (datasFull && datasFull[i - 1]) ? datasFull[i - 1] : items[0].label;
            const dt = toDate(d);
            return (t0 && dt) ? `${d}  (+${diffDias(t0, dt)} dias)` : d;
          },
          label: ctx => `${ctx.dataset.label}: ${fmtPerc(ctx.parsed.y)}`
        }
      }
    },
    scales: {
      x: { ticks: { font: { size: 11 }, maxRotation: 45, autoSkip: false }, grid: { color: "#F1F5F9" } },
      y: { min: yMin, max: yMax, ticks: { font: { size: 11 }, callback: v => v + "%" }, grid: { color: "#F1F5F9" } }
    }
  };

  const limitPlugin = {
    id: "limitLine",
    afterDraw(chart) {
      const { ctx, scales: { y, x } } = chart;
      const y90 = y.getPixelForValue(90);
      if (y90 > y.bottom || y90 < y.top) return;
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = CORES.limite;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x.left, y90);
      ctx.lineTo(x.right, y90);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = CORES.limite;
      ctx.font = "10px Inter, sans-serif";
      ctx.fillText("limite 90%", x.right - 58, y90 - 4);
      ctx.restore();
    }
  };

  const datasetsFluxo = [{
    label: "Fluxo medido", data: mediasFluxo,
    borderColor: CORES.medido, backgroundColor: "rgba(15,110,86,0.07)",
    borderWidth: 2.5, pointRadius: 6, pointBackgroundColor: "#fff",
    fill: true, spanGaps: true, order: 1
  }];

  if (trendFluxo && trendFluxo.some(v => v !== null && !isNaN(v))) {
    datasetsFluxo.push({
      label: "Tendência (depreciação)", data: trendFluxo,
      borderColor: CORES.tendencia, borderWidth: 1.5, borderDash: [4, 4],
      pointRadius: 0, fill: false, spanGaps: true, order: 2
    });
  }

  if (chartFluxo) chartFluxo.destroy();
  chartFluxo = new Chart(document.getElementById("chartFluxo").getContext("2d"), {
    type: "line",
    data: { labels, datasets: datasetsFluxo },
    options: baseOpts,
    plugins: [limitPlugin]
  });

  if (chartEfic) chartEfic.destroy();
  chartEfic = new Chart(document.getElementById("chartEfic").getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Eficiência medida", data: mediasEfic,
        borderColor: CORES.eficiencia, backgroundColor: "rgba(186,117,23,0.07)",
        borderWidth: 2.5, pointRadius: 6, pointBackgroundColor: "#fff",
        fill: true, spanGaps: true, borderDash: [6, 3]
      }]
    },
    options: baseOpts,
    plugins: [limitPlugin]
  });
}

// ============================================
// 9. AUDITORIA (console)
// ============================================
window.auditarAgrupamento = function () {
  const rows = Object.values(dadosAgrupadosContrato).map(g => ({
    chave: g.id,
    label: g.label,
    assinatura: assinaturaLegivel(g.sig, g.label),
    bases: (g.basesDistintas || []).join(", "),
    grafias: g.variantes.size,
    amostras: totalAmostrasModelo(g),
    datas: Object.keys(g.marcos).length,
    nominal: g.isFallback ? "NÃO" : "SIM"
  })).sort((a, b) => b.amostras - a.amostras);

  console.table(rows);
  if (errosLeitura.length) console.table(errosLeitura);
  if (duplicatasIgnoradas) console.info(`Duplicatas descartadas: ${duplicatasIgnoradas}`);
  return rows;
};

window.exportarAuditoriaCSV = function () {
  const rows = window.auditarAgrupamento();
  const head = Object.keys(rows[0] || { chave: "" });
  const csv = [head.join(";")]
    .concat(rows.map(r => head.map(h => `"${String(r[h]).replace(/"/g, '""')}"`).join(";")))
    .join("\n");

  const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `auditoria_agrupamento_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};

// ============================================
// INIT
// ============================================
window.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btnAnalisar");
  if (btn) {
    btn.disabled = true;
    btn.addEventListener("click", analisarContrato);
  }
  carregarCatalogoMaster();
});
