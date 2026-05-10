// ============================================================
// REGISTRO DIÁRIO API v2
// Multi-time · Grupos · Imersões · GitHub Persistence
// Repo: CamilliCerutti/registro-diario-api
// ============================================================
const express = require('express');
const cors    = require('cors');
const https   = require('https');
const { google } = require('googleapis');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Admin-Password'],
}));
app.options('*', cors());
app.use(express.json());

// ============================================================
// ENV
// ============================================================
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD  || '9894';
const GITHUB_TOKEN    = process.env.GITHUB_TOKEN    || '';
const GITHUB_REPO     = process.env.GITHUB_REPO     || 'CamilliCerutti/registro-diario-api';
const SERVICE_ACCOUNT = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');

// Exibido no popup de instrução ao criar novo time
const SERVICE_ACCOUNT_EMAIL = 'registro-diario@registro-diario-495519.iam.gserviceaccount.com';

// ============================================================
// ESTADO (carregado do GitHub na inicialização)
// supervisors.json → lista de times, vendedores e grupos
// config.json      → imersões globais
// ============================================================
let SUPERVISORS   = [];
let GLOBAL_CONFIG = { immersions: [], updatedAt: null };

// ============================================================
// GITHUB PERSISTENCE
// Toda mutação salva no GitHub → sobrevive ao sono do Render
// ============================================================
function githubRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req  = https.request(
      {
        hostname: 'api.github.com',
        path,
        method,
        headers: {
          Authorization:  `token ${GITHUB_TOKEN}`,
          Accept:         'application/vnd.github.v3+json',
          'User-Agent':   'registro-diario-api',
          ...(data && {
            'Content-Type':   'application/json',
            'Content-Length': Buffer.byteLength(data),
          }),
        },
      },
      res => {
        let raw = '';
        res.on('data', d => (raw += d));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, body: raw }); }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function ghGet(filename) {
  if (!GITHUB_TOKEN) return null;
  try {
    const r = await githubRequest('GET', `/repos/${GITHUB_REPO}/contents/${filename}`);
    if (r.status === 200 && r.body.content) {
      return {
        data: JSON.parse(Buffer.from(r.body.content, 'base64').toString('utf8')),
        sha:  r.body.sha,
      };
    }
  } catch (e) { console.warn(`ghGet ${filename}:`, e.message); }
  return null;
}

async function ghSave(filename, data) {
  if (!GITHUB_TOKEN) { console.warn('⚠️  GITHUB_TOKEN não configurado'); return false; }
  try {
    const ex      = await ghGet(filename);
    const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    const r = await githubRequest('PUT', `/repos/${GITHUB_REPO}/contents/${filename}`, {
      message: `update: ${filename} ${new Date().toISOString().slice(0, 16)}`,
      content,
      ...(ex && { sha: ex.sha }),
    });
    return r.status === 200 || r.status === 201;
  } catch (e) { console.warn(`ghSave ${filename}:`, e.message); return false; }
}

async function loadFromGitHub() {
  const s = await ghGet('supervisors.json');
  if (s && Array.isArray(s.data) && s.data.length > 0) {
    SUPERVISORS = s.data;
    console.log(`✅ Supervisors carregados: ${SUPERVISORS.length}`);
  } else {
    console.warn('⚠️  supervisors.json não encontrado ou vazio no GitHub');
  }
  const c = await ghGet('config.json');
  if (c && c.data) {
    GLOBAL_CONFIG = c.data;
    console.log('✅ Config carregado');
  }
}

// ============================================================
// GOOGLE SHEETS CLIENT
// ============================================================
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: SERVICE_ACCOUNT,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

// ============================================================
// IMERSÕES — COUNTDOWN
// ============================================================
function calcImmersionCountdowns() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return (GLOBAL_CONFIG.immersions || [])
    .map(im => {
      const start = new Date(im.startDate + 'T00:00:00');
      const days  = Math.ceil((start - today) / 86400000);
      return { ...im, daysUntil: days, isHappening: days === 0, isPast: days < 0 };
    })
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

