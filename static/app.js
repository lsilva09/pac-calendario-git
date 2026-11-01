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

const estado = {
  dados: null,
  ano: 2026,
  mes: new Date().getMonth(),
  vista: lerPref('vista', 'ambiente'),
  filtroAmbiente: '',
  busca: '',
  mostrarVirtual: lerPref('virtual', '1') === '1',
  mostrarExternos: lerPref('externos', '1') === '1',
  mostrarSuspensos: true,
  editando: null,
  lista: [],
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
    const dados = await api('GET', '/api/eventos');
    if (dados.sem_planilha) semPlanilha(); else aplicarDados(dados);
  } catch (e) {
    $('#vista').innerHTML = `<div class="carregando">${esc(e.message)}</div>`;
  }
}

function semPlanilha() {
  $('#arquivo').textContent = 'Nenhuma planilha aberta';
  $('#vista').innerHTML = '<div class="carregando">Baixe a planilha do PAC no Google Drive '
    + '(Arquivo → Fazer download → Microsoft Excel) e clique em <b>Abrir planilha</b>.</div>';
}

function fmtCarga(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return ` · carregada em ${d.toLocaleDateString('pt-BR')} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

async function abrirPlanilha(arquivo) {
  if (!arquivo) return;
  const botao = $('#abrirPlanilha');
  botao.disabled = true;
  try {
    const r = await fetch('/api/planilha', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Nome-Arquivo': encodeURIComponent(arquivo.name) },
      body: arquivo,
    });
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(dados.erro || `Erro ${r.status}`);
    aplicarDados(dados);
    aviso(`Planilha “${arquivo.name}” aberta: ${dados.eventos.length} eventos.`);
  } catch (err) {
    aviso(err.message, true);
  } finally {
    botao.disabled = false;
    $('#arquivoPlanilha').value = '';
  }
}

function aplicarDados(dados) {
  estado.dados = dados;
  $('#arquivo').textContent = `${dados.arquivo} · aba PAC · ${dados.eventos.length} eventos${fmtCarga(dados.carregada_em)}`;
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

// Eventos fora da EJud: LOCAL "Evento Externo" na planilha.
function externo(ev) {
  return ev.ambiente.trim().toLowerCase() === 'evento externo';
}

function visivel(ev) {
  if (!estado.mostrarVirtual && ev.virtual) return false;
  if (!estado.mostrarExternos && externo(ev)) return false;
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
  return !ev.virtual && !ev.suspenso && ev.ambiente && !externo(ev);
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
  const sel = $('#filtroAmbiente');
  const atual = estado.filtroAmbiente;
  const ambientes = [...new Set(evs.flatMap((ev) => ev.ambiente ? partesLocal(ev) : [SEM_LOCAL]))].sort((a, b) => a.localeCompare(b));
  sel.innerHTML = '<option value="">Todos os ambientes</option>' + ambientes.map((a) => `<option>${esc(a)}</option>`).join('');
  sel.value = ambientes.includes(atual) ? atual : '';
  estado.filtroAmbiente = sel.value;
}

// ---------- detalhes do evento (somente leitura) ----------
function abrirModal(ev) {
  estado.editando = ev;
  $('#tituloModal').textContent = ev.campos.C || 'Evento';
  $('#linhaModal').textContent = `Linha ${ev.linha} da aba PAC`;
  $('#camposForm').innerHTML = LAYOUT.map(([col, largo, tipo]) => {
    const valor = ev.campos[col];
    const campo = tipo === 'textarea' || valor.includes('\n')
      ? `<textarea name="${col}" rows="2" readonly>${esc(valor)}</textarea>`
      : `<input name="${col}" value="${esc(valor)}" readonly>`;
    return `<label class="${largo ? 'largo' : ''}">${esc(estado.dados.campos[col])}${campo}</label>`;
  }).join('');
  previa();
  $('#modal').showModal();
}

async function previa() {
  clearTimeout(previa.t);
  previa.t = setTimeout(async () => {
    const campos = estado.editando.campos;
    let r;
    try { r = await api('POST', '/api/interpretar', { periodo: campos.A, horario: campos.I }); } catch { return; }
    const blocos = [];
    if (!campos.A.trim()) {
      blocos.push('<div class="bloco alerta">Sem PERÍODO: o evento não aparece no calendário (só na lista “Sem data reconhecida”).</div>');
    } else if (!r.datas.length) {
      blocos.push('<div class="bloco erro">Não consegui reconhecer datas neste PERÍODO. Na planilha, use formatos como “09/03, 10/03 e 11/03” ou “06 a 10/04”.</div>');
    } else {
      const lista = r.datas.length > 14 ? r.datas.slice(0, 12).map(fmtData).join(', ') + ` … ${fmtData(r.datas.at(-1))}` : r.datas.map(fmtData).join(', ');
      blocos.push(`<div class="bloco"><strong>${r.datas.length} dia(s) reconhecido(s):</strong> ${lista}`
        + (campos.I.trim() && !r.horarios.length ? '<br><span class="sutil">Horário não reconhecido: conflitos serão avaliados para o dia inteiro.</span>' : '') + '</div>');
      // Conflitos deste evento com os demais.
      const ev = estado.editando;
      if (participaDeConflito(ev)) {
        const achados = calcularConflitos(estado.dados.eventos).filter((c) => c.a === ev || c.b === ev);
        if (achados.length) {
          blocos.push('<div class="bloco erro"><strong>⚠ Conflito de ambiente:</strong><br>' + achados.map((c) => {
            const o = c.a === ev ? c.b : c.a;
            return `${fmtData(c.data)} — ${esc(o.campos.C)} (${esc(o.campos.I || 'sem horário')})`;
          }).join('<br>') + '</div>');
        }
      }
    }
    $('#previa').innerHTML = blocos.join('');
  }, 250);
}

function eventoPorLinha(linha) {
  return estado.dados.eventos.find((e) => e.linha === Number(linha));
}

// ---------- lista de eventos de um período ----------
// Período, horário e local aparecem como estão na planilha.
function itensLista(de, ate, comVirtual, comExternos, comSuspensos) {
  return estado.dados.eventos
    .filter((ev) => (comVirtual || !ev.virtual) && (comExternos || !externo(ev)) && (comSuspensos || !ev.suspenso)
      && ev.datas.some((d) => d >= de && d <= ate))
    .sort((a, b) => a.datas[0].localeCompare(b.datas[0]) || a.campos.I.localeCompare(b.campos.I))
    .map((ev) => ({
      linha: ev.linha,
      quando: `${ev.campos.A.replace(/\s*\n\s*/g, ' ').trim()} · ${ev.campos.I.replace(/\s*\n\s*/g, ' ').trim() || 'horário não informado'}`,
      nome: ev.campos.C.trim() || '(sem nome)',
      local: ev.campos.N.replace(/\s*\n\s*/g, ' ').trim() || SEM_LOCAL,
    }));
}

function tituloLista() {
  const br = (d) => d.split('-').reverse().join('/');
  const n = estado.lista.length;
  return `Eventos de ${br($('#listaDe').value)} a ${br($('#listaAte').value)} — ${n} evento${n === 1 ? '' : 's'}`;
}

function textoLista() {
  return [tituloLista(), ...estado.lista.map((i) => `${i.quando}\n${i.nome}\n${i.local}`)].join('\n\n');
}

function gerarLista() {
  const de = $('#listaDe').value;
  const ate = $('#listaAte').value;
  if (!estado.dados || !de || !ate) return;
  if (de > ate) { aviso('A data inicial deve ser anterior à final.', true); return; }
  estado.lista = itensLista(de, ate, $('#listaVirtual').checked, $('#listaExternos').checked, $('#listaSuspensos').checked);
  $('#resultadoLista').innerHTML = `<h3>${esc(tituloLista())}</h3>` + (estado.lista.length
    ? estado.lista.map((i) => `<div class="item-lista"><div class="quando">${esc(i.quando)}</div>`
      + `<a data-linha="${i.linha}">${esc(i.nome)}</a><div class="sutil">${esc(i.local)}</div></div>`).join('')
    : '<p class="sutil">Nenhum evento neste período.</p>');
  $('#copiarLista').disabled = $('#imprimirLista').disabled = !estado.lista.length;
}

function abrirLista() {
  if (!$('#listaDe').value) {
    const ultimo = new Date(estado.ano, estado.mes + 1, 0).getDate();
    $('#listaDe').value = iso(estado.ano, estado.mes, 1);
    $('#listaAte').value = iso(estado.ano, estado.mes, ultimo);
  }
  $('#lista').showModal();
}

async function copiarLista() {
  try { await navigator.clipboard.writeText(textoLista()); aviso('Lista copiada. Cole onde quiser.'); }
  catch { aviso('Não consegui copiar automaticamente. Selecione o texto da lista e copie.', true); }
}

function imprimirLista() {
  const janela = window.open('', '_blank');
  if (!janela) { aviso('O navegador bloqueou a janela de impressão. Permita pop-ups para localhost.', true); return; }
  janela.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(tituloLista())}</title>`
    + '<style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#000}h1{font-size:17px}'
    + '.item{margin:0 0 14px;break-inside:avoid}.quando{font-weight:600}.local{color:#444}</style></head><body>'
    + `<h1>${esc(tituloLista())}</h1>`
    + estado.lista.map((i) => `<div class="item"><div class="quando">${esc(i.quando)}</div><div>${esc(i.nome)}</div><div class="local">${esc(i.local)}</div></div>`).join('')
    + '</body></html>');
  janela.document.close();
  janela.focus();
  janela.print();
}

