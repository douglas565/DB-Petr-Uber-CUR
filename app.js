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
let chartEfic  = null;
let catalogoModelos = [];
let dadosAgrupadosContrato = {};
let marcosAtuais = [];


const CONFIG_CONTRATOS = {
    "UDI": {
        tipo: "padrao",
        marcos: [
            { label: "1º Marco", paths: ["Ensaios Laboratório/1º Marco/itens"] },
            { label: "2º Marco", paths: ["Ensaios Laboratório/2º Marco/itens"] },
            { label: "3º Marco", paths: ["Ensaios Laboratório/3º Marco/itens"] }
        ]
    },
    "PNZ": {
        tipo: "padrao",
        marcos: [
            { label: "1º Marco", paths: ["Ensaios Laboratório/1º Marco/itens"] },
            { label: "2º Marco", paths: ["Ensaios Laboratório/2º Marco/itens"] },
            { label: "3º Marco", paths: ["Ensaios Laboratório/3º Marco/itens"] }
        ]
    },
    "CWB": {
        tipo: "cwb",
        marcos: [
            { label: "2023",     paths: ["2023/nao_informado/ensaios", "anos/2023/meses/nao_informado/ensaios"] },
            { label: "Fev/2025", paths: ["2025/fevereiro/ensaios", "anos/2025/meses/fevereiro/ensaios"] },
            { label: "Mai/2025", paths: ["2025/maio/ensaios", "anos/2025/meses/maio/ensaios"] }
        ]
    }
};

const CORES = { medido: "#0F6E56", limite: "#E24B4A", eficiencia: "#BA7517" };

// ============================================
// UTILS & UI
// ============================================
function fmt(n, dec = 1) { return (n === null || isNaN(n)) ? "—" : Number(n).toFixed(dec); }
function fmtPerc(n) { return n !== null && !isNaN(n) ? fmt(n) + "%" : "—"; }

// Divisão segura: retorna null se denominador inválido
function safePerc(valor, base) {
    if (base === null || isNaN(base) || base <= 0) return null;
    if (valor === null || isNaN(valor)) return null;
    return (valor / base) * 100;
}

function corDesvio(n, isNC = false) {
    if (n === null || isNaN(n)) return "";
    if (isNC) {
        return n > 0 ? "color: var(--red-mid); font-weight: bold;" : "color: var(--teal);";
    }
    return n < 0 ? "color: var(--red-mid); font-weight: bold;" : "color: var(--teal);";
}

function pillClass(perc) {
    if (perc === null || isNaN(perc)) return "na";
    if (perc >= 95)  return "ok";
    if (perc >= 90)  return "warn";
    return "bad";
}

function pillLabel(perc) {
    if (perc === null || isNaN(perc)) return "N/A";
    if (perc >= 95)  return "✓ Regular";
    if (perc >= 90)  return "⚠ Atenção";
    return "✕ Crítico";
}

function showStatus(type, title, body = "") {
    const icons = { loading: "ti-loader-2", success: "ti-circle-check", warning: "ti-alert-triangle", error: "ti-alert-circle" };
    const el = document.getElementById("statusBanner");
    el.className = `status-banner visible ${type}`;
    el.innerHTML = `
        ${type === "loading" ? `<div class="spinner"></div>` : `<i class="ti ${icons[type]}"></i>`}
        <div class="status-text"><strong>${title}</strong>${body ? `<span>${body}</span>` : ""}</div>`;
}

function setMetricCard(id, value, sub, deltaClass) {
    const card = document.getElementById(id);
    if (!card) return;
    card.querySelector(".metric-value").className = `metric-value ${deltaClass}`;
    card.querySelector(".metric-value").textContent = value;
    if (sub !== null) card.querySelector(".metric-sub").textContent = sub;
}

window.toggleSubRow = function(subRowId) {
    const subRow = document.getElementById(subRowId);
    const icon = subRow.previousElementSibling.querySelector('.expand-icon');
    if (subRow.style.display === "none") {
        subRow.style.display = "table-row";
        if(icon) icon.style.transform = "rotate(90deg)";
    } else {
        subRow.style.display = "none";
        if(icon) icon.style.transform = "rotate(0deg)";
    }
};