// ============================================================
// CRM — HELPERS DE LINHA/DATA (lógica original preservada)
// Semana 1: cabeçalho linha 4, dados linhas 5-11
// Bloco = 11 linhas. Âncora = 31/12/2025
// ============================================================
const PRIMEIRA_DATA        = new Date(2025, 11, 31);
const LINHAS_POR_BLOCO     = 11;
const PRIMEIRA_LINHA_DADOS = 5;

function datePorLinha(linha) {
  const diaIndex    = linha - PRIMEIRA_LINHA_DADOS;
  if (diaIndex < 0) return null;
  const semana      = Math.floor(diaIndex / LINHAS_POR_BLOCO);
  const diaNaSemana = diaIndex % LINHAS_POR_BLOCO;
  if (diaNaSemana > 6) return null;
  const d = new Date(PRIMEIRA_DATA);
  d.setDate(d.getDate() + semana * 7 + diaNaSemana);
  return d;
}

function parseTempo(val) {
  if (!val || val === '0:00' || val === '0:00:00') return 0;
  const p = val.toString().split(':');
  if (p.length === 3) return parseInt(p[0]) * 3600 + parseInt(p[1]) * 60 + parseInt(p[2]);
  if (p.length === 2) return parseInt(p[0]) * 3600 + parseInt(p[1]) * 60;
  return 0;
}

async function encontrarLinhaData(sheets, spreadsheetId, aba, dataBR) {
  const res  = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${aba}'!B:B` });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const cell = (rows[i][0] || '').toString().trim();
    if (cell === dataBR.trim()) return i + 1;
    const p = dataBR.split('/');
    if (p.length === 3 && cell === `${p[0]}/${p[1]}/${p[2].slice(-2)}`) return i + 1;
  }
  return null;
}

async function encontrarLinhaVenda(sheets, spreadsheetId, aba) {
  const res  = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${aba}'!W:W` });
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i] || !rows[i][0] || !rows[i][0].toString().trim()) return i + 1;
  }
  return rows.length + 1;
}

async function calcularTotaisAba(sheets, spreadsheetId, aba, dataInicio, dataFim) {
  const result = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${aba}'!C:F` });
  const rows   = result.data.values || [];
  let totalSegundos = 0, totalAtenderam = 0, totalEntrevistas = 0, totalHeadcounts = 0, diasComDados = 0;
  rows.forEach((row, i) => {
    const data = datePorLinha(i + 1);
    if (!data) return;
    data.setHours(0, 0, 0, 0);
    if (data < dataInicio || data > dataFim) return;
    const horas = parseTempo(row[0]);
    const atend = parseInt(row[1]) || 0;
    const entrv = parseInt(row[2]) || 0;
    const head  = parseInt(row[3]) || 0;
    if (horas > 0 || atend > 0 || entrv > 0 || head > 0) {
      totalSegundos += horas;
      totalAtenderam += atend;
      totalEntrevistas += entrv;
      totalHeadcounts += head;
      diasComDados++;
    }
  });
  return { totalSegundos, totalAtenderam, totalEntrevistas, totalHeadcounts, diasComDados };
}

function formatarResultado(totais) {
  const { totalSegundos, totalAtenderam, totalEntrevistas, totalHeadcounts, diasComDados } = totais;
  const th      = Math.floor(totalSegundos / 3600);
  const tm      = Math.floor((totalSegundos % 3600) / 60);
  const txAtend = totalAtenderam   > 0 ? Math.round((totalEntrevistas / totalAtenderam)   * 100) : 0;
  const txHead  = totalEntrevistas > 0 ? Math.round((totalHeadcounts  / totalEntrevistas) * 100) : 0;
  let pace = '—';
  if (totalHeadcounts > 0 && totalSegundos > 0) {
    const spv = Math.round(totalSegundos / totalHeadcounts);
    const ph  = Math.floor(spv / 3600);
    const pm  = Math.floor((spv % 3600) / 60);
    pace = ph > 0 ? `${ph}h${String(pm).padStart(2, '0')}min` : `${pm}min`;
  }
  return {
    diasComDados,
    totalHoras: `${th}h ${String(tm).padStart(2, '0')}min`,
    totalAtenderam, totalEntrevistas, totalHeadcounts,
    txAtend: `${txAtend}%`, txHead: `${txHead}%`, pace,
  };
}

