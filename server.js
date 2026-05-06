const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Admin-Password'],
}));
app.options('*', cors());
app.use(express.json());

const SPREADSHEET_ID = '1yQxFcyCoJ8_sNU9ztFGfcyI57gqq5Dd1iJqPo8WShks';
const ADMIN_PASSWORD = '9894';
const VENDEDORES_FILE = path.join(__dirname, 'vendedores.json');
const SERVICE_ACCOUNT = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

const VENDEDORES_DEFAULT = [
  { nome: 'Camilli', codigo: 'V737', aba: 'Camilli Cerutti - V737' },
  { nome: 'Ana',     codigo: 'V888', aba: 'Ana Carolina - V888' },
  { nome: 'Solange', codigo: 'V865', aba: 'Solange Rodrigues - V865' },
  { nome: 'Laila',   codigo: 'V749', aba: 'Laila Cesário - V749' },
  { nome: 'Tiane',   codigo: 'V881', aba: 'Tiane Brito - V881' },
  { nome: 'Henrique',codigo: 'V823', aba: 'Henrique Brito - V823' },
];

function loadVendedores() {
  try {
    if (fs.existsSync(VENDEDORES_FILE)) {
      return JSON.parse(fs.readFileSync(VENDEDORES_FILE, 'utf8'));
    }
  } catch (e) { console.error('Erro ao carregar vendedores:', e.message); }
  return [...VENDEDORES_DEFAULT];
}

function saveVendedores(v) {
  try { fs.writeFileSync(VENDEDORES_FILE, JSON.stringify(v, null, 2)); }
  catch (e) { console.error('Erro ao salvar vendedores:', e.message); }
}

function checkAdmin(req, res) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    res.status(401).json({ erro: 'Senha incorreta' });
    return false;
  }
  return true;
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: SERVICE_ACCOUNT,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

async function encontrarLinhaData(sheets, aba, dataBR) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${aba}'!B:B` });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const cell = (rows[i][0] || '').toString().trim();
    if (cell === dataBR.trim()) return i + 1;
    const p = dataBR.split('/');
    if (p.length === 3 && cell === `${p[0]}/${p[1]}/${p[2].slice(-2)}`) return i + 1;
  }
  return null;
}

async function encontrarLinhaVenda(sheets, aba) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${aba}'!W:W` });
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i] || !rows[i][0] || !rows[i][0].toString().trim()) return i + 1;
  }
  return rows.length + 1;
}

// Vendedores
app.get('/vendedores', (req, res) => res.json(loadVendedores()));

app.post('/vendedores', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { nome, codigo, aba } = req.body;
  if (!nome || !codigo || !aba) return res.status(400).json({ erro: 'Nome, código e aba são obrigatórios' });
  const vendedores = loadVendedores();
  if (vendedores.find(v => v.codigo === codigo)) return res.status(400).json({ erro: `Código ${codigo} já existe` });
  vendedores.push({ nome, codigo, aba });
  saveVendedores(vendedores);
  res.json({ ok: true, vendedores });
});

app.delete('/vendedores/:codigo', (req, res) => {
  if (!checkAdmin(req, res)) return;
  let vendedores = loadVendedores();
  const antes = vendedores.length;
  vendedores = vendedores.filter(v => v.codigo !== req.params.codigo);
  if (vendedores.length === antes) return res.status(404).json({ erro: 'Vendedor não encontrado' });
  saveVendedores(vendedores);
  res.json({ ok: true, vendedores });
});

app.post('/admin/verificar', (req, res) => {
  res.json({ ok: req.headers['x-admin-password'] === ADMIN_PASSWORD });
});

// ─── TAXAS POR PERÍODO ───────────────────────────────────────
// Estrutura da planilha:
// Semana 1: cabeçalho linha 4, dados linhas 5-11
// Semana 2: cabeçalho linha 15, dados linhas 16-22
// Cada bloco = 11 linhas. Primeira data = 31/12/2025
const PRIMEIRA_DATA = new Date(2025, 11, 31); // 31/12/2025
const LINHAS_POR_BLOCO = 11;
const PRIMEIRA_LINHA_DADOS = 5;

function datePorLinha(linha) {
  // Calcula qual data corresponde a uma linha de dados
  const diaIndex = linha - PRIMEIRA_LINHA_DADOS;
  if (diaIndex < 0) return null;
  const semana = Math.floor(diaIndex / LINHAS_POR_BLOCO);
  const diaNaSemana = diaIndex % LINHAS_POR_BLOCO;
  if (diaNaSemana > 6) return null; // linha de total ou cabeçalho
  const d = new Date(PRIMEIRA_DATA);
  d.setDate(d.getDate() + semana * 7 + diaNaSemana);
  return d;
}