// ============================================
// 1. CARREGAR CATÁLOGO (EM MEMÓRIA)
// ============================================
async function carregarCatalogoMaster() {
    try {
        const snap = await db.collectionGroup("modelos").get();
        snap.forEach(doc => {
            if (doc.ref.parent.parent) {
                catalogoModelos.push({
                    id: doc.id,
                    familiaId: doc.ref.parent.parent.id,
                    data: doc.data()
                });
            }
        });

        document.getElementById("btnAnalisar").disabled = false;
        document.getElementById("connText").textContent = `Catálogo Sincronizado (${catalogoModelos.length} modelos)`;
    } catch (err) {
        console.error("Erro ao carregar catálogo base:", err);
        showStatus("error", "Erro de Conexão", "Não foi possível carregar os modelos base do Firestore.");
        document.getElementById("connText").textContent = "Erro de Conexão";
        document.getElementById("connBadge").style.background = "var(--red-light)";
        document.getElementById("connBadge").style.color = "var(--red)";
    }
}

// ============================================
// 2. ALGORITMO INTELIGENTE DE CRUZAMENTO
// ============================================
function encontrarModeloBase(labFab, labMod, labPotDeclarada) {
    if (!labMod) return null;

    labFab = String(labFab || "").toUpperCase();
    labMod = String(labMod || "").toUpperCase();
    const potMedidaNum = labPotDeclarada ? parseFloat(String(labPotDeclarada).replace(',', '.')) : null;

    let melhorMatch = null;
    let melhorPontuacao = -1;

    for (const cat of catalogoModelos) {
        const baseFam = String(cat.data.familia || "").toUpperCase();
        const baseModId = String(cat.data.modelo || cat.data.modelo_base || cat.id).toUpperCase();

        let basePot = null;
        if (cat.data.potencia_W) {
            basePot = parseFloat(String(cat.data.potencia_W).replace(',', '.').replace(/[^\d.]/g, ''));
        }

        let matchPot = true;
        if (basePot && !isNaN(basePot)) {
            if (potMedidaNum && !isNaN(potMedidaNum)) {
                if (Math.abs(basePot - potMedidaNum) > 5) matchPot = false;
            } else {
                const strPot = String(basePot).replace(".0", "");
                const regexPot = new RegExp(`\\b${strPot}\\s*[-_]?\\s*W\\b`, "i");
                if (!regexPot.test(labMod)) matchPot = false;
            }
        }

        if (!matchPot) continue;

        let pts = 0;
        if (labMod.includes(baseModId)) pts += 100;

        const tokens = baseModId.split(/[\s\-_]+/);
        for (const tok of tokens) {
            if (tok.length > 2 && labMod.includes(tok)) pts += (tok.length * 2);
        }

        if (labFab && baseFam && (labFab.includes(baseFam) || baseFam.includes(labFab))) {
            pts += 50;
        }

        if (pts > 0 && pts > melhorPontuacao) {
            melhorPontuacao = pts;
            melhorMatch = cat;
        }
    }

    // Volta ao comportamento original: aceita qualquer match com pontuação > 0.
    return melhorMatch;
}

// ============================================
// 3. VARREDURA DO CONTRATO
// ============================================
async function analisarContrato() {
    const contratoId = document.getElementById("contratoSelect").value;
    const btn = document.getElementById("btnAnalisar");

    btn.disabled = true;
    btn.innerHTML = `<div class="spinner"></div> Varrendo...`;
    showStatus("loading", "Analisando Laboratório...", `Lendo estrutura e cruzando dados do contrato ${contratoId}...`);

    document.getElementById("masterSection").style.display = "none";
    document.getElementById("detailSection").style.display = "none";

    dadosAgrupadosContrato = {};
    const configAtual = CONFIG_CONTRATOS[contratoId];
    marcosAtuais = configAtual.marcos.map(m => m.label);

    try {
        let totalAmostrasEncontradas = 0;
        let itensDescartados = 0;

        for (const marco of configAtual.marcos) {
            let snap = null;

            for (const path of marco.paths) {
                const tempSnap = await db.collection("contratos").doc(contratoId).collection(path).get();
                if (!tempSnap.empty) {
                    snap = tempSnap;
                    break;
                }
            }

            if (!snap || snap.empty) continue;

            snap.forEach(doc => {
                const d = doc.data();
                if (!d) return;

                let fab, mod, pot, fluxo, efic, identificador;

                if (configAtual.tipo === "cwb") {
                    fab = d["FABRICANTE"];
                    mod = d["MODELO"];
                    pot = d["POTENCIA DECLARADO (W)"] || d["POTENCIA (W)"];
                    fluxo = parseFloat(d["FLUXO LUMINOSO (LM)"]);
                    efic  = parseFloat(d["EFICACIA (LM/W)"]);
                    identificador = d["RELATORIO"] || doc.id;
                } else {
                    fab = d.metadata?.fabricante;
                    mod = d.metadata?.modelo || d.metadata?.arquivo;
                    pot = null;
                    fluxo = parseFloat(d.dados_tecnicos?.fluxoLuminosoLuminaria);
                    efic  = parseFloat(d.dados_tecnicos?.eficienciaLuminosaTotal);
                    identificador = d.metadata?.arquivo || doc.id;
                }

                const modeloBase = encontrarModeloBase(fab, mod, pot);
                const fluxoValido = !isNaN(fluxo) && fluxo > 0;
                const eficValida  = !isNaN(efic) && efic > 0;

                if (modeloBase && fluxoValido) {
                    totalAmostrasEncontradas++;
                    const modId = modeloBase.id;

                    if (!dadosAgrupadosContrato[modId]) {
                        dadosAgrupadosContrato[modId] = { id: modId, familia: modeloBase.familiaId, nominal: modeloBase.data, marcos: {} };
                    }

                    if (!dadosAgrupadosContrato[modId].marcos[marco.label]) {
                        dadosAgrupadosContrato[modId].marcos[marco.label] = {
                            somaFluxo: 0,
                            somaEfic: 0,
                            qtd: 0,        // quantidade válida de fluxo
                            qtdEfic: 0,    // quantidade válida de eficácia (contador independente)
                            amostras: []
                        };
                    }

                    const ref = dadosAgrupadosContrato[modId].marcos[marco.label];
                    ref.somaFluxo += fluxo;
                    ref.qtd++;

                    // Só soma eficácia se for válida — evita contaminar a média com NaN
                    if (eficValida) {
                        ref.somaEfic += efic;
                        ref.qtdEfic++;
                    }

                    ref.amostras.push({
                        id: identificador,
                        fluxo: fluxo,
                        efic: eficValida ? efic : NaN
                    });

                } else {
                    itensDescartados++;
                }
            });
        }

        if (totalAmostrasEncontradas === 0) {
            showStatus("warning", "Nenhum modelo validado", `Ignoramos ${itensDescartados} itens do banco por falta de "Match" com o seu catálogo de modelos.`);
        } else {
            const qtdModelosDiferentes = Object.keys(dadosAgrupadosContrato).length;
            showStatus("success", "Varredura Concluída", `Identificamos ${qtdModelosDiferentes} modelo(s) validado(s) englobando ${totalAmostrasEncontradas} amostra(s).`);
            renderMasterTable();
        }

    } catch (err) {
        console.error("Erro na varredura:", err);
        showStatus("error", "Erro ao processar dados", err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="ti ti-radar"></i> Varrer Contrato`;
    }
}

// ============================================
// 4. RENDERIZAR TABELA MESTRE
// ============================================
function renderMasterTable() {
    const tbody = document.getElementById("masterTableBody");
    tbody.innerHTML = "";

    Object.values(dadosAgrupadosContrato).forEach(modelo => {
        const fluxoNominal = parseFloat(modelo.nominal.fluxo_luminoso_lm) || 0;
        let ultimoMarcoData = null;
        let totalAmostras = 0;

        marcosAtuais.forEach(m => {
            if (modelo.marcos[m]) {
                ultimoMarcoData = modelo.marcos[m];
                totalAmostras += modelo.marcos[m].qtd;
            }
        });

        const mFluxo = (ultimoMarcoData && ultimoMarcoData.qtd > 0) ? (ultimoMarcoData.somaFluxo / ultimoMarcoData.qtd) : 0;
        const percManut = safePerc(mFluxo, fluxoNominal);

        const tr = document.createElement("tr");
        tr.onclick = () => renderDetailView(modelo.id, tr);
        tr.innerHTML = `
            <td><span class="step-badge" style="background: var(--brand-mid)">${modelo.familia.charAt(0).toUpperCase()}</span> ${modelo.familia.replace(/_/g, " ")}</td>
            <td><strong>${modelo.id}</strong></td>
            <td class="num">${totalAmostras}</td>
            <td class="num">${fluxoNominal.toLocaleString("pt-BR")} lm</td>
            <td class="num">${fmtPerc(percManut)}</td>
            <td><span class="pill ${pillClass(percManut)}">${pillLabel(percManut)}</span></td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById("masterSection").style.display = "block";
}

// ============================================
// 5. RENDERIZAR DETALHE E TABELA DE EXPANSÃO
// ============================================
function renderDetailView(modeloId, trElement) {
    document.querySelectorAll("#masterTableBody tr").forEach(tr => tr.classList.remove("active"));
    trElement.classList.add("active");

    const modelo = dadosAgrupadosContrato[modeloId];
    document.getElementById("lblModeloSelecionado").innerHTML = `<i class="ti ti-device-computer-camera"></i> Análise do Modelo: ${modeloId} <span style="font-size:0.8rem; color:var(--text-muted); font-weight:400; margin-left:12px;">(Família: ${modelo.familia})</span>`;

    const fluxoNominal = parseFloat(modelo.nominal.fluxo_luminoso_lm);
    const eficNominal  = parseFloat(modelo.nominal.eficiencia_lm_w);

    // Guard: se os valores nominais forem inválidos, avisa e interrompe
    const fluxoNominalValido = !isNaN(fluxoNominal) && fluxoNominal > 0;
    const eficNominalValido  = !isNaN(eficNominal) && eficNominal > 0;

    if (!fluxoNominalValido) {
        showStatus("warning", "Nominal ausente", `O modelo ${modeloId} não possui fluxo nominal válido no catálogo. Não é possível calcular a curva de depreciação.`);
        return;
    }

    const mediasFluxo = [100];
    const mediasEfic  = [eficNominalValido ? 100 : null];
    const linhasTabela = [];

    let ultimoPercentualFluxo = null;
    let ultimoPercentualEfic = null;
    let ultimoMarcoStr = "Sem dados";

    marcosAtuais.forEach(marco => {
        const dadosMarco = modelo.marcos[marco];
        if (dadosMarco && dadosMarco.qtd > 0) {
            const mFluxo = dadosMarco.somaFluxo / dadosMarco.qtd;
            // Usa o contador independente de eficácia; se não houver amostra válida, fica NaN
            const mEfic  = dadosMarco.qtdEfic > 0 ? (dadosMarco.somaEfic / dadosMarco.qtdEfic) : NaN;

            const percFluxo = safePerc(mFluxo, fluxoNominal);
            const percEfic  = eficNominalValido ? safePerc(mEfic, eficNominal) : null;
            const desvioAbsolutoLm = mFluxo - fluxoNominal;
            const ncFluxoPerc = percFluxo !== null ? (100 - percFluxo) : null;
            const ncEficPerc  = percEfic !== null ? (100 - percEfic) : null;

            mediasFluxo.push(percFluxo);
            mediasEfic.push(percEfic);
            ultimoPercentualFluxo = percFluxo;
            ultimoPercentualEfic = percEfic;
            ultimoMarcoStr = marco;

            linhasTabela.push({
                marco, qtd: dadosMarco.qtd, mFluxo, percFluxo, desvioAbsolutoLm, ncFluxoPerc,
                mEfic, percEfic, ncEficPerc, amostras: dadosMarco.amostras
            });
        } else {
            mediasFluxo.push(null);
            mediasEfic.push(null);
        }
    });

    setMetricCard("metFluxoNom", `${fluxoNominal.toLocaleString("pt-BR")} lm`, "Nominal catálogo", "");
    setMetricCard("metEficNom", eficNominalValido ? `${fmt(eficNominal)} lm/W` : "—", "Nominal catálogo", "");

    if (ultimoPercentualFluxo !== null) {
        setMetricCard("metFluxoUlt", fmtPerc(ultimoPercentualFluxo), `Ref: ${ultimoMarcoStr}`, ultimoPercentualFluxo >= 95 ? "positive" : ultimoPercentualFluxo >= 90 ? "warning" : "negative");
    } else {
        setMetricCard("metFluxoUlt", "—", "Sem dados", "");
    }

    if (ultimoPercentualEfic !== null) {
        setMetricCard("metEficUlt", fmtPerc(ultimoPercentualEfic), `Ref: ${ultimoMarcoStr}`, ultimoPercentualEfic >= 95 ? "positive" : ultimoPercentualEfic >= 90 ? "warning" : "negative");
    } else {
        setMetricCard("metEficUlt", "—", "Sem dados", "");
    }

    renderCharts(mediasFluxo, mediasEfic);

    const tableContainer = document.querySelector("#detailSection .results-table-wrapper");
    tableContainer.innerHTML = `
        <table class="results-table">
            <thead>
                <tr>
                    <th>Marco</th>
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
                <tr style="background: #F8FAFC;">
                    <td><strong>Nominal (Catálogo)</strong></td>
                    <td class="num">—</td>
                    <td class="num">${fluxoNominal.toLocaleString("pt-BR")}</td>
                    <td class="num" style="color: var(--text-muted)">0</td>
                    <td class="num">100,0%</td>
                    <td class="num" style="color: var(--text-muted)">0,0%</td>
                    <td class="num">${eficNominalValido ? fmt(eficNominal) : "—"}</td>
                    <td class="num" style="color: var(--text-muted)">${eficNominalValido ? "0,0%" : "—"}</td>
                    <td><span class="pill ok">Referência</span></td>
                </tr>
            </tbody>
        </table>
    `;

    const tbody = document.getElementById("detailTableBody");

    linhasTabela.forEach((r, idx) => {
        const hasAmostras = r.amostras && r.amostras.length > 1;
        const subRowId = `subrow-${idx}`;

        tbody.innerHTML += `
            <tr ${hasAmostras ? `class="expandable-row" onclick="toggleSubRow('${subRowId}')" title="Clique para ver luminárias individuais"` : ''}>
                <td>
                    ${hasAmostras ? '<i class="ti ti-chevron-right expand-icon"></i> ' : '<span style="display:inline-block; width:16px;"></span>'}
                    <strong>${r.marco}</strong>
                </td>
                <td class="num">${r.qtd} un.</td>
                <td class="num">${Number(r.mFluxo.toFixed(0)).toLocaleString("pt-BR")}</td>
                <td class="num" style="${corDesvio(r.desvioAbsolutoLm, false)}">${r.desvioAbsolutoLm > 0 ? '+' : ''}${Number(r.desvioAbsolutoLm.toFixed(0)).toLocaleString("pt-BR")}</td>
                <td class="num"><strong>${fmtPerc(r.percFluxo)}</strong></td>
                <td class="num" style="${corDesvio(r.ncFluxoPerc, true)}">${fmtPerc(r.ncFluxoPerc)}</td>
                <td class="num">${fmt(r.mEfic)}</td>
                <td class="num" style="${corDesvio(r.ncEficPerc, true)}">${fmtPerc(r.ncEficPerc)}</td>
                <td><span class="pill ${pillClass(r.percFluxo)}">${pillLabel(r.percFluxo)}</span></td>
            </tr>`;

        if (hasAmostras) {
            let subRowsHTML = r.amostras.map(a => {
                const aDesvioLm  = a.fluxo - fluxoNominal;
                const aPercFluxo = safePerc(a.fluxo, fluxoNominal);
                const aNcFluxo   = aPercFluxo !== null ? (100 - aPercFluxo) : null;
                const aPercEfic  = eficNominalValido ? safePerc(a.efic, eficNominal) : null;
                const aNcEfic    = aPercEfic !== null ? (100 - aPercEfic) : null;

                return `
                    <tr class="sub-item-row">
                        <td style="padding-left: 2rem; font-size: 0.8rem; color: var(--text-secondary); max-width: 250px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${a.id}"><i class="ti ti-file-analytics"></i> ${a.id}</td>
                        <td class="num" style="font-size: 0.8rem;">1 un.</td>
                        <td class="num" style="font-size: 0.8rem;">${Number(a.fluxo.toFixed(0)).toLocaleString("pt-BR")}</td>
                        <td class="num" style="font-size: 0.8rem; ${corDesvio(aDesvioLm, false)}">${aDesvioLm > 0 ? '+' : ''}${Number(aDesvioLm.toFixed(0)).toLocaleString("pt-BR")}</td>
                        <td class="num" style="font-size: 0.8rem;">${fmtPerc(aPercFluxo)}</td>
                        <td class="num" style="font-size: 0.8rem; ${corDesvio(aNcFluxo, true)}">${fmtPerc(aNcFluxo)}</td>
                        <td class="num" style="font-size: 0.8rem;">${fmt(a.efic)}</td>
                        <td class="num" style="font-size: 0.8rem; ${corDesvio(aNcEfic, true)}">${fmtPerc(aNcEfic)}</td>
                        <td><span class="pill ${pillClass(aPercFluxo)}" style="transform: scale(0.85); transform-origin: left;">${pillLabel(aPercFluxo)}</span></td>
                    </tr>
                `;
            }).join("");

            tbody.innerHTML += `
                <tr id="${subRowId}" style="display: none; background: #F8FAFC; border-top: none;">
                    <td colspan="9" style="padding: 0;">
                        <table class="results-table sub-table" style="width: 100%; border-top: 1px solid var(--border-strong); border-bottom: 2px solid var(--border-strong); box-shadow: inset 0 2px 4px rgba(0,0,0,0.02);">
                            <tbody>
                                ${subRowsHTML}
                            </tbody>
                        </table>
                    </td>
                </tr>
            `;
        }
    });

    document.getElementById("detailSection").style.display = "flex";
    document.getElementById("detailSection").scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ============================================
// RENDERIZAÇÃO DE GRÁFICOS
// ============================================
function renderCharts(mediasFluxo, mediasEfic) {
    const labels = ["Nominal", ...marcosAtuais];

    const baseOpts = {
        responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: {
            x: { ticks: { font: { size: 12 } }, grid: { color: "#F1F5F9" } },
            y: { min: 80, max: 105, ticks: { font: { size: 11 }, callback: v => v + "%" }, grid: { color: "#F1F5F9" } }
        }
    };
    const limitPlugin = {
        id: "limitLine",
        afterDraw(chart) {
            const { ctx, scales: { y, x } } = chart;
            const y90 = y.getPixelForValue(90);
            ctx.save();
            ctx.setLineDash([6, 4]); ctx.strokeStyle = CORES.limite; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(x.left, y90); ctx.lineTo(x.right, y90); ctx.stroke();
            ctx.setLineDash([]); ctx.fillStyle = CORES.limite; ctx.font = "10px Inter, sans-serif";
            ctx.fillText("limite 90%", x.right - 58, y90 - 4); ctx.restore();
        }
    };

    if (chartFluxo) chartFluxo.destroy();
    chartFluxo = new Chart(document.getElementById("chartFluxo").getContext("2d"), {
        type: "line", data: { labels, datasets: [{ label: "Fluxo medido (%)", data: mediasFluxo, borderColor: CORES.medido, backgroundColor: "rgba(15,110,86,0.07)", borderWidth: 2.5, pointRadius: 6, pointBackgroundColor: "#fff", fill: true, spanGaps: true }] },
        options: baseOpts, plugins: [limitPlugin]
    });

    if (chartEfic) chartEfic.destroy();
    chartEfic = new Chart(document.getElementById("chartEfic").getContext("2d"), {
        type: "line", data: { labels, datasets: [{ label: "Eficiência medida (%)", data: mediasEfic, borderColor: CORES.eficiencia, backgroundColor: "rgba(186,117,23,0.07)", borderWidth: 2.5, pointRadius: 6, pointBackgroundColor: "#fff", fill: true, spanGaps: true, borderDash: [6, 3] }] },
        options: baseOpts, plugins: [limitPlugin]
    });
}

// ============================================
// INIT
// ============================================
window.addEventListener("DOMContentLoaded", () => {
    document.getElementById("btnAnalisar").addEventListener("click", analisarContrato);
    carregarCatalogoMaster();
});
