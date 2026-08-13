"""
auditoria_completa.py
Cruza Catálogo de Modelos x Laudos de Laboratório (UDI, PNZ, CWB) no Firestore.

Saídas:
  1_laudos_cruzados.csv        -> laudos vinculados (com modelo/potência/score usados)
  2_laudos_orfaos.csv          -> laudos sem modelo no catálogo (+ motivo da rejeição)
  3_modelos_sem_relatorio.csv  -> modelos do catálogo que NÃO possuem nenhum laudo
"""

import re
import unicodedata
from collections import defaultdict

import firebase_admin
import pandas as pd
from firebase_admin import credentials, firestore

CREDENTIALS_FILE = "pnz-udi-cwb-firebase-adminsdk-fbsvc-afe81863c4.json"

# IDs de coleção que contêm ensaios (collection_group ignora o caminho intermediário)
COLECOES_ENSAIOS = ["itens", "ensaios"]
CONTRATOS_VALIDOS = {"UDI", "PNZ", "CWB"}


# ------------------------------------------------------------------ infra
def init_db():
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(CREDENTIALS_FILE))
    return firestore.client()


# ------------------------------------------------------------- utilitários
def norm(s):
    if s is None:
        return ""
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode()
    return re.sub(r"[\s\-_./]+", "", s.upper())


def clean_num(val):
    if val is None or val == "":
        return None
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).strip().replace("W", "").replace("w", "")
    if "," in s and "." in s:
        s = s.replace(".", "")
    s = s.replace(",", ".")
    try:
        return float(re.sub(r"[^\d.\-]", "", s))
    except ValueError:
        return None


def potencia_de_texto(txt):
    if not txt:
        return None
    m = re.search(r"(\d{2,3}[,.]?\d*)\s*W\b", str(txt), re.IGNORECASE)
    return float(m.group(1).replace(",", ".")) if m else None


def contrato_do_path(path):
    partes = path.split("/")
    for p in partes:
        if p.upper() in CONTRATOS_VALIDOS:
            return p.upper()
    return "DESCONHECIDO"


# --------------------------------------------------------------- extração
def extrair(doc_dict, doc_id, contrato, path):
    d = doc_dict

    def gv(obj, prop=None):
        if prop is None:
            return d.get(obj)
        if isinstance(d.get(obj), dict) and prop in d[obj]:
            return d[obj][prop]
        return d.get(f"{obj}.{prop}")

    if contrato == "CWB":
        fab = gv("FABRICANTE") or gv("Fabricante")
        mod = gv("MODELO") or gv("Modelo") or doc_id
        pot = clean_num(gv("POTENCIA DECLARADO (W)") or gv("POTENCIA (W)"))
        pot_origem = "declarada"
    else:
        arquivo = gv("metadata", "arquivo") or doc_id
        fab = gv("metadata", "fabricante")
        if not fab and "-" in str(arquivo):
            partes = [p.strip() for p in str(arquivo).split("-")]
            fab = next((p for p in partes if p and not p.isdigit()
                        and p.upper() != "ENGIE"), None)
        mod = gv("metadata", "modelo") or arquivo

        pot = clean_num(gv("dados_tecnicos", "potenciaDeclarada")
                        or gv("metadata", "potencia"))
        pot_origem = "declarada"
        if pot is None:
            pot = potencia_de_texto(mod) or potencia_de_texto(arquivo)
            pot_origem = "regex_nome"
        if pot is None:
            pot = clean_num(gv("dados_tecnicos", "potenciaTotalCircuito"))
            pot_origem = "circuito_medido"

    return {
        "path": path,
        "id": doc_id,
        "contrato": contrato,
        "fabricante": fab,
        "modelo": str(mod) if mod else "",
        "potencia": pot,
        "pot_origem": pot_origem,
    }


# --------------------------------------------------------------- matching
def match(lab, catalogo):
    """Retorna (melhor_modelo | None, score, motivo)."""
    if not lab["modelo"]:
        return None, 0, "sem_modelo"

    lm = norm(lab["modelo"])
    lp = lab["potencia"]
    tol_pct = 0.15 if lab["pot_origem"] == "circuito_medido" else 0.05

    melhor, melhor_score, houve_nome = None, 0, False

    for cat in catalogo:
        cm, cf, cp = cat["_mod_n"], cat["_fam_n"], cat["potencia"]

        pts = 0
        if cm and cm == lm:
            pts += 200
        elif cm and (cm in lm or lm in cm):
            pts += 100
        if cf and cf in lm:
            pts += 60
        if pts == 0:
            continue

        houve_nome = True

        if cp is not None and lp is not None:
            diff = abs(cp - lp)
            if diff <= 3 or (diff / cp) <= tol_pct:
                pts += 1000 if cf and cf in lm else 500
            else:
                continue  # nome bate, potência não -> não é este modelo
        elif cp is None:
            pts += 10

        if pts > melhor_score:
            melhor, melhor_score = cat, pts

    if melhor:
        return melhor, melhor_score, "ok"
    return None, 0, ("potencia_fora_tolerancia" if houve_nome else "nome_nao_encontrado")