function parseTempo(val) {
  // Converte "HH:MM:SS" ou "H:MM:SS" para segundos
  if (!val || val === '0:00' || val === '0:00:00') return 0;
  const parts = val.toString().split(':');
  if (parts.length === 3) return parseInt(parts[0])*3600 + parseInt(parts[1])*60 + parseInt(parts[2]);
  if (parts.length === 2) return parseInt(parts[0])*3600 + parseInt(parts[1])*60;
  return 0;
}

// Função auxiliar: calcula totais de uma aba entre duas datas
async function calcularTotaisAba(sheets, aba, dataInicio, dataFim) {
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${aba}'!C:F`,
  });
  const rows = result.data.values || [];
  let totalSegundos = 0, totalAtenderam = 0, totalEntrevistas = 0, totalHeadcounts = 0, diasComDados = 0;
  rows.forEach((row, i) => {
    const data = datePorLinha(i + 1);
    if (!data) return;
    data.setHours(0,0,0,0);
    if (data < dataInicio || data > dataFim) return;
    const horas = parseTempo(row[0]);
    const atend = parseInt(row[1]) || 0;
    const entrv = parseInt(row[2]) || 0;
    const head  = parseInt(row[3]) || 0;
    if (horas > 0 || atend > 0 || entrv > 0 || head > 0) {
      totalSegundos += horas; totalAtenderam += atend;
      totalEntrevistas += entrv; totalHeadcounts += head;
      diasComDados++;
    }
  });
  return { totalSegundos, totalAtenderam, totalEntrevistas, totalHeadcounts, diasComDados };
}

function formatarResultado(totais) {
  const { totalSegundos, totalAtenderam, totalEntrevistas, totalHeadcounts, diasComDados } = totais;
  const th = Math.floor(totalSegundos / 3600);
  const tm = Math.floor((totalSegundos % 3600) / 60);
  const txAtend = totalAtenderam > 0 ? Math.round(totalEntrevistas / totalAtenderam * 100) : 0;
  const txHead  = totalEntrevistas > 0 ? Math.round(totalHeadcounts / totalEntrevistas * 100) : 0;
  let pace = '—';
  if (totalHeadcounts > 0 && totalSegundos > 0) {
    const spv = Math.round(totalSegundos / totalHeadcounts);
    const ph = Math.floor(spv / 3600), pm = Math.floor((spv % 3600) / 60);
    pace = ph > 0 ? `${ph}h${String(pm).padStart(2,'0')}min` : `${pm}min`;
  }
  return {
    diasComDados,
    totalHoras: `${th}h ${String(tm).padStart(2,'0')}min`,
    totalAtenderam, totalEntrevistas, totalHeadcounts,
    txAtend: `${txAtend}%`, txHead: `${txHead}%`, pace,
  };
}

