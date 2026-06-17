# Dashboard IP - Curva de Depreciação Automática (DB-Petr-Uber-CUR)

## 📖 Sobre o Projeto
O **DB-Petr-Uber-CUR** é um dashboard web interativo desenvolvido para a descoberta, análise e validação automática de ensaios laboratoriais de Iluminação Pública (IP). O sistema tem como objetivo principal monitorar a curva de depreciação do fluxo luminoso e da eficácia (eficiência) de luminárias aplicadas em contratos específicos (Uberlândia - UDI, Petrolina - PNZ e Curitiba - CWB).

O painel conecta-se diretamente a um banco de dados **Firebase Firestore**, varre os dados laboratoriais e realiza um cruzamento inteligente (fuzzy match) com um catálogo base de modelos de luminárias. Com isso, gera relatórios automáticos de conformidade, trilhas de auditoria e gráficos dinâmicos de depreciação ao longo do tempo.

## ✨ Funcionalidades Principais
- **Sincronização em Tempo Real:** Leitura de catálogos e amostras diretamente do Firestore.
- **Algoritmo de Cruzamento Inteligente:** Associação automática de modelos testados em laboratório com o catálogo mestre, baseando-se no nome do fabricante, string do modelo e potência (com tolerâncias de ±5W).
- **Cálculo de Depreciação (Auditoria):** Comparação entre os dados nominais declarados no catálogo e os dados reais medidos (fluxo luminoso em `lm` e eficácia em `lm/W`).
- **Classificação Visual de Status:** Identificação imediata do estado das luminárias através de cores e tags:
  - 🟢 **Regular** (≥ 95%)
  - 🟡 **Atenção** (≥ 90% e < 95%)
  - 🔴 **Crítico** (< 90%)
- **Visão Mestre-Detalhe (Drill-down):**
  - Tabela principal sumarizando os modelos de famílias de luminárias.
  - Tabela de detalhamento com expansão de linhas para visualizar cada amostra/relatório individualmente (com realce de desvios negativos e não-conformidades).
- **Gráficos Dinâmicos:** Geração de curvas de depreciação utilizando **Chart.js**, exibindo a linha de tendência medida frente ao limite de referência normativo (90%).

## 🛠️ Tecnologias Utilizadas
- **Frontend:** HTML5, CSS3 (Variáveis CSS, Flexbox/Grid, Design Responsivo, UI/UX baseada em cards).
- **Linguagem Principal:** JavaScript (Vanilla JS, ES6+, Assíncrono).
- **Banco de Dados (BaaS):** [Firebase Firestore](https://firebase.google.com/) (SDK 8.10.1).
- **Visualização de Dados:** [Chart.js](https://www.chartjs.org/) (Gráficos em canvas).
- **Iconografia:** [Tabler Icons](https://tabler-icons.com/).
- **Tipografia:** [Google Fonts - Inter](https://fonts.google.com/specimen/Inter).

## 📂 Estrutura de Arquivos

```text
.
├── index.html       # Interface principal e estrutura semântica do dashboard.
├── app.js           # Lógica principal, queries ao Firestore, cálculos e gráficos.
├── style.css        # Estilos globais, paleta de cores, layout e animações.
├── config.js        # (Não versionado) Arquivo com credenciais de inicialização do Firebase.
├── .gitignore       # Regras de arquivos ignorados no repositório (ex: chaves json, config.js).
└── README.md        # Esta documentação do projeto.

```
## 🚀 Como Executar o Projeto Localmente

### 1. Pré-requisitos
- Um navegador web moderno (Chrome, Edge, Firefox, Safari).
- Um projeto configurado no **Firebase** com o **Firestore Database** ativo e dados populados na estrutura esperada pelo sistema.

### 2. Configuração de Credenciais
O ficheiro que contém as chaves do Firebase está protegido pelo `.gitignore` (`config.js`). Para rodar o projeto, crie um ficheiro chamado `config.js` na raiz do projeto e adicione a configuração do seu banco de dados:

```javascript
// config.js
const firebaseConfig = {
    apiKey: "SUA_API_KEY",
    authDomain: "SEU_AUTH_DOMAIN",
    projectId: "SEU_PROJECT_ID",
    storageBucket: "SEU_STORAGE_BUCKET",
    messagingSenderId: "SEU_MESSAGING_SENDER_ID",
    appId: "SEU_APP_ID"
};

```
### 3. Execução
Como o dashboard é construído estritamente com HTML/CSS/JS (Vanilla), não é necessário um processo de build longo (como Node.js/NPM).

- **Recomendado:** Utilize um servidor estático local (como a extensão **Live Server** no VS Code) para abrir o `index.html`. Isso evita possíveis bloqueios de política de mesma origem (CORS) durante as requisições.

## 📊 Estrutura de Dados Esperada (Firestore)
Para que o `app.js` funcione corretamente, o banco de dados deve possuir:

1. **Catálogo Mestre:** Acessível via `collectionGroup("modelos")`, onde os documentos estão aninhados sob "famílias" e contêm os campos `fluxo_luminoso_lm`, `eficiencia_lm_w`, `potencia_W`, etc.
2. **Dados dos Contratos:** Coleção `contratos` com documentos nomeados de acordo com a seleção (`UDI`, `PNZ`, `CWB`), contendo subcoleções de avaliações separadas por "Marcos" ou "Ano/Mês", conforme mapeado na constante `CONFIG_CONTRATOS`.