# ------------------------------------------------------------------- main
def main():
    db = init_db()

    print("Baixando catálogo...")
    catalogo = []
    for doc in db.collection_group("modelos").stream():
        d = doc.to_dict() or {}
        item = {
            "cat_path": doc.reference.path,
            "cat_id": doc.id,
            "modelo": d.get("modelo") or doc.id,
            "familia": d.get("familia", ""),
            "fabricante": d.get("fabricante", ""),
            "potencia": clean_num(d.get("potencia_W") or d.get("potencia")
                                  or d.get("potenciaNominal")),
        }
        item["_mod_n"] = norm(item["modelo"])
        item["_fam_n"] = norm(item["familia"])
        catalogo.append(item)
    print(f"  {len(catalogo)} modelos no catálogo.\n")

    print("Varrendo TODOS os ensaios via collection_group...")
    cruzados, orfaos = [], []
    vistos = set()
    cat_com_laudo = defaultdict(int)
    por_contrato = defaultdict(lambda: {"lidos": 0, "match": 0})

    for cid in COLECOES_ENSAIOS:
        for doc in db.collection_group(cid).stream():
            path = doc.reference.path
            if path in vistos:
                continue
            vistos.add(path)

            d = doc.to_dict()
            if not d:
                continue

            contrato = contrato_do_path(path)
            lab = extrair(d, doc.id, contrato, path)
            por_contrato[contrato]["lidos"] += 1

            cat, score, motivo = match(lab, catalogo)

            if cat:
                por_contrato[contrato]["match"] += 1
                cat_com_laudo[cat["cat_path"]] += 1
                cruzados.append({
                    "Contrato": contrato,
                    "ID Laudo": lab["id"],
                    "Path Laudo": path,
                    "Fabricante (laudo)": lab["fabricante"],
                    "Modelo (laudo)": lab["modelo"],
                    "Potência (laudo)": lab["potencia"],
                    "Origem Potência": lab["pot_origem"],
                    "Modelo Catálogo": cat["modelo"],
                    "Família Catálogo": cat["familia"],
                    "Potência Catálogo": cat["potencia"],
                    "Path Catálogo": cat["cat_path"],
                    "Score": score,
                })
            else:
                orfaos.append({
                    "Contrato": contrato,
                    "ID Laudo": lab["id"],
                    "Path Laudo": path,
                    "Fabricante (laudo)": lab["fabricante"],
                    "Modelo (laudo)": lab["modelo"],
                    "Potência (laudo)": lab["potencia"],
                    "Origem Potência": lab["pot_origem"],
                    "Motivo": motivo,
                })

    sem_relatorio = [
        {
            "Modelo": c["modelo"],
            "Família": c["familia"],
            "Fabricante": c["fabricante"],
            "Potência (W)": c["potencia"],
            "Path Catálogo": c["cat_path"],
        }
        for c in catalogo if cat_com_laudo[c["cat_path"]] == 0
    ]

    # ------------------------------------------------------------ resumo
    total = len(cruzados) + len(orfaos)
    print("\n" + "=" * 62)
    print("RESULTADO DA AUDITORIA")
    print("=" * 62)
    print(f"Laudos analisados .......... {total}")
    print(f"Com match no catálogo ..... {len(cruzados)}"
          f" ({(len(cruzados)/total*100 if total else 0):.1f}%)")
    print(f"Órfãos .................... {len(orfaos)}")
    print(f"Modelos sem relatório ..... {len(sem_relatorio)} de {len(catalogo)}")
    print("-" * 62)
    for c, v in sorted(por_contrato.items()):
        pct = v["match"] / v["lidos"] * 100 if v["lidos"] else 0
        print(f"{c:<14} lidos={v['lidos']:<6} match={v['match']:<6} ({pct:.1f}%)")
    print("=" * 62)

    if orfaos:
        print("\nÓrfãos por motivo:")
        for m, q in pd.Series([o["Motivo"] for o in orfaos]).value_counts().items():
            print(f"  {m:<28} {q}")

    for nome, dados in [
        ("1_laudos_cruzados.csv", cruzados),
        ("2_laudos_orfaos.csv", orfaos),
        ("3_modelos_sem_relatorio.csv", sem_relatorio),
    ]:
        pd.DataFrame(dados).to_csv(nome, index=False, sep=";",
                                   encoding="utf-8-sig")
        print(f"Gerado: {nome} ({len(dados)} linhas)")


if __name__ == "__main__":
    main()
