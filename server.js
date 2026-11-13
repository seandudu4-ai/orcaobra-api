// Servidor do OrçaObra IA: guarda a chave da API e gera o orçamento.
// Variáveis de ambiente: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY,
// REVENUECAT_SECRET_KEY, LIMITE_GRATIS (padrão 3 por dia), LIMITE_PRO (padrão 30 por dia), PORT
import 'dotenv/config';
import express from 'express';

const app = express();
app.use(express.json({ limit: '25mb' }));

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY } = process.env;
const { REVENUECAT_SECRET_KEY } = process.env;
const LIMITE_GRATIS = Number(process.env.LIMITE_GRATIS) || 3;
const LIMITE_PRO = Number(process.env.LIMITE_PRO) || 30;
const cachePlano = new Map(); // usuário -> { pro, ate }

// Pergunta ao RevenueCat se o usuário tem o entitlement "pro" ativo. Se o RevenueCat falhar, vale o plano gratuito.
async function ehPro(userId) {
  const c = cachePlano.get(userId);
  if (c && c.ate > Date.now()) return c.pro;
  let pro = false;
  try {
    const r = await fetch('https://api.revenuecat.com/v1/subscribers/' + encodeURIComponent(userId), {
      headers: { Authorization: 'Bearer ' + REVENUECAT_SECRET_KEY, 'Content-Type': 'application/json' },
    });
    if (r.ok) {
      const e = (await r.json()).subscriber?.entitlements?.pro;
      pro = !!e && (!e.expires_date || new Date(e.expires_date) > new Date());
    }
  } catch {}
  cachePlano.set(userId, { pro, ate: Date.now() + (pro ? 60000 : 10000) });
  return pro;
}
const uso = new Map(); // usuário -> { dia, qtd }. Zera ao reiniciar o servidor (veja o LEIA-ME)

// Confere o token de login com o Supabase e devolve o usuário (ou null)
async function usuarioDoToken(req) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token },
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function montarPrompt({ tipo, padrao, escopoPreco, cidade, descricao, temArquivos, incluirMateriais }) {
  const escopo = descricao?.trim()
    ? `Serviços a executar, descritos pelo empreiteiro (use como escopo principal e não inclua o que não foi pedido): "${descricao.trim()}". `
    : '';
  const medidas = temArquivos
    ? 'Use cotas e escala visíveis; se não houver, estime pelas proporções e explique na premissa.'
    : 'Sem planta: use as medidas citadas na descrição; onde faltarem, adote medidas típicas e registre isso na premissa e nos alertas.';
  const regraPreco = {
    'Somente mão de obra': 'Informe em "preco" somente o custo médio da mão de obra, sem incluir materiais.',
    'Somente material': 'Informe em "preco" somente o custo médio dos materiais, sem incluir mão de obra.',
    'Material e mão de obra': 'Informe em "preco" o custo médio combinado de materiais e mão de obra.',
  }[escopoPreco];
  const regraMateriais = incluirMateriais
    ? 'Inclua também "materiais" como uma lista separada com os materiais necessários e suas quantidades estimadas, sem duplicar serviços, no formato [{"descricao":"","qtd":0,"un":""}]. Considere perdas usuais e registre incertezas nos alertas.'
    : 'Retorne "materiais" como lista vazia.';
  return `Você é um engenheiro orçamentista brasileiro ajudando um pequeno empreiteiro. ${temArquivos ? 'Analise a planta enviada e levante' : 'Com base na descrição dos serviços, levante'} quantitativos estimados para: ${tipo}, padrão ${padrao}, em ${cidade}. ${escopo}${medidas} Responda SOMENTE com JSON válido neste formato: {"resumo":"texto curto com área e ambientes identificados","area_m2":0,"itens":[{"etapa":"","descricao":"","un":"","qtd":0,"preco":0,"premissa":"curta"}],"materiais":[],"alertas":["pontos que o empreiteiro deve conferir"]}. ${regraMateriais} Use apenas as etapas pertinentes ao escopo, nesta ordem: Serviços preliminares, Fundação, Estrutura, Alvenaria, Cobertura, Instalações hidráulicas, Instalações elétricas, Revestimentos, Esquadrias, Pintura, Limpeza final. Use de 8 a 30 itens, conforme o tamanho do escopo. REGRA OBRIGATÓRIA DE PREÇO: ${regraPreco} Use sempre preços médios de mercado, considerando a tabela SINAPI brasileira como referência; não use preços mínimos nem inflacionados. Nenhum texto fora do JSON.`;
}