// ============================================================
// AUTH / UTILS
// ============================================================
function checkAdmin(req, res) {
  const pwd = req.headers['x-admin-password'] || req.body?.password;
  if (pwd !== ADMIN_PASSWORD) { res.status(401).json({ erro: 'Senha incorreta' }); return false; }
  return true;
}

// Team admin: aceita senha global OU código do supervisor do time
function checkTeamAdmin(req, res, teamId) {
  const pwd = req.headers['x-admin-password'] || req.body?.password;
  if (pwd === ADMIN_PASSWORD) return true;
  const sup = getTeam(teamId);
  if (sup && sup.supervisorCode && pwd === sup.supervisorCode) return true;
  res.status(401).json({ erro: 'Senha incorreta' });
  return false;
}

function getTeam(teamId) {
  return SUPERVISORS.find(s => s.id === teamId) || null;
}

function parseDatesBR(inicio, fim) {
  const [di, mi, ai] = inicio.split('/');
  const [df, mf, af] = fim.split('/');
  const dataInicio = new Date(parseInt(ai), parseInt(mi) - 1, parseInt(di));
  const dataFim    = new Date(parseInt(af), parseInt(mf) - 1, parseInt(df));
  dataInicio.setHours(0, 0, 0, 0);
  dataFim.setHours(0, 0, 0, 0);
  return { dataInicio, dataFim };
}

// ============================================================
// ROTAS PÚBLICAS
// ============================================================

app.get('/', (_, res) => res.json({
  status: 'ok', servico: 'Registro Diário API v2',
}));

app.get('/health', (_, res) => res.json({ ok: true, teams: SUPERVISORS.length }));

// Lista de times (sem dados sensíveis — usada pelo frontend para roteamento ?team=)
app.get('/api/teams', (_, res) => {
  res.json(SUPERVISORS.map(s => ({
    id:       s.id,
    name:     s.name,
    teamName: s.teamName,
    color:    s.color,
  })));
});

// Config global + countdown das imersões
app.get('/api/config', (_, res) => {
  res.json({ ...GLOBAL_CONFIG, immersions: calcImmersionCountdowns() });
});

// Vendedores de um time específico (isolado por ?team=)
app.get('/vendedores', (req, res) => {
  const { team } = req.query;
  if (!team) return res.status(400).json({ erro: 'Parâmetro ?team= é obrigatório' });
  const sup = getTeam(team);
  if (!sup) return res.status(404).json({ erro: 'Time não encontrado' });
  res.json(sup.vendors || []);
});

// Grupos de um time com membros resolvidos e imersões atribuídas
app.get('/api/grupos', (req, res) => {
  const { team } = req.query;
  if (!team) return res.status(400).json({ erro: 'Parâmetro ?team= é obrigatório' });
  const sup = getTeam(team);
  if (!sup) return res.status(404).json({ erro: 'Time não encontrado' });

  const allImersoes = calcImmersionCountdowns();
  const grupos = (sup.groups || []).map(g => {
    const members     = (sup.vendors || []).filter(v => (g.vendorCodes || []).includes(v.code));
    const immersions  = allImersoes.filter(im => (g.immersionIds || []).includes(im.id));
    const hcPerVendor = members.length > 0 ? Math.ceil(g.hcGoal / members.length) : 0;
    return { ...g, members, immersions, hcPerVendor };
  });
  res.json(grupos);
});