// ---------- exportação para Google Agenda (.ics) ----------
// Remove links e dados de acesso a reuniões (Zoom, Meet, Teams…) por segurança.
const LINHA_SIGILOSA = /senha|passcode|password|id da reuni|meeting id/i;
const LINK = /\b(?:https?:\/\/|www\.)\S+|\b\S*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com)\S*/gi;
function semLinks(texto) {
  return String(texto ?? '').split('\n').filter((l) => !LINHA_SIGILOSA.test(l))
    .map((l) => l.replace(LINK, '').replace(/\s{2,}/g, ' ').trim()).filter(Boolean).join('\n');
}

function icsTexto(t) {
  return t.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
// Quebra linhas longas em até 75 bytes, como pede o formato.
function icsLinha(linha) {
  const cod = new TextEncoder();
  const partes = [];
  let atual = '';
  for (const ch of linha) {
    if (cod.encode(atual + ch).length > (partes.length ? 74 : 75)) { partes.push(atual); atual = ''; }
    atual += ch;
  }
  partes.push(atual);
  return partes.join('\r\n ');
}
const icsData = (d) => d.replace(/-/g, '');
function icsHora(d, minutos) {
  return `${icsData(d)}T${String(Math.floor(minutos / 60)).padStart(2, '0')}${String(minutos % 60).padStart(2, '0')}00`;
}
function diaSeguinte(d) {
  const [a, m, dia] = d.split('-').map(Number);
  const dt = new Date(a, m - 1, dia + 1);
  return iso(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

function descricaoIcs(ev) {
  const c = ev.campos;
  const linhas = [
    ['PROAD', c.B], ['Modalidade', c.M], ['Carga horária', c.K], ['Instrutor', c.G],
    ['Período', c.A], ['Horário', c.I], ['Situação', c.O],
  ].map(([rotulo, valor]) => [rotulo, semLinks(valor).replace(/\n/g, ' ')]).filter(([, v]) => v);
  return linhas.map(([r, v]) => `${r}: ${v}`).join('\n');
}

// Um compromisso por dia e por horário; EaD e externos de vários dias sem horário viram um bloco único.
function compromissosIcs(ev, de, ate) {
  const datas = ev.datas.filter((d) => d >= de && d <= ate);
  if (!datas.length) return [];
  if ((ev.virtual || externo(ev)) && ev.datas.length > 1 && !ev.horarios.length) {
    return [{ uid: `${ev.linha}-bloco`, inicio: ['DATE', icsData(ev.datas[0])], fim: ['DATE', icsData(diaSeguinte(ev.datas.at(-1)))] }];
  }
  return datas.flatMap((d) => (ev.horarios.length
    ? ev.horarios.map(([i, f], n) => ({ uid: `${ev.linha}-${icsData(d)}-${n}`, inicio: ['HORA', icsHora(d, i)], fim: ['HORA', icsHora(d, f)] }))
    : [{ uid: `${ev.linha}-${icsData(d)}`, inicio: ['DATE', icsData(d)], fim: ['DATE', icsData(diaSeguinte(d))] }]));
}

function opcoesExportar() {
  const periodo = document.querySelector('input[name=expAlcance]:checked').value === 'periodo';
  return {
    de: periodo ? $('#expDe').value : '0000-00-00',
    ate: periodo ? $('#expAte').value : '9999-99-99',
    periodo,
    virtual: $('#expVirtual').checked,
    externos: $('#expExternos').checked,
    suspensos: $('#expSuspensos').checked,
  };
}

function eventosExportar(o) {
  return estado.dados.eventos.filter((ev) => (o.virtual || !ev.virtual) && (o.externos || !externo(ev)) && (o.suspensos || !ev.suspenso));
}

function resumoExportar() {
  const o = opcoesExportar();
  const evs = eventosExportar(o);
  const comData = evs.filter((ev) => ev.datas.some((d) => d >= o.de && d <= o.ate));
  const semData = evs.filter((ev) => !ev.datas.length && (!o.periodo || mesesDoPeriodo(o.de, o.ate).has(ev.mes_bloco)));
  $('#resumoExportar').textContent = `${comData.length} evento(s) serão exportados.`
    + (semData.length ? ` ${semData.length} evento(s) sem data reconhecida ficam de fora:` : '');
  $('#expSemData').hidden = !semData.length;
  $('#expQtdSemData').textContent = semData.length;
  $('#expListaSemData').innerHTML = semData.map((ev) => `<li><a data-linha="${ev.linha}">${esc(ev.campos.C || '(sem nome)')}</a>`
    + `<br><span class="sutil">Linha ${ev.linha} · Período: ${esc(ev.campos.A || 'vazio')}</span></li>`).join('');
}

// Meses (1–12) tocados pelo período escolhido, para achar os eventos sem data do bloco desses meses.
function mesesDoPeriodo(de, ate) {
  const meses = new Set();
  if (!de || !ate || de > ate) return meses;
  let [a, m] = de.split('-').map(Number);
  const [aFim, mFim] = ate.split('-').map(Number);
  while (a < aFim || (a === aFim && m <= mFim)) {
    meses.add(m);
    if (++m > 12) { m = 1; a++; }
  }
  return meses;
}

function gerarIcs(o) {
  const agora = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const linhas = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//EJud-13//Calendario PAC//PT-BR', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', 'X-WR-CALNAME:PAC EJud-13', 'X-WR-TIMEZONE:America/Fortaleza',
    'BEGIN:VTIMEZONE', 'TZID:America/Fortaleza', 'BEGIN:STANDARD', 'DTSTART:19700101T000000',
    'TZOFFSETFROM:-0300', 'TZOFFSETTO:-0300', 'TZNAME:-03', 'END:STANDARD', 'END:VTIMEZONE'];
  let total = 0;
  for (const ev of eventosExportar(o)) {
    const titulo = semLinks(ev.campos.C).replace(/\n/g, ' ') || '(sem nome)';
    const local = semLinks(ev.campos.N).replace(/\n/g, ' ') || SEM_LOCAL;
    for (const c of compromissosIcs(ev, o.de, o.ate)) {
      const quando = ([nome, [tipo, valor]]) => (tipo === 'DATE' ? `${nome};VALUE=DATE:${valor}` : `${nome};TZID=America/Fortaleza:${valor}`);
      linhas.push('BEGIN:VEVENT', `UID:pac-${c.uid}@ejud13-calendario`, `DTSTAMP:${agora}`,
        quando(['DTSTART', c.inicio]), quando(['DTEND', c.fim]),
        `SUMMARY:${icsTexto((ev.suspenso ? '[SUSPENSO] ' : '') + titulo)}`,
        `LOCATION:${icsTexto(local)}`, `DESCRIPTION:${icsTexto(descricaoIcs(ev))}`,
        'TRANSP:TRANSPARENT', 'END:VEVENT');
      total++;
    }
  }
  linhas.push('END:VCALENDAR');
  return { texto: linhas.map(icsLinha).join('\r\n') + '\r\n', total };
}

function abrirExportar() {
  if (!$('#expDe').value) {
    $('#expDe').value = iso(estado.ano, estado.mes, 1);
    $('#expAte').value = iso(estado.ano, estado.mes, new Date(estado.ano, estado.mes + 1, 0).getDate());
  }
  resumoExportar();
  $('#exportar').showModal();
}

function baixarIcs() {
  if (!estado.dados) return;
  const o = opcoesExportar();
  if (o.periodo && (!o.de || !o.ate || o.de > o.ate)) { aviso('Escolha um período válido (a data inicial deve ser anterior à final).', true); return; }
  const { texto, total } = gerarIcs(o);
  if (!total) { aviso('Nenhum evento para exportar com essas opções.', true); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([texto], { type: 'text/calendar;charset=utf-8' }));
  a.download = o.periodo ? `PAC-EJud13-${o.de}-a-${o.ate}.ics` : 'PAC-EJud13-agenda.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  aviso(`Arquivo baixado com ${total} compromisso(s). Importe-o no Google Agenda.`);
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
  if (alvo) { const ev = eventoPorLinha(alvo.dataset.linha); if (ev) abrirModal(ev); }
});

$('#mesAnterior').onclick = () => mudarMes(-1);
$('#mesSeguinte').onclick = () => mudarMes(1);
$('#hoje').onclick = () => { const h = new Date(); estado.ano = h.getFullYear(); estado.mes = h.getMonth(); render(); };
document.querySelectorAll('.alternador button').forEach((b) => { b.onclick = () => { estado.vista = b.dataset.vista; gravarPref('vista', estado.vista); render(); }; });
$('#abrirPlanilha').onclick = () => $('#arquivoPlanilha').click();
$('#arquivoPlanilha').onchange = (e) => abrirPlanilha(e.target.files[0]);
$('#filtroAmbiente').onchange = (e) => { estado.filtroAmbiente = e.target.value; render(); };
$('#filtroBusca').oninput = (e) => { estado.busca = e.target.value.trim().toLowerCase(); render(); };
$('#filtroVirtual').checked = estado.mostrarVirtual;
$('#filtroVirtual').onchange = (e) => { estado.mostrarVirtual = e.target.checked; gravarPref('virtual', e.target.checked ? '1' : '0'); render(); };
$('#filtroExternos').checked = estado.mostrarExternos;
$('#filtroExternos').onchange = (e) => { estado.mostrarExternos = e.target.checked; gravarPref('externos', e.target.checked ? '1' : '0'); render(); };
$('#filtroSuspensos').onchange = (e) => { estado.mostrarSuspensos = e.target.checked; render(); };
$('#abrirAjuda').onclick = () => $('#ajuda').showModal();
$('#abrirLista').onclick = abrirLista;
$('#formLista').onsubmit = (e) => { e.preventDefault(); gerarLista(); };
$('#copiarLista').onclick = copiarLista;
$('#imprimirLista').onclick = imprimirLista;
$('#abrirExportar').onclick = abrirExportar;
$('#formExportar').onsubmit = (e) => { e.preventDefault(); baixarIcs(); };
$('#formExportar').onchange = resumoExportar;
document.querySelectorAll('[data-fechar-exportar]').forEach((b) => { b.onclick = () => $('#exportar').close(); });
document.querySelectorAll('[data-fechar-lista]').forEach((b) => { b.onclick = () => $('#lista').close(); });
document.querySelectorAll('[data-fechar-ajuda]').forEach((b) => { b.onclick = () => $('#ajuda').close(); });
$('#ajuda').addEventListener('close', () => gravarPref('ajudaVista', '1'));
document.addEventListener('keydown', (e) => {
  if ($('#modal').open || $('#ajuda').open || $('#lista').open || $('#exportar').open || e.target.matches('input, textarea, select')) return;
  if (e.key === 'ArrowLeft') mudarMes(-1);
  if (e.key === 'ArrowRight') mudarMes(1);
});
// Recarrega ao voltar para a aba, caso outra janela tenha aberto uma planilha nova.
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#modal').open) carregar(); });

const params = new URLSearchParams(location.search);
if (params.get('mes')) estado.mes = Math.min(11, Math.max(0, Number(params.get('mes')) - 1));
if (params.get('vista')) estado.vista = params.get('vista');
$('#vista').innerHTML = '<div class="carregando">Carregando planilha…</div>';
carregar();
if (lerPref('ajudaVista', '0') !== '1') $('#ajuda').showModal();