app.post('/orcamento', async (req, res) => {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const user = await usuarioDoToken(req);
  if (token && !user) return res.status(401).json({ erro: 'Sessão inválida. Entre novamente.' });
  const {
    tipo = 'Construção nova',
    padrao = 'Médio',
    escopo_preco: escopoPreco = 'Material e mão de obra',
    cidade,
    descricao,
    incluir_materiais: incluirMateriais = false,
    arquivos = [],
    client_id,
  } = req.body || {};
  if (!user && (typeof client_id !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(client_id))) {
    return res.status(400).json({ erro: 'Identificador de visitante inválido. Atualize o aplicativo.' });
  }
  if (typeof cidade !== 'string' || !cidade.trim()) {
    return res.status(400).json({ erro: 'Informe a cidade e o estado (UF) da obra.' });
  }
  const escoposPrecoPermitidos = ['Somente mão de obra', 'Somente material', 'Material e mão de obra'];
  if (!escoposPrecoPermitidos.includes(escopoPreco)) {
    return res.status(400).json({ erro: 'Selecione mão de obra, material ou ambos para os preços.' });
  }
  const usuarioId = user?.id || 'visitante_' + client_id;
  const limiteId = user?.id || usuarioId;
  if (!Array.isArray(arquivos) || arquivos.length > 4) {
    return res.status(400).json({ erro: 'Envie no máximo 4 anexos.' });
  }
  if (!descricao?.trim() && !arquivos.length) {
    return res.status(400).json({ erro: 'Envie a planta ou descreva os serviços.' });
  }
  const hoje = new Date().toISOString().slice(0, 10);
  const u = uso.get(limiteId);
  const qtd = u?.dia === hoje ? u.qtd : 0;
  const pro = user ? await ehPro(user.id) : false;
  const limite = pro ? LIMITE_PRO : LIMITE_GRATIS;
  if (qtd >= limite) {
    return pro
      ? res.status(429).json({ erro: `Limite de ${limite} orçamentos por dia atingido. Volte amanhã.` })
      : res.status(429).json({ codigo: 'limite_gratis', erro: `Você usou seus ${limite} orçamentos gratuitos de hoje. Assine o plano Pro para continuar.` });
  }

  const prompt = montarPrompt({
    tipo,
    padrao,
    escopoPreco,
    cidade: cidade.trim(),
    descricao,
    temArquivos: arquivos.length > 0,
    incluirMateriais: incluirMateriais === true,
  });
  try {
    const resultado = await gerarComGemini(prompt, arquivos);
    uso.set(limiteId, { dia: hoje, qtd: qtd + 1 });
    res.json(resultado);
  } catch (e) {
    res.status(502).json({ erro: e.message || 'Não consegui gerar o orçamento. Tente de novo.' });
  }
});

function lerResultado(texto) {
  const inicio = texto.indexOf('{');
  const fim = texto.lastIndexOf('}');
  if (inicio < 0 || fim <= inicio) return null;
  try {
    const resultado = JSON.parse(texto.slice(inicio, fim + 1));
    return Array.isArray(resultado.itens) ? resultado : null;
  } catch {
    return null;
  }
}

async function gerarComGemini(prompt, arquivos) {
  const chave = process.env.GEMINI_API_KEY;
  if (!chave) throw new Error('GEMINI_API_KEY não está configurada no servidor.');
  const parts = [{ text: prompt }];
  for (const arquivo of arquivos.slice(0, 4)) {
    if (!arquivo.base64) continue;
    parts.push({ inlineData: { mimeType: arquivo.mime || 'image/jpeg', data: arquivo.base64 } });
  }
  const modelos = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
  let ultimoErro;
  for (const modelo of modelos) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${encodeURIComponent(chave)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json' } }),
      });
      const data = await response.json();
      if (!response.ok) {
        const erro = new Error(data.error?.message || `Falha ao consultar o Gemini (${response.status}).`);
        ultimoErro = erro;
        if (![429, 500, 502, 503, 504].includes(response.status)) break;
        continue;
      }
      const texto = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      const resultado = lerResultado(texto);
      if (!resultado) throw new Error('O Gemini retornou uma resposta fora do formato esperado.');
      return resultado;
    } catch (e) {
      ultimoErro = e;
    }
  }
  throw ultimoErro || new Error('Não foi possível consultar os modelos Gemini.');
}

// Exclusão de conta (exigida pelo Google Play)
app.delete('/conta', async (req, res) => {
  const user = await usuarioDoToken(req);
  if (!user) return res.status(401).json({ erro: 'Não autorizado.' });
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY },
    });
    uso.delete(user.id);
    res.status(r.ok ? 200 : 502).json({ ok: r.ok });
  } catch {
    res.status(502).json({ ok: false });
  }
});

app.get('/', (_, res) => res.send('OrçaObra IA no ar'));
app.get('/health', (_, res) => res.json({
  ok: true,
  gemini: Boolean(process.env.GEMINI_API_KEY),
}));
app.listen(process.env.PORT || 3000);