// ─── TAXAS POR PERÍODO PERSONALIZADO ─────────────────────────
app.get('/taxas-periodo', async (req, res) => {
  try {
    const { aba, inicio, fim } = req.query;
    if (!aba || !inicio || !fim) return res.status(400).json({ erro: 'Aba, inicio e fim são obrigatórios' });

    // Datas no formato DD/MM/YYYY
    const [di, mi, ai] = inicio.split('/');
    const [df, mf, af] = fim.split('/');
    const dataInicio = new Date(parseInt(ai), parseInt(mi)-1, parseInt(di));
    const dataFim    = new Date(parseInt(af), parseInt(mf)-1, parseInt(df));
    dataInicio.setHours(0,0,0,0); dataFim.setHours(0,0,0,0);

    if (isNaN(dataInicio) || isNaN(dataFim)) return res.status(400).json({ erro: 'Datas inválidas. Use DD/MM/YYYY' });
    if (dataInicio > dataFim) return res.status(400).json({ erro: 'Data início não pode ser maior que data fim' });

    const sheets = await getSheetsClient();
    const totais = await calcularTotaisAba(sheets, aba, dataInicio, dataFim);
    res.json(formatarResultado(totais));
  } catch (e) {
    console.error('Erro /taxas-periodo:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ─── STATUS DO TIME (ADMIN) ───────────────────────────────────
app.get('/status-time', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const { data } = req.query;
    if (!data) return res.status(400).json({ erro: 'Data é obrigatória (DD/MM/YYYY)' });

    const [d, m, a] = data.split('/');
    const dataConsulta = new Date(parseInt(a), parseInt(m)-1, parseInt(d));
    dataConsulta.setHours(0,0,0,0);
    if (isNaN(dataConsulta)) return res.status(400).json({ erro: 'Data inválida' });

    const vendedores = loadVendedores();
    const sheets = await getSheetsClient();

    const resultados = await Promise.all(vendedores.map(async (v) => {
      try {
        const result = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `'${v.aba}'!B:F`,
        });
        const rows = result.data.values || [];
        let encontrou = false, horas = '—', atend = '—', entrv = '—', head = '—';
        rows.forEach((row, i) => {
          const dt = datePorLinha(i + 1);
          if (!dt) return;
          dt.setHours(0,0,0,0);
          if (dt.getTime() !== dataConsulta.getTime()) return;
          encontrou = true;
          horas = row[1] || '0h';
          atend = row[2] || '0';
          entrv = row[3] || '0';
          head  = row[4] || '0';
        });
        const preencheu = encontrou && (horas !== '0h' || atend !== '0' || entrv !== '0');
        return { nome: v.nome, codigo: v.codigo, preencheu, horas, atend, entrv, head };
      } catch(e) {
        return { nome: v.nome, codigo: v.codigo, preencheu: false, erro: e.message };
      }
    }));

    res.json({ data, resultados });
  } catch (e) {
    console.error('Erro /status-time:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ─── VENDAS DO TIME (ADMIN) ───────────────────────────────────
app.get('/vendas-time', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const { data } = req.query;
    if (!data) return res.status(400).json({ erro: 'Data é obrigatória (DD/MM/YYYY)' });

    const vendedores = loadVendedores();
    const sheets = await getSheetsClient();

    const resultados = await Promise.all(vendedores.map(async (v) => {
      try {
        // Tabela de vendas: colunas W até AE
        // W=Data, X=Cliente, Y=Email, Z=Link, AA=Evento, AB=Categoria, AC=Headcounts, AD=Status, AE=OBS
        const result = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `'${v.aba}'!W:AE`,
        });
        const rows = result.data.values || [];
        const vendas = [];
        rows.forEach((row, i) => {
          if (i === 0) return; // pula cabeçalho
          const dataVenda = (row[0] || '').toString().trim();
          if (!dataVenda || dataVenda === data) {
            // Inclui linhas sem data (caso raro) ou que batem com a data
            if (!dataVenda && !row[1]) return; // linha vazia
            if (dataVenda !== data) return;
            vendas.push({
              data:      row[0] || '',
              cliente:   row[1] || '',
              email:     row[2] || '',
              link:      row[3] || '',
              evento:    row[4] || '',
              categoria: row[5] || '',
              headcounts:row[6] || '',
              status:    row[7] || '',
              obs:       row[8] || '',
            });
          }
        });
        return { nome: v.nome, codigo: v.codigo, totalVendas: vendas.length, vendas };
      } catch(e) {
        return { nome: v.nome, codigo: v.codigo, totalVendas: 0, vendas: [], erro: e.message };
      }
    }));

    const totalGeral = resultados.reduce((acc, v) => acc + v.totalVendas, 0);
    res.json({ data, totalGeral, resultados });
  } catch (e) {
    console.error('Erro /vendas-time:', e.message);
    res.status(500).json({ erro: e.message });
  }
});


// Métricas
app.post('/salvar-metricas', async (req, res) => {
  try {
    const { aba, data, horasFaladas, atenderam, entrevistaCompleta, headcounts, crossSell, comentarios } = req.body;
    if (!aba || !data) return res.status(400).json({ erro: 'Aba e data são obrigatórios' });
    const sheets = await getSheetsClient();
    const linha = await encontrarLinhaData(sheets, aba, data);
    if (!linha) return res.status(404).json({ erro: `Data ${data} não encontrada na aba ${aba}` });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${aba}'!C${linha}:H${linha}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[horasFaladas, atenderam, entrevistaCompleta, headcounts, crossSell, comentarios]] },
    });
    res.json({ ok: true, linha });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Vendas
app.post('/salvar-venda', async (req, res) => {
  try {
    const { aba, data, cliente, email, linkClint, evento, categoria, headcounts, obs } = req.body;
    if (!aba || !data) return res.status(400).json({ erro: 'Aba e data são obrigatórios' });
    const sheets = await getSheetsClient();
    const linha = await encontrarLinhaVenda(sheets, aba);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${aba}'!W${linha}:AE${linha}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[data, cliente, email, linkClint, evento, categoria, headcounts, '', obs]] },
    });
    res.json({ ok: true, linha });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/', (req, res) => res.json({ status: 'ok', servico: 'Registro Diário API' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