// Progresso de headcounts de um grupo em um período
app.get('/api/grupo-progresso', async (req, res) => {
  try {
    const { team, groupId, inicio, fim } = req.query;
    if (!team || !groupId || !inicio || !fim)
      return res.status(400).json({ erro: 'team, groupId, inicio (DD/MM/YYYY) e fim são obrigatórios' });

    const sup = getTeam(team);
    if (!sup) return res.status(404).json({ erro: 'Time não encontrado' });
    const group = (sup.groups || []).find(g => g.id === groupId);
    if (!group) return res.status(404).json({ erro: 'Grupo não encontrado' });

    const { dataInicio, dataFim } = parseDatesBR(inicio, fim);
    if (isNaN(dataInicio) || isNaN(dataFim)) return res.status(400).json({ erro: 'Datas inválidas' });

    const members     = (sup.vendors || []).filter(v => (group.vendorCodes || []).includes(v.code));
    const hcPerVendor = members.length > 0 ? Math.ceil(group.hcGoal / members.length) : 0;
    const sheets      = await getSheetsClient();

    const memberResults = await Promise.all(
      members.map(async v => {
        try {
          const totais = await calcularTotaisAba(sheets, sup.crmSheetId, v.crmTab, dataInicio, dataFim);
          return {
            code: v.code, name: v.name,
            headcounts: totais.totalHeadcounts,
            hcMeta:     hcPerVendor,
            pct:        hcPerVendor > 0 ? Math.round((totais.totalHeadcounts / hcPerVendor) * 100) : 0,
            ...formatarResultado(totais),
          };
        } catch (e) {
          return { code: v.code, name: v.name, headcounts: 0, hcMeta: hcPerVendor, pct: 0, erro: e.message };
        }
      })
    );

    const totalHC = memberResults.reduce((s, m) => s + (m.headcounts || 0), 0);
    res.json({
      groupId, groupName: group.name, hcGoal: group.hcGoal, color: group.color,
      totalHC,
      pct:       group.hcGoal > 0 ? Math.round((totalHC / group.hcGoal) * 100) : 0,
      members:   memberResults,
      immersions: calcImmersionCountdowns().filter(im => (group.immersionIds || []).includes(im.id)),
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Taxas por período
app.get('/taxas-periodo', async (req, res) => {
  try {
    const { aba, inicio, fim, team } = req.query;
    if (!aba || !inicio || !fim || !team)
      return res.status(400).json({ erro: 'aba, inicio, fim e team são obrigatórios' });

    const sup = getTeam(team);
    if (!sup) return res.status(404).json({ erro: 'Time não encontrado' });

    const { dataInicio, dataFim } = parseDatesBR(inicio, fim);
    if (isNaN(dataInicio) || isNaN(dataFim)) return res.status(400).json({ erro: 'Datas inválidas. Use DD/MM/YYYY' });
    if (dataInicio > dataFim) return res.status(400).json({ erro: 'Data início não pode ser maior que data fim' });

    const sheets = await getSheetsClient();
    const totais = await calcularTotaisAba(sheets, sup.crmSheetId, aba, dataInicio, dataFim);
    res.json(formatarResultado(totais));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Status de preenchimento do time em uma data (admin)
app.get('/status-time', async (req, res) => {
  const { team, data } = req.query;
  if (!checkTeamAdmin(req, res, team)) return;
  try {
    if (!data || !team) return res.status(400).json({ erro: 'data e team são obrigatórios' });

    const sup = getTeam(team);
    if (!sup) return res.status(404).json({ erro: 'Time não encontrado' });

    const [d, m, a]    = data.split('/');
    const dataConsulta = new Date(parseInt(a), parseInt(m) - 1, parseInt(d));
    dataConsulta.setHours(0, 0, 0, 0);
    if (isNaN(dataConsulta)) return res.status(400).json({ erro: 'Data inválida' });

    const sheets     = await getSheetsClient();
    const resultados = await Promise.all(
      (sup.vendors || []).filter(v => !v.exitDate).map(async v => {
        try {
          const result = await sheets.spreadsheets.values.get({
            spreadsheetId: sup.crmSheetId,
            range: `'${v.crmTab}'!B:F`,
          });
          const rows = result.data.values || [];
          let encontrou = false, horas = '—', atend = '—', entrv = '—', head = '—';
          rows.forEach((row, i) => {
            const dt = datePorLinha(i + 1);
            if (!dt) return;
            dt.setHours(0, 0, 0, 0);
            if (dt.getTime() !== dataConsulta.getTime()) return;
            encontrou = true;
            horas = row[1] || '0h';
            atend = row[2] || '0';
            entrv = row[3] || '0';
            head  = row[4] || '0';
          });
          const preencheu = encontrou && (horas !== '0h' || atend !== '0' || entrv !== '0');
          return { nome: v.name, codigo: v.code, preencheu, horas, atend, entrv, head };
        } catch (e) {
          return { nome: v.name, codigo: v.code, preencheu: false, erro: e.message };
        }
      })
    );
    res.json({ data, resultados });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Vendas do time em uma data (admin)
app.get('/vendas-time', async (req, res) => {
  const { team, data } = req.query;
  if (!checkTeamAdmin(req, res, team)) return;
  try {
    if (!data || !team) return res.status(400).json({ erro: 'data e team são obrigatórios' });

    const sup = getTeam(team);
    if (!sup) return res.status(404).json({ erro: 'Time não encontrado' });

    const sheets     = await getSheetsClient();
    const resultados = await Promise.all(
      (sup.vendors || []).filter(v => !v.exitDate).map(async v => {
        try {
          const result = await sheets.spreadsheets.values.get({
            spreadsheetId: sup.crmSheetId,
            range: `'${v.crmTab}'!W:AE`,
          });
          const rows  = result.data.values || [];
          const vendas = [];
          rows.forEach((row, i) => {
            if (i === 0) return;
            if ((row[0] || '').toString().trim() !== data) return;
            vendas.push({
              data:       row[0] || '', cliente:    row[1] || '',
              email:      row[2] || '', link:       row[3] || '',
              evento:     row[4] || '', categoria:  row[5] || '',
              headcounts: row[6] || '', status:     row[7] || '',
              obs:        row[8] || '',
            });
          });
          return { nome: v.name, codigo: v.code, totalVendas: vendas.length, vendas };
        } catch (e) {
          return { nome: v.name, codigo: v.code, totalVendas: 0, vendas: [], erro: e.message };
        }
      })
    );
    const totalGeral = resultados.reduce((acc, v) => acc + v.totalVendas, 0);
    res.json({ data, totalGeral, resultados });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Salvar métricas diárias
app.post('/salvar-metricas', async (req, res) => {
  try {
    const { team, aba, data, horasFaladas, atenderam, entrevistaCompleta, headcounts, crossSell, comentarios } = req.body;
    if (!team || !aba || !data) return res.status(400).json({ erro: 'team, aba e data são obrigatórios' });

    const sup = getTeam(team);
    if (!sup) return res.status(404).json({ erro: 'Time não encontrado' });

    const sheets = await getSheetsClient();
    const linha  = await encontrarLinhaData(sheets, sup.crmSheetId, aba, data);
    if (!linha) return res.status(404).json({ erro: `Data ${data} não encontrada na aba ${aba}` });

    await sheets.spreadsheets.values.update({
      spreadsheetId: sup.crmSheetId,
      range: `'${aba}'!C${linha}:H${linha}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[horasFaladas, atenderam, entrevistaCompleta, headcounts, crossSell, comentarios]] },
    });
    res.json({ ok: true, linha });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Salvar métricas de Recuperação (colunas M:S da mesma aba)
app.post('/salvar-metricas-rec', async (req, res) => {
  try {
    const { team, aba, data, pagRec, abandono, faleEsp, captacao, invalidos, headcountsRec } = req.body;
    if (!team || !aba || !data) return res.status(400).json({ erro: 'team, aba e data são obrigatórios' });

    const sup = getTeam(team);
    if (!sup) return res.status(404).json({ erro: 'Time não encontrado' });
    const vendor = sup.vendors.find(v => v.crmTab === aba);
    if (!vendor?.hasRec)
      return res.status(403).json({ erro: 'Vendedor não habilitado para Recuperação' });

    const sheets = await getSheetsClient();
    const linha  = await encontrarLinhaData(sheets, sup.crmSheetId, aba, data);
    if (!linha) return res.status(404).json({ erro: `Data ${data} não encontrada na aba ${aba}` });

    // N:S = 6 colunas de dados (M é Data, compartilhada com VA)
    // N=Pag.Rec., O=Abandono, P=Fale c/Esp., Q=Captação, R=Inválidos, S=Headcounts
    await sheets.spreadsheets.values.update({
      spreadsheetId: sup.crmSheetId,
      range: `'${aba}'!N${linha}:S${linha}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[pagRec||0, abandono||0, faleEsp||0, captacao||0, invalidos||0, headcountsRec||0]] },
    });
    res.json({ ok: true, linha });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Salvar venda
app.post('/salvar-venda', async (req, res) => {
  try {
    const { team, aba, data, cliente, email, linkClint, evento, categoria, headcounts, obs } = req.body;
    if (!team || !aba || !data) return res.status(400).json({ erro: 'team, aba e data são obrigatórios' });

    const sup = getTeam(team);
    if (!sup) return res.status(404).json({ erro: 'Time não encontrado' });

    const sheets = await getSheetsClient();
    const linha  = await encontrarLinhaVenda(sheets, sup.crmSheetId, aba);
    await sheets.spreadsheets.values.update({
      spreadsheetId: sup.crmSheetId,
      range: `'${aba}'!W${linha}:AE${linha}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[data, cliente, email, linkClint, evento, categoria, headcounts, '', obs]] },
    });
    res.json({ ok: true, linha });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ============================================================
// ROTAS ADMIN
// ============================================================

// Verificar senha admin global
app.post('/admin/verificar', (req, res) => {
  const pwd = req.headers['x-admin-password'] || req.body?.password;
  res.json({ ok: pwd === ADMIN_PASSWORD });
});

// Verificar senha do time (supervisorCode) ou admin global
app.post('/admin/team-verify', (req, res) => {
  const { teamId } = req.body;
  const pwd = req.headers['x-admin-password'] || req.body?.password;
  if (pwd === ADMIN_PASSWORD) return res.json({ ok: true, isGlobal: true });
  const sup = getTeam(teamId);
  if (sup && sup.supervisorCode && pwd === sup.supervisorCode) return res.json({ ok: true, isGlobal: false, teamId });
  res.status(401).json({ ok: false, erro: 'Senha incorreta' });
});

// Status GitHub
app.get('/admin/github-status', (req, res) => {
  if (!checkAdmin(req, res)) return;
  res.json({ configured: !!GITHUB_TOKEN, repo: GITHUB_REPO, teams: SUPERVISORS.length });
});

// Instruções de setup para popup no frontend ao criar novo time
app.get('/admin/setup-info', (req, res) => {
  if (!checkAdmin(req, res)) return;
  res.json({
    serviceAccountEmail: SERVICE_ACCOUNT_EMAIL,
    steps: [
      `Abra a planilha Google Sheets do time`,
      `Clique em "Compartilhar" e adicione como Editor: ${SERVICE_ACCOUNT_EMAIL}`,
      `Peça ao DevOps para remover a proteção das células (Dados → Planilhas e intervalos protegidos → remover tudo)`,
      `Cole o ID ou URL da planilha ao cadastrar o time aqui`,
    ],
  });
});

// ── SUPERVISORES / TIMES ─────────────────────────────────────

app.post('/admin/supervisor', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { id, name, teamName, crmSheetId, crmUrl, color, supervisorCode } = req.body;
  if (!id || !name || !teamName) return res.status(400).json({ erro: 'id, name e teamName são obrigatórios' });

  const resolvedCRM = crmUrl
    ? (crmUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1] || crmUrl)
    : (crmSheetId || '');

  const idx   = SUPERVISORS.findIndex(s => s.id === id);
  const entry = {
    id, name, teamName,
    color:          color || '#4c9fff',
    crmSheetId:     resolvedCRM,
    supervisorCode: supervisorCode || '',
    vendors: idx >= 0 ? SUPERVISORS[idx].vendors : [],
    groups:  idx >= 0 ? SUPERVISORS[idx].groups  : [],
  };
  idx >= 0 ? (SUPERVISORS[idx] = entry) : SUPERVISORS.push(entry);
  res.json({ ok: true, savedToGitHub: await ghSave('supervisors.json', SUPERVISORS) });
});

app.delete('/admin/supervisor/:id', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  SUPERVISORS = SUPERVISORS.filter(s => s.id !== req.params.id);
  res.json({ ok: true, savedToGitHub: await ghSave('supervisors.json', SUPERVISORS) });
});

// ── VENDEDORES ───────────────────────────────────────────────

app.post('/admin/supervisor/:teamId/vendor', async (req, res) => {
  if (!checkTeamAdmin(req, res, req.params.teamId)) return;
  const sup = SUPERVISORS.find(s => s.id === req.params.teamId);
  if (!sup) return res.status(404).json({ erro: 'Time não encontrado' });

  const { code, name, crmTab, fixedCost, startDate, exitDate, isSupervisor, hasRec, meta } = req.body;
  if (!code || !name) return res.status(400).json({ erro: 'code e name são obrigatórios' });

  const idx   = sup.vendors.findIndex(v => v.code === code);
  const entry = {
    code, name,
    crmTab:       crmTab || `${name} - ${code}`,
    fixedCost:    fixedCost  ?? 1500,
    isSupervisor: isSupervisor || false,
    hasRec:       hasRec || false,
    startDate:    startDate   || null,
    exitDate:     exitDate    || null,
    meta: meta || { day: 0, week: 2, month: 8, value: 2167, headcounts: 20 },
  };
  idx >= 0 ? (sup.vendors[idx] = entry) : sup.vendors.push(entry);
  res.json({ ok: true, savedToGitHub: await ghSave('supervisors.json', SUPERVISORS) });
});

app.delete('/admin/supervisor/:teamId/vendor/:code', async (req, res) => {
  if (!checkTeamAdmin(req, res, req.params.teamId)) return;
  const sup = SUPERVISORS.find(s => s.id === req.params.teamId);
  if (!sup) return res.status(404).json({ erro: 'Time não encontrado' });

  const { code } = req.params;
  sup.vendors = sup.vendors.filter(v => v.code !== code);
  // Remove do grupo automaticamente
  (sup.groups || []).forEach(g => {
    g.vendorCodes = (g.vendorCodes || []).filter(c => c !== code);
  });
  res.json({ ok: true, savedToGitHub: await ghSave('supervisors.json', SUPERVISORS) });
});

// ── GRUPOS ───────────────────────────────────────────────────

app.post('/admin/supervisor/:teamId/grupo', async (req, res) => {
  if (!checkTeamAdmin(req, res, req.params.teamId)) return;
  const sup = SUPERVISORS.find(s => s.id === req.params.teamId);
  if (!sup) return res.status(404).json({ erro: 'Time não encontrado' });
  if (!sup.groups) sup.groups = [];

  const { id, name, color, hcGoal, vendorCodes, immersionIds, periodoInicio, periodoFim } = req.body;
  if (!name) return res.status(400).json({ erro: 'name é obrigatório' });

  const groupId     = id || Date.now().toString();
  const idx         = sup.groups.findIndex(g => g.id === groupId);
  const members     = (sup.vendors || []).filter(v => (vendorCodes || []).includes(v.code));
  const hcPerVendor = members.length > 0 ? Math.ceil((hcGoal || 0) / members.length) : 0;

  const entry = {
    id:           groupId,
    name,
    color:        color || '#4c9fff',
    hcGoal:       hcGoal || 0,
    hcPerVendor,
    vendorCodes:  vendorCodes  || [],
    immersionIds: immersionIds || [],
    periodoInicio: periodoInicio || null,
    periodoFim:    periodoFim    || null,
  };
  idx >= 0 ? (sup.groups[idx] = entry) : sup.groups.push(entry);
  res.json({ ok: true, group: entry, savedToGitHub: await ghSave('supervisors.json', SUPERVISORS) });
});

app.delete('/admin/supervisor/:teamId/grupo/:groupId', async (req, res) => {
  if (!checkTeamAdmin(req, res, req.params.teamId)) return;
  const sup = SUPERVISORS.find(s => s.id === req.params.teamId);
  if (!sup) return res.status(404).json({ erro: 'Time não encontrado' });
  sup.groups = (sup.groups || []).filter(g => g.id !== req.params.groupId);
  res.json({ ok: true, savedToGitHub: await ghSave('supervisors.json', SUPERVISORS) });
});

// Atualizar período da meta global
app.post('/admin/config', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { periodoInicio, periodoFim } = req.body;
  if (!periodoInicio || !periodoFim) return res.status(400).json({ erro: 'periodoInicio e periodoFim são obrigatórios' });
  if (!GLOBAL_CONFIG.meta) GLOBAL_CONFIG.meta = {};
  GLOBAL_CONFIG.meta.periodoInicio = periodoInicio;
  GLOBAL_CONFIG.meta.periodoFim    = periodoFim;
  GLOBAL_CONFIG.updatedAt = new Date().toISOString();
  res.json({ ok: true, savedToGitHub: await ghSave('config.json', GLOBAL_CONFIG) });
});

// ── IMERSÕES ─────────────────────────────────────────────────

app.post('/admin/immersion', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { id, name, startDate, location } = req.body;
  if (!name || !startDate) return res.status(400).json({ erro: 'name e startDate são obrigatórios' });

  if (!GLOBAL_CONFIG.immersions) GLOBAL_CONFIG.immersions = [];
  const immId = id || Date.now().toString();
  const idx   = GLOBAL_CONFIG.immersions.findIndex(i => i.id === immId);
  const entry = { id: immId, name, startDate, location: location || '' };
  idx >= 0 ? (GLOBAL_CONFIG.immersions[idx] = entry) : GLOBAL_CONFIG.immersions.push(entry);
  GLOBAL_CONFIG.updatedAt = new Date().toISOString();
  res.json({ ok: true, savedToGitHub: await ghSave('config.json', GLOBAL_CONFIG) });
});

// Ao deletar imersão, remove referência dos grupos automaticamente
app.delete('/admin/immersion/:id', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { id } = req.params;
  GLOBAL_CONFIG.immersions = (GLOBAL_CONFIG.immersions || []).filter(i => i.id !== id);
  GLOBAL_CONFIG.updatedAt  = new Date().toISOString();
  SUPERVISORS.forEach(sup => {
    (sup.groups || []).forEach(g => {
      g.immersionIds = (g.immersionIds || []).filter(iid => iid !== id);
    });
  });
  await ghSave('config.json', GLOBAL_CONFIG);
  res.json({ ok: true, savedToGitHub: await ghSave('supervisors.json', SUPERVISORS) });
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Registro Diário API v2 na porta ${PORT}`);
  await loadFromGitHub();
});
