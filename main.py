import os
import re
import pdfplumber
import firebase_admin
from firebase_admin import credentials
from firebase_admin import firestore

# ==========================================
# 1. CONFIGURAÇÃO DO FIREBASE
# ==========================================
# Substitua pelo caminho real da sua chave JSON do Firebase
caminho_credencial = "caminho/para/sua-chave-firebase.json"
cred = credentials.Certificate(caminho_credencial)
firebase_admin.initialize_app(cred)

db = firestore.client()

# ==========================================
# 2. FUNÇÃO DE EXTRAÇÃO (PDF -> DICIONÁRIO)
# ==========================================
def extrair_dados_pdf(caminho_pdf):
    dados = {}
    
    with pdfplumber.open(caminho_pdf) as pdf:
        texto_completo = ""
        # Lê todas as páginas do PDF e junta em uma única string
        for pagina in pdf.pages:
            texto_completo += pagina.extract_text() + "\n"

        # Padrões Regex para capturar os valores numéricos após os rótulos.
        # O (.*?) lida com o espaço e as unidades (V, W, A, etc) que ficam entre o nome e o valor.
        # O grupo (\d+[\.,]?\d*) captura o número, incluindo milhares e decimais.
        padroes = {
            "tensaoAlimentacao": r"Tensão de alimentação.*?(\d+,\d+)",
            "potenciaTotalCircuito": r"Potência total do circuito.*?(\d+,\d+)",
            "correnteAlimentacao": r"Corrente de alimentação.*?(\d+,\d+)",
            "fatorPotencia": r"Fator de Potência.*?(\d+,\d+)",
            "eficienciaLuminosaTotal": r"Eficiência luminosa total.*?(\d+,\d+)",
            "temperaturaCorCorrelatada": r"Temperatura de Cor Correlatada.*?(\d+\.\d+|\d+)", 
            "indiceReproducaoCor": r"Índice de Reprodução de Cor.*?(\d+,\d+)",
            "distorcaoHarmonicasTotal": r"Distorção de Harmônicas total.*?(\d+,\d+)",
            "correnteEntradaLuminarias": r"Corrente de entrada das luminárias.*?(\d+,\d+)",
            "tensaoEntradaLuminarias": r"Tensão de entrada das luminárias.*?(\d+,\d+)",
            "fluxoLuminosoLuminaria": r"Fluxo luminoso da luminária.*?(\d+\.\d+,\d+|\d+,\d+)",
            "temperaturaMaximaJuncao": r"Temperatura máxima de junção.*?(\d+,\d+)"
        }

        # Busca cada padrão no texto extraído
        for chave, regex in padroes.items():
            match = re.search(regex, texto_completo, re.IGNORECASE)
            if match:
                # Pega o valor capturado (ex: "219,94" ou "4.768,7")
                valor_bruto = match.group(1)
                
                # Tratamento numérico: remove ponto de milhar e troca vírgula decimal por ponto
                valor_limpo = valor_bruto.replace(".", "").replace(",", ".")
                
                try:
                    dados[chave] = float(valor_limpo)
                except ValueError:
                    dados[chave] = None
            else:
                dados[chave] = None # Campo não encontrado no texto

    return dados

# ==========================================
# 3. FUNÇÃO DE PROCESSAMENTO EM MASSA
# ==========================================
def processar_pasta_pdfs(pasta_origem):
    # Lista todos os arquivos na pasta
    arquivos = os.listdir(pasta_origem)
    
    for nome_arquivo in arquivos:
        if nome_arquivo.lower().endswith(".pdf"):
            caminho_completo = os.path.join(pasta_origem, nome_arquivo)
            print(f"\nExtraindo dados de: {nome_arquivo}...")

            # 1. Extrai os dados
            dados_extraidos = extrair_dados_pdf(caminho_completo)

            # 2. Prepara o ID do documento (Nome do arquivo sem a extensão .pdf)
            # Ex: "DLUM0242-1102219747-230 - PHILIPS..."
            doc_id = os.path.splitext(nome_arquivo)[0]

            # 3. Monta a estrutura para o Firebase
            payload = {
                "sumarioEnsaios": dados_extraidos
            }

            # 4. Envia para o Firestore
            try:
                db.collection("relatorios_luminarias").document(doc_id).set(payload, merge=True)
                print(f"  -> Sucesso! Dados salvos no Firestore com o ID: {doc_id}")
            except Exception as e:
                print(f"  -> ERRO ao salvar no Firebase: {e}")

# ==========================================
# 4. EXECUÇÃO
# ==========================================
if __name__ == "__main__":
    # Coloque o caminho da pasta onde estão todos os seus PDFs
    pasta_dos_pdfs = "./pdfs_para_extrair" 
    
    print("Iniciando processamento em massa...")
    processar_pasta_pdfs(pasta_dos_pdfs)
    print("\nProcessamento finalizado!")