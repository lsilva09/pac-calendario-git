'use strict';

const NOMES_MES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho',
  'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const SEM_LOCAL = 'Sem local definido';
// Ordem e largura dos campos no formulário.
const LAYOUT = [
  ['C', true, 'textarea'], ['A', false], ['I', false], ['N', true], ['M', false], ['K', false],
  ['B', false], ['E', false], ['F', false], ['H', false], ['G', true], ['L', true], ['J', false],
  ['O', true, 'textarea'],
];
const DATALISTS = { M: 'dlModalidades', E: 'dlAreas', F: 'dlOrigens' };

const estado = {
  dados: null,
  ano: 2026,
  mes: new Date().getMonth(),
  vista: lerPref('vista', 'ambiente'),
  filtroAmbiente: '',
  busca: '',
  mostrarVirtual: lerPref('virtual', '1') === '1',
  mostrarSuspensos: true,
  editando: null,
};

const $ = (s) => document.querySelector(s);

function lerPref(k, padrao) {
  try { return localStorage.getItem('pac.' + k) ?? padrao; } catch { return padrao; }
}
function gravarPref(k, v) {
  try { localStorage.setItem('pac.' + k, v); } catch { /* sem armazenamento */ }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function iso(a, m, d) {
  return `${a}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function fmtData(isoStr) {
  const [, m, d] = isoStr.split('-');
  return `${d}/${m}`;
}
function hojeIso() {
  const h = new Date();
  return iso(h.getFullYear(), h.getMonth(), h.getDate());
}

// Cor estável por ambiente.
const PALETA = ['#2f6fd6', '#d9480f', '#2b8a3e', '#ae3ec9', '#c2255c', '#0c8599', '#e67700',
  '#5f3dc4', '#5c940d', '#1864ab', '#a61e4d', '#087f5b', '#862e9c', '#b35900'];
function corAmbiente(nome) {
  if (!nome) return '#868e96';
  let h = 0;
  for (const ch of nome) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETA[h % PALETA.length];
}

function aviso(msg, erro = false) {
  const el = $('#aviso');
  el.textContent = msg;
  el.className = 'aviso visivel' + (erro ? ' erro' : '');
  clearTimeout(aviso.t);
  aviso.t = setTimeout(() => { el.className = 'aviso'; }, erro ? 7000 : 3500);
}

async function api(metodo, url, corpo) {
  const r = await fetch(url, {
    method: metodo,
    headers: corpo ? { 'Content-Type': 'application/json' } : {},
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.erro || `Erro ${r.status}`);
  return dados;
}

async function carregar() {
  try {
    aplicarDados(await api('GET', '/api/eventos'));
  } catch (e) {
    $('#vista').innerHTML = `<div class="carregando">${esc(e.message)}</div>`;
  }
}

function aplicarDados(dados) {
  estado.dados = dados;
  $('#arquivo').textContent = `${dados.arquivo} · aba PAC · ${dados.eventos.length} eventos`;
  preencherListas();
  render();
  // Link direto: ?evento=<linha> abre o evento no mês dele.
  const linha = new URLSearchParams(location.search).get('evento');
  if (linha && !aplicarDados.abriu) {
    aplicarDados.abriu = true;
    const ev = eventoPorLinha(linha);
    if (ev) {
      if (ev.datas.length) { [estado.ano, estado.mes] = [Number(ev.datas[0].slice(0, 4)), Number(ev.datas[0].slice(5, 7)) - 1]; render(); }
      if ($('#ajuda').open) $('#ajuda').close();
      abrirModal(ev);
    }
  }
}

// ---------- filtros e conflitos ----------
// Eventos presenciais em vários ambientes usam "Ambiente A / Ambiente B".
// Plataformas EaD (ex.: "ENAP / Justrabalho") não são divididas.
function partesLocal(ev) {
  if (!ev.ambiente) return [];
  if (ev.virtual) return [ev.ambiente];
  return ev.ambiente.split(' / ').map((p) => p.trim()).filter(Boolean);
}

function visivel(ev) {
  if (!estado.mostrarVirtual && ev.virtual) return false;
  if (!estado.mostrarSuspensos && ev.suspenso) return false;
  if (estado.filtroAmbiente) {
    const ok = estado.filtroAmbiente === SEM_LOCAL ? !ev.ambiente : partesLocal(ev).includes(estado.filtroAmbiente);
    if (!ok) return false;
  }
  if (estado.busca) {
    const alvo = Object.values(ev.campos).join(' ').toLowerCase();
    if (!estado.busca.split(/\s+/).every((p) => alvo.includes(p))) return false;
  }
  return true;
}

function sobrepoe(a, b) {
  if (!a.horarios.length || !b.horarios.length) return true;
  return a.horarios.some(([i1, f1]) => b.horarios.some(([i2, f2]) => i1 < f2 && i2 < f1));
}

function participaDeConflito(ev) {
  return !ev.virtual && !ev.suspenso && ev.ambiente;
}

// Mapa data -> lista de pares [a, b] em conflito.
function calcularConflitos(eventos) {
  const porDiaAmb = new Map();
  for (const ev of eventos) {
    if (!participaDeConflito(ev)) continue;
    for (const d of ev.datas) {
      const k = d + '|' + ev.ambiente.toLowerCase();
      if (!porDiaAmb.has(k)) porDiaAmb.set(k, []);
      porDiaAmb.get(k).push(ev);
    }
  }
  const conflitos = [];
  for (const [k, lista] of porDiaAmb) {
    if (lista.length < 2) continue;
    const [data] = k.split('|');
    for (let i = 0; i < lista.length; i++) {
      for (let j = i + 1; j < lista.length; j++) {
        if (sobrepoe(lista[i], lista[j])) conflitos.push({ data, ambiente: lista[i].ambiente, a: lista[i], b: lista[j] });
      }
    }
  }
  return conflitos.sort((x, y) => x.data.localeCompare(y.data));
}

// ---------- renderização ----------
function render() {
  if (!estado.dados) return;
  $('#tituloMes').textContent = `${NOMES_MES[estado.mes]} ${estado.ano}`;
  document.querySelectorAll('.alternador button').forEach((b) => b.classList.toggle('ativo', b.dataset.vista === estado.vista));

  const prefixo = iso(estado.ano, estado.mes, 1).slice(0, 7);
  const todos = estado.dados.eventos;
  const conflitos = calcularConflitos(todos).filter((c) => c.data.startsWith(prefixo));
  const emConflito = new Set();
  const diasConflito = new Set();
  for (const c of conflitos) {
    emConflito.add(c.a.linha + '|' + c.data);
    emConflito.add(c.b.linha + '|' + c.data);
    diasConflito.add(c.data + '|' + c.ambiente.toLowerCase());
    diasConflito.add(c.data);
  }
  const doMes = todos.filter((ev) => visivel(ev) && ev.datas.some((d) => d.startsWith(prefixo)));
  const ctx = { prefixo, doMes, emConflito, diasConflito };
  if (estado.vista === 'mes') renderMes(ctx); else renderAmbientes(ctx);
  renderLateral(conflitos);
}

function chip(ev, data, ctx, mostrarLocal) {
  const classes = ['chip'];
  if (ev.virtual) classes.push('virtual');
  if (ev.suspenso) classes.push('suspenso');
  if (ctx.emConflito.has(ev.linha + '|' + data)) classes.push('em-conflito');
  const extra = [ev.campos.I.split('\n')[0], mostrarLocal ? (ev.ambiente || SEM_LOCAL) : ''].filter(Boolean).join(' · ');
  const titulo = `${ev.campos.C}\n${ev.campos.A}\n${ev.campos.I || 'sem horário'}\n${ev.ambiente || SEM_LOCAL}`;
  return `<button type="button" class="${classes.join(' ')}" style="--cor:${corAmbiente(ev.ambiente)}" data-linha="${ev.linha}" title="${esc(titulo)}">`
    + `<span class="t">${esc(ev.campos.C)}</span>`
    + (extra ? `<span class="h">${esc(extra)}</span>` : '') + '</button>';
}

function renderAmbientes(ctx) {
  const dias = new Date(estado.ano, estado.mes + 1, 0).getDate();
  const hoje = hojeIso();
  const grupos = { fisico: new Map(), semLocal: new Map(), virtual: new Map() };
  for (const ev of ctx.doMes) {
    const g = ev.virtual ? 'virtual' : (ev.ambiente ? 'fisico' : 'semLocal');
    const nome = ev.ambiente || SEM_LOCAL;
    if (!grupos[g].has(nome)) grupos[g].set(nome, []);
    grupos[g].get(nome).push(ev);
  }
  // table-layout: fixed só respeita as larguras das colunas com largura total explícita.
  let h = `<table class="ambientes" style="width:${210 + 108 * dias}px"><thead><tr><th class="nome">Ambiente</th>`;
  for (let d = 1; d <= dias; d++) {
    const dt = new Date(estado.ano, estado.mes, d);
    const cls = [dt.getDay() % 6 === 0 ? 'fds' : '', iso(estado.ano, estado.mes, d) === hoje ? 'hoje' : ''].join(' ');
    h += `<th class="${cls}"><span class="dia">${d}</span>${DIAS_SEMANA[dt.getDay()]}</th>`;
  }
  h += '</tr></thead><tbody>';
  const secoes = [['Ambientes físicos', grupos.fisico], ['Presencial sem local informado', grupos.semLocal], ['EaD / online', grupos.virtual]];
  let algum = false;
  for (const [titulo, mapa] of secoes) {
    if (!mapa.size) continue;
    algum = true;
    h += `<tr class="grupo"><th>${titulo}</th><td colspan="${dias}"></td></tr>`;
    const nomes = [...mapa.keys()].sort((a, b) => mapa.get(b).length - mapa.get(a).length || a.localeCompare(b));
    for (const nome of nomes) {
      const evs = mapa.get(nome);
      const amb = nome === SEM_LOCAL ? '' : nome;
      h += `<tr><th class="nome" style="--cor:${corAmbiente(amb)}"><span class="bolinha"></span>${esc(nome)}</th>`;
      for (let d = 1; d <= dias; d++) {
        const data = iso(estado.ano, estado.mes, d);
        const dt = new Date(estado.ano, estado.mes, d);
        const doDia = evs.filter((ev) => ev.datas.includes(data));
        const cls = [dt.getDay() % 6 === 0 ? 'fds' : '', data === hoje ? 'hoje' : '',
          amb && ctx.diasConflito.has(data + '|' + amb.toLowerCase()) ? 'conflito' : ''].join(' ');
        h += `<td class="${cls}" data-data="${data}" data-local="${esc(amb)}">${doDia.map((ev) => chip(ev, data, ctx, false)).join('')}</td>`;
      }
      h += '</tr>';
    }
  }
  h += '</tbody></table>';
  $('#vista').innerHTML = algum ? h : '<div class="carregando">Nenhum evento com data neste mês para os filtros atuais.</div>';
}

function renderMes(ctx) {
  const primeiro = new Date(estado.ano, estado.mes, 1);
  const inicio = new Date(primeiro);
  inicio.setDate(1 - primeiro.getDay());
  const hoje = hojeIso();
  let h = '<div class="mes">' + DIAS_SEMANA.map((d) => `<div class="cab">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const dt = new Date(inicio);
    dt.setDate(inicio.getDate() + i);
    if (i === 35 && dt.getMonth() !== estado.mes) break;
    const data = iso(dt.getFullYear(), dt.getMonth(), dt.getDate());
    const fora = dt.getMonth() !== estado.mes;
    const evs = fora ? [] : ctx.doMes.filter((ev) => ev.datas.includes(data));
    evs.sort((a, b) => (a.virtual - b.virtual) || (a.ambiente || '~').localeCompare(b.ambiente || '~'));
    const conflito = !fora && ctx.diasConflito.has(data);
    const cls = ['dia', fora ? 'fora' : '', dt.getDay() % 6 === 0 ? 'fds' : '', data === hoje ? 'hoje' : '', conflito ? 'conflito' : ''].join(' ');
    h += `<div class="${cls}" data-data="${fora ? '' : data}"><div class="num"><span>${dt.getDate()}</span>`
      + (conflito ? '<span class="alerta">⚠ conflito</span>' : '') + '</div>'
      + evs.map((ev) => chip(ev, data, ctx, true)).join('') + '</div>';
  }
  $('#vista').innerHTML = h + '</div>';
}

function renderLateral(conflitos) {
  const lc = $('#listaConflitos');
  $('#qtdConflitos').textContent = conflitos.length;
  $('#qtdConflitos').classList.toggle('tem', conflitos.length > 0);
  lc.innerHTML = conflitos.length ? conflitos.map((c) => `<li class="conflito"><strong>${fmtData(c.data)}</strong> · ${esc(c.ambiente)}<br>`
    + `<a data-linha="${c.a.linha}">${esc(c.a.campos.C)}</a> <span class="sutil">(${esc(c.a.campos.I || 'sem horário')})</span><br>`
    + `<a data-linha="${c.b.linha}">${esc(c.b.campos.C)}</a> <span class="sutil">(${esc(c.b.campos.I || 'sem horário')})</span></li>`).join('')
    : '<li class="vazio">Nenhum conflito neste mês.</li>';

  const semData = estado.dados.eventos.filter((ev) => !ev.datas.length && ev.mes_bloco === estado.mes + 1 && visivel(ev));
  $('#qtdSemData').textContent = semData.length;
  $('#listaSemData').innerHTML = semData.length ? semData.map((ev) => `<li><a data-linha="${ev.linha}">${esc(ev.campos.C || '(sem nome)')}</a>`
    + `<br><span class="sutil">Linha ${ev.linha} · Período: ${esc(ev.campos.A || 'vazio')}</span></li>`).join('')
    : '<li class="vazio">Todos os eventos deste mês têm data.</li>';
}

function preencherListas() {
  const evs = estado.dados.eventos;
  const contar = (col) => {
    const m = new Map();
    for (const ev of evs) {
      const valores = col === 'N' ? partesLocal(ev) : [ev.campos[col].trim()];
      for (const v of valores) if (v) m.set(v, (m.get(v) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
  };
  for (const [col, id] of Object.entries(DATALISTS)) {
    $('#' + id).innerHTML = contar(col).map((v) => `<option value="${esc(v)}">`).join('');
  }
  const sel = $('#filtroAmbiente');
  const atual = estado.filtroAmbiente;
  const ambientes = [...new Set(evs.flatMap((ev) => ev.ambiente ? partesLocal(ev) : [SEM_LOCAL]))].sort((a, b) => a.localeCompare(b));
  sel.innerHTML = '<option value="">Todos os ambientes</option>' + ambientes.map((a) => `<option>${esc(a)}</option>`).join('');
  sel.value = ambientes.includes(atual) ? atual : '';
  estado.filtroAmbiente = sel.value;
}

// ---------- formulário ----------
function abrirModal(ev, preset = {}) {
  estado.editando = ev;
  const campos = ev ? ev.campos : { ...Object.fromEntries(Object.keys(estado.dados.campos).map((c) => [c, ''])), ...preset };
  $('#tituloModal').textContent = ev ? 'Editar evento' : 'Novo evento';
  $('#linhaModal').textContent = ev ? `Linha ${ev.linha} da aba PAC` : 'Será gravado numa linha vazia do mês correspondente';
  $('#excluir').hidden = !ev;
  $('#camposForm').innerHTML = LAYOUT.map(([col, largo, tipo]) => {
    const rotulo = estado.dados.campos[col];
    if (col === 'N') return campoLocal(rotulo, campos.N);
    const lista = DATALISTS[col] ? ` list="${DATALISTS[col]}"` : '';
    const dica = col === 'A' ? ' placeholder="ex.: 09/03, 10/03 e 11/03  ou  06 a 10/04"' : col === 'I' ? ' placeholder="ex.: 08h às 12h e 13h às 17h"' : '';
    const campo = tipo === 'textarea' || campos[col].includes('\n')
      ? `<textarea name="${col}" rows="2">${esc(campos[col])}</textarea>`
      : `<input name="${col}" value="${esc(campos[col])}"${lista}${dica} autocomplete="off">`;
    return `<label class="${largo ? 'largo' : ''}">${esc(rotulo)}${campo}</label>`;
  }).join('');
  $('#formEvento').oninput = (e) => { if (['A', 'I', 'N_parte', 'M', 'O'].includes(e.target.name)) previa(); };
  previa();
  $('#modal').showModal();
  $('#camposForm [name=C]').focus();
}

function lerForm() {
  const f = new FormData($('#formEvento'));
  const campos = Object.fromEntries(Object.keys(estado.dados.campos).map((c) => [c, (f.get(c) ?? '').toString()]));
  const partes = [...new Set(f.getAll('N_parte').map(String).filter(Boolean))];
  campos.N = partes.join(' / ');
  // Sem alteração no local, preserva o texto original (inclusive grafias antigas).
  const original = estado.editando?.campos.N ?? '';
  if (estado.localOriginal && campos.N === estado.localOriginal.join(' / ')) campos.N = original;
  return campos;
}

// ---------- campo LOCAL (somente locais da lista oficial) ----------
function separarLocal(texto) {
  const v = texto.replace(/\s+/g, ' ').trim();
  if (!v) return [];
  if (estado.dados.locais.includes(v)) return [v];
  return v.split(' / ').map((p) => p.trim()).filter(Boolean);
}

function opcoesLocal(selecionado) {
  const locais = estado.dados.locais;
  const extra = selecionado && !locais.includes(selecionado)
    ? `<option value="${esc(selecionado)}" selected>⚠ ${esc(selecionado)} (fora da lista)</option>` : '';
  return `<option value="">— selecione —</option>${extra}`
    + locais.map((l) => `<option${l === selecionado ? ' selected' : ''}>${esc(l)}</option>`).join('');
}

function linhaLocal(valor, removivel) {
  return `<div class="local-linha"><select name="N_parte">${opcoesLocal(valor)}</select>`
    + (removivel ? '<button type="button" class="icone" data-remover-local aria-label="Remover ambiente">×</button>' : '') + '</div>';
}

function campoLocal(rotulo, valor) {
  const partes = separarLocal(valor);
  estado.localOriginal = partes;
  const linhas = (partes.length ? partes : ['']).map((p, i) => linhaLocal(p, i > 0)).join('');
  return `<div class="largo campo-local"><span class="rotulo">${esc(rotulo)}</span><div id="locaisSel">${linhas}</div>`
    + '<button type="button" class="link" id="addLocal">+ outro ambiente (evento em mais de um local)</button></div>';
}

document.addEventListener('click', (e) => {
  if (e.target.id === 'addLocal') {
    $('#locaisSel').insertAdjacentHTML('beforeend', linhaLocal('', true));
    [...document.querySelectorAll('#locaisSel select')].at(-1).focus();
  } else if (e.target.matches('[data-remover-local]')) {
    e.target.closest('.local-linha').remove();
    previa();
  }
});

async function previa() {
  clearTimeout(previa.t);
  previa.t = setTimeout(async () => {
    const campos = lerForm();
    let r;
    try { r = await api('POST', '/api/interpretar', { periodo: campos.A, horario: campos.I }); } catch { return; }
    const blocos = [];
    if (!campos.A.trim()) {
      blocos.push('<div class="bloco alerta">Sem PERÍODO: o evento não aparecerá no calendário (só na lista “Sem data reconhecida”).</div>');
    } else if (!r.datas.length) {
      blocos.push('<div class="bloco erro">Não consegui reconhecer datas neste PERÍODO. Use formatos como “09/03, 10/03 e 11/03” ou “06 a 10/04”.</div>');
    } else {
      const lista = r.datas.length > 14 ? r.datas.slice(0, 12).map(fmtData).join(', ') + ` … ${fmtData(r.datas.at(-1))}` : r.datas.map(fmtData).join(', ');
      blocos.push(`<div class="bloco"><strong>${r.datas.length} dia(s) reconhecido(s):</strong> ${lista}`
        + (campos.I.trim() && !r.horarios.length ? '<br><span class="sutil">Horário não reconhecido: conflitos serão avaliados para o dia inteiro.</span>' : '') + '</div>');
      // Conflitos que este evento teria com os demais.
      const ficticio = {
        linha: estado.editando?.linha ?? -1, campos, datas: r.datas, horarios: r.horarios,
        ambiente: campos.N.replace(/\s+/g, ' ').trim(),
        virtual: eVirtual(campos), suspenso: /suspens|cancelad/i.test(campos.O),
      };
      if (participaDeConflito(ficticio)) {
        const outros = estado.dados.eventos.filter((e) => e.linha !== ficticio.linha);
        const achados = calcularConflitos([ficticio, ...outros]).filter((c) => c.a === ficticio || c.b === ficticio);
        if (achados.length) {
          blocos.push('<div class="bloco erro"><strong>⚠ Conflito de ambiente:</strong><br>' + achados.map((c) => {
            const o = c.a === ficticio ? c.b : c.a;
            return `${fmtData(c.data)} — ${esc(o.campos.C)} (${esc(o.campos.I || 'sem horário')})`;
          }).join('<br>') + '</div>');
        }
      }
    }
    $('#previa').innerHTML = blocos.join('');
  }, 250);
}

// Mesma regra do servidor (servidor.py: e_virtual).
function eVirtual(c) {
  const mod = c.M.toLowerCase();
  const local = c.N.toLowerCase();
  if (mod.includes('presencial') && !mod.includes('tele')) return false;
  if (mod.includes('híbrido') || mod.includes('hibrido')) return false;
  if (['ead', 'online', 'telepresencial'].some((p) => mod.includes(p))) return true;
  return local.includes('plataforma');
}

async function salvar(e) {
  e.preventDefault();
  const campos = lerForm();
  if (!campos.C.trim()) { aviso('Informe o nome do EVENTO.', true); return; }
  const botao = $('#salvar');
  botao.disabled = true;
  try {
    const ev = estado.editando;
    const r = ev
      ? await api('PUT', `/api/eventos/${ev.linha}`, { original: ev.campos, campos })
      : await api('POST', '/api/eventos', { campos, mes: estado.mes + 1 });
    $('#modal').close();
    aplicarDados(r);
    aviso(ev ? `Linha ${r.linha} atualizada na planilha.` : `Evento criado na linha ${r.linha} da planilha.`);
  } catch (err) {
    aviso(err.message, true);
  } finally {
    botao.disabled = false;
  }
}

async function excluir() {
  const ev = estado.editando;
  if (!ev) return;
  if (!confirm(`Excluir “${ev.campos.C}”?\n\nO conteúdo da linha ${ev.linha} será apagado da planilha (um backup é salvo antes).`)) return;
  try {
    const r = await api('DELETE', `/api/eventos/${ev.linha}`, { original: ev.campos });
    $('#modal').close();
    aplicarDados(r);
    aviso(`Evento da linha ${ev.linha} excluído.`);
  } catch (err) {
    aviso(err.message, true);
  }
}

function eventoPorLinha(linha) {
  return estado.dados.eventos.find((e) => e.linha === Number(linha));
}

// ---------- eventos da página ----------
function mudarMes(delta) {
  estado.mes += delta;
  if (estado.mes < 0) { estado.mes = 11; estado.ano--; }
  if (estado.mes > 11) { estado.mes = 0; estado.ano++; }
  render();
}

document.addEventListener('click', (e) => {
  const alvo = e.target.closest('[data-linha]');
  if (alvo) { const ev = eventoPorLinha(alvo.dataset.linha); if (ev) abrirModal(ev); return; }
  const celula = e.target.closest('#vista [data-data]');
  if (celula && celula.dataset.data && e.detail === 2) {
    const [a, m, d] = celula.dataset.data.split('-');
    abrirModal(null, { A: `${d}/${m}/${a}`, N: celula.dataset.local || '' });
  }
});

$('#mesAnterior').onclick = () => mudarMes(-1);
$('#mesSeguinte').onclick = () => mudarMes(1);
$('#hoje').onclick = () => { const h = new Date(); estado.ano = h.getFullYear(); estado.mes = h.getMonth(); render(); };
document.querySelectorAll('.alternador button').forEach((b) => { b.onclick = () => { estado.vista = b.dataset.vista; gravarPref('vista', estado.vista); render(); }; });
$('#novo').onclick = () => abrirModal(null);
$('#filtroAmbiente').onchange = (e) => { estado.filtroAmbiente = e.target.value; render(); };
$('#filtroBusca').oninput = (e) => { estado.busca = e.target.value.trim().toLowerCase(); render(); };
$('#filtroVirtual').checked = estado.mostrarVirtual;
$('#filtroVirtual').onchange = (e) => { estado.mostrarVirtual = e.target.checked; gravarPref('virtual', e.target.checked ? '1' : '0'); render(); };
$('#filtroSuspensos').onchange = (e) => { estado.mostrarSuspensos = e.target.checked; render(); };
$('#abrirAjuda').onclick = () => $('#ajuda').showModal();
document.querySelectorAll('[data-fechar-ajuda]').forEach((b) => { b.onclick = () => $('#ajuda').close(); });
$('#ajuda').addEventListener('close', () => gravarPref('ajudaVista', '1'));
$('#formEvento').onsubmit = salvar;
$('#cancelar').onclick = () => $('#modal').close();
$('#excluir').onclick = excluir;
document.addEventListener('keydown', (e) => {
  if ($('#modal').open || $('#ajuda').open || e.target.matches('input, textarea, select')) return;
  if (e.key === 'ArrowLeft') mudarMes(-1);
  if (e.key === 'ArrowRight') mudarMes(1);
});
// Recarrega ao voltar para a aba, caso a planilha tenha sido editada no Excel.
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#modal').open) carregar(); });

const params = new URLSearchParams(location.search);
if (params.get('mes')) estado.mes = Math.min(11, Math.max(0, Number(params.get('mes')) - 1));
if (params.get('vista')) estado.vista = params.get('vista');
$('#vista').innerHTML = '<div class="carregando">Carregando planilha…</div>';
carregar();
if (lerPref('ajudaVista', '0') !== '1') $('#ajuda').showModal();
