"""
Exporta uma coleção do Firestore (com todas as subcoleções) para um arquivo .json

Requisitos:
    pip install firebase-admin
"""

import json
import base64
from datetime import datetime, date

import firebase_admin
from firebase_admin import credentials, firestore
from google.cloud.firestore_v1 import DocumentReference, GeoPoint

# ----------------- CONFIGURAÇÃO -----------------
SERVICE_ACCOUNT = "pnz-udi-cwb-firebase-adminsdk-fbsvc-afe81863c4.json"   # seu JSON de credenciais
COLECAO_RAIZ = "modelos_base"
ARQUIVO_SAIDA = "modelos_base_export.json"
# ------------------------------------------------


def init_firestore():
    if not firebase_admin._apps:
        cred = credentials.Certificate(SERVICE_ACCOUNT)
        firebase_admin.initialize_app(cred)
    return firestore.client()


def normalizar(valor):
    """Converte tipos do Firestore para algo serializável em JSON."""
    if isinstance(valor, (datetime, date)):
        return valor.isoformat()
    if isinstance(valor, DocumentReference):
        return {"_type": "reference", "path": valor.path}
    if isinstance(valor, GeoPoint):
        return {"_type": "geopoint", "lat": valor.latitude, "lng": valor.longitude}
    if isinstance(valor, bytes):
        return {"_type": "bytes", "base64": base64.b64encode(valor).decode()}
    if isinstance(valor, dict):
        return {k: normalizar(v) for k, v in valor.items()}
    if isinstance(valor, (list, tuple)):
        return [normalizar(v) for v in valor]
    return valor


def exportar_documento(doc_ref):
    """Retorna dict com campos + subcoleções de um documento."""
    snap = doc_ref.get()

    item = {
        "_id": doc_ref.id,
        "_path": doc_ref.path,
        "_exists": snap.exists,
        "fields": normalizar(snap.to_dict() or {}),
    }

    subcolecoes = {}
    for sub in doc_ref.collections():
        subcolecoes[sub.id] = exportar_colecao(sub)

    if subcolecoes:
        item["subcollections"] = subcolecoes

    return item


def exportar_colecao(col_ref):
    """Retorna lista de documentos da coleção (inclui documentos 'fantasma')."""
    docs = []
    for doc_ref in col_ref.list_documents():
        print(f"  -> {doc_ref.path}")
        docs.append(exportar_documento(doc_ref))
    return docs


def main():
    db = init_firestore()
    print(f"Exportando coleção '{COLECAO_RAIZ}'...")

    dados = {
        "exported_at": datetime.utcnow().isoformat() + "Z",
        "collection": COLECAO_RAIZ,
        "documents": exportar_colecao(db.collection(COLECAO_RAIZ)),
    }

    with open(ARQUIVO_SAIDA, "w", encoding="utf-8") as f:
        json.dump(dados, f, ensure_ascii=False, indent=2)

    total = len(dados["documents"])
    print(f"\nConcluído: {total} documentos na raiz. Arquivo: {ARQUIVO_SAIDA}")


if __name__ == "__main__":
    main()
