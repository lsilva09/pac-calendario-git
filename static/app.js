'use strict';

const NOMES_MES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho',
  'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const SEM_LOCAL = 'sem-local';
const TIPOS_LOCAL = { fisico: 'Físico', virtual: 'Virtual', externo: 'Externo' };
// [campo, rótulo, classe, datalist]
const CAMPOS = [
  ['nome', 'EVENTO', 'largo', null, 'textarea'],
  ['proad', 'PROAD'], ['area', 'ÁREA', '', 'dlAreas'], ['origem', 'ORIGEM DOS RECURSOS', '', 'dlOrigens'],
  ['modalidade', 'MODALIDADE', '', 'dlModalidades'], ['carga_horaria', 'CARGA HORÁRIA'], ['diarias', 'DIÁRIAS?'],
  ['instrutor', 'INSTRUTOR / CONTEUDISTA / TUTOR', 'duplo'], ['parceria', 'PARCERIA'],
  ['publico', 'PÚBLICO ALVO', 'duplo'], ['situacao', 'SITUAÇÃO', '', 'dlSituacoes'],
  ['observacoes', 'OBSERVAÇÕES', 'largo', null, 'textarea'],
];

const estado = {
  dados: null,
  ano: 2026,
  mes: new Date().getMonth(),
  vista: lerPref('vista', 'ambiente'),
  filtroAmbiente: '',
  busca: '',
  mostrarVirtual: lerPref('virtual', '1') === '1',
  mostrarSuspensos: true,
  todoAno: false,
  editando: null,
};

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function lerPref(k, padrao) {
  try { return localStorage.getItem('pac2.' + k) ?? padrao; } catch { return padrao; }
}
function gravarPref(k, v) {
  try { localStorage.setItem('pac2.' + k, v); } catch { /* sem armazenamento */ }
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function iso(a, m, d) {
  return `${a}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function fmtData(s) { return `${s.slice(8, 10)}/${s.slice(5, 7)}`; }
function hojeIso() { const h = new Date(); return iso(h.getFullYear(), h.getMonth(), h.getDate()); }
function diaSemana(s) { return DIAS_SEMANA[new Date(s + 'T12:00').getDay()]; }
function minutos(h) { const [a, b] = h.split(':'); return Number(a) * 60 + Number(b); }
function fmtHora(h) { return h ? h.replace(':00', 'h').replace(':', 'h') : ''; }
function faixa(s) { return s.inicio ? `${fmtHora(s.inicio)}–${fmtHora(s.fim)}` : ''; }

const PALETA = ['#2f6fd6', '#d9480f', '#2b8a3e', '#ae3ec9', '#c2255c', '#0c8599', '#e67700',
  '#5f3dc4', '#5c940d', '#1864ab', '#a61e4d', '#087f5b', '#862e9c', '#b35900'];
function cor(id) { return id ? PALETA[id % PALETA.length] : '#868e96'; }

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

// ---------- dados derivados ----------
function aplicarDados(d) {
  estado.dados = d;
  estado.locais = new Map(d.locais.map((l) => [l.id, l]));
  for (const ev of d.eventos) {
    ev.suspenso = /suspens|cancelad/i.test(ev.situacao);
    ev.virtualMod = /ead|online|telepresencial/i.test(ev.modalidade) && !/híbrido|hibrido/i.test(ev.modalidade);
    ev.datas = [...new Set(ev.sessoes.map((s) => s.data))].sort();
    ev.texto = [ev.nome, ev.proad, ev.instrutor, ev.publico, ev.parceria, ev.area, ev.modalidade, ev.situacao, ev.observacoes,
      ...ev.sessoes.map((s) => estado.locais.get(s.local_id)?.nome || '')].join(' ').toLowerCase();
  }
  $('#resumo').textContent = `${d.eventos.length} eventos · ${d.locais.filter((l) => l.ativo).length} locais ativos`;
  preencherListas();
  render();
  abrirPorUrl();
}

async function carregar() {
  try {
    aplicarDados(await api('GET', '/api/dados'));
  } catch (e) {
    $('#vista').innerHTML = `<div class="carregando">${esc(e.message)}</div>`;
  }
}

function tipoSessao(s, ev) {
  const l = estado.locais.get(s.local_id);
  if (l) return l.tipo;
  return ev.virtualMod ? 'virtual' : 'sem';
}

function sessaoVisivel(s, ev) {
  if (!estado.mostrarVirtual && tipoSessao(s, ev) === 'virtual') return false;
  if (estado.filtroAmbiente) {
    if (estado.filtroAmbiente === SEM_LOCAL) return !s.local_id;
    return String(s.local_id) === estado.filtroAmbiente;
  }
  return true;
}

function eventoVisivel(ev) {
  if (!estado.mostrarSuspensos && ev.suspenso) return false;
  if (estado.busca && !estado.busca.split(/\s+/).every((p) => ev.texto.includes(p))) return false;
  return true;
}

function sobrepoe(a, b) {
  if (!a.inicio || !b.inicio) return true;
  return minutos(a.inicio) < minutos(b.fim) && minutos(b.inicio) < minutos(a.fim);
}

// Lista de conflitos entre sessões de eventos diferentes no mesmo local físico.
function calcularConflitos(eventos) {
  const grupos = new Map();
  for (const ev of eventos) {
    if (ev.suspenso) continue;
    for (const s of ev.sessoes) {
      if (estado.locais.get(s.local_id)?.tipo !== 'fisico') continue;
      const k = s.data + '|' + s.local_id;
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push({ ev, s });
    }
  }
  const out = [];
  for (const lista of grupos.values()) {
    for (let i = 0; i < lista.length; i++) {
      for (let j = i + 1; j < lista.length; j++) {
        const a = lista[i], b = lista[j];
        if (a.ev === b.ev || !sobrepoe(a.s, b.s)) continue;
        out.push({ data: a.s.data, local_id: a.s.local_id, a, b });
      }
    }
  }
  return out.sort((x, y) => x.data.localeCompare(y.data));
}

// ---------- renderização ----------
function render() {
  if (!estado.dados) return;
  $('#tituloMes').textContent = `${NOMES_MES[estado.mes]} ${estado.ano}`;
  $$('.alternador button').forEach((b) => b.classList.toggle('ativo', b.dataset.vista === estado.vista));
  $('#rotuloTodoAno').hidden = estado.vista !== 'lista';
  const prefixo = iso(estado.ano, estado.mes, 1).slice(0, 7);
  const conflitos = calcularConflitos(estado.dados.eventos).filter((c) => c.data.startsWith(prefixo));
  const marcados = new Set();
  const celulas = new Set();
  for (const c of conflitos) {
    marcados.add(c.a.ev.id + '|' + c.data + '|' + c.local_id);
    marcados.add(c.b.ev.id + '|' + c.data + '|' + c.local_id);
    celulas.add(c.data + '|' + c.local_id);
    celulas.add(c.data);
  }
  const ctx = { prefixo, marcados, celulas, eventos: estado.dados.eventos.filter(eventoVisivel) };
  if (estado.vista === 'mes') renderMes(ctx);
  else if (estado.vista === 'lista') renderLista(ctx);
  else renderAmbientes(ctx);
  renderLateral(conflitos);
}

// Agrupa as sessões visíveis do mês: chave -> [{ev, sessoes}]
function agrupar(ctx, chaveFn) {
  const mapa = new Map();
  for (const ev of ctx.eventos) {
    for (const s of ev.sessoes) {
      if (!s.data.startsWith(ctx.prefixo) || !sessaoVisivel(s, ev)) continue;
      const k = chaveFn(s, ev);
      if (!mapa.has(k)) mapa.set(k, new Map());
      const porEv = mapa.get(k);
      if (!porEv.has(ev.id)) porEv.set(ev.id, { ev, sessoes: [] });
      porEv.get(ev.id).sessoes.push(s);
    }
  }
  return mapa;
}

function chip({ ev, sessoes }, ctx, mostrarLocal) {
  const s0 = sessoes[0];
  const classes = ['chip'];
  if (tipoSessao(s0, ev) === 'virtual') classes.push('virtual');
  if (ev.suspenso) classes.push('suspenso');
  if (ev.revisar) classes.push('revisar');
  if (sessoes.some((s) => ctx.marcados.has(ev.id + '|' + s.data + '|' + s.local_id))) classes.push('em-conflito');
  const horas = [...new Set(sessoes.map(faixa).filter(Boolean))].join(', ');
  const locais = [...new Set(sessoes.map((s) => estado.locais.get(s.local_id)?.nome || 'sem local'))].join(' / ');
  const extra = [horas, mostrarLocal ? locais : ''].filter(Boolean).join(' · ');
  const titulo = `${ev.nome}\n${horas || 'sem horário'}\n${locais}`;
  return `<button type="button" class="${classes.join(' ')}" style="--cor:${cor(s0.local_id)}" data-evento="${ev.id}" title="${esc(titulo)}">`
    + `<span class="t">${esc(ev.nome)}</span>${extra ? `<span class="h">${esc(extra)}</span>` : ''}</button>`;
}

function porHorario(a, b) {
  return (a.sessoes[0].inicio || '99').localeCompare(b.sessoes[0].inicio || '99') || a.ev.nome.localeCompare(b.ev.nome);
}

function renderAmbientes(ctx) {
  const dias = new Date(estado.ano, estado.mes + 1, 0).getDate();
  const hoje = hojeIso();
  const mapa = agrupar(ctx, (s) => s.data + '|' + (s.local_id || SEM_LOCAL));
  const usados = new Map();
  for (const k of mapa.keys()) {
    const lid = k.split('|')[1];
    usados.set(lid, (usados.get(lid) || 0) + mapa.get(k).size);
  }
  const ordem = { fisico: 0, externo: 1, sem: 2, virtual: 3 };
  const secoes = { 0: 'Ambientes físicos', 1: 'Locais externos', 2: 'Sem local definido', 3: 'EaD / online' };
  const linhas = [...usados.keys()].map((lid) => {
    const l = estado.locais.get(Number(lid));
    return { lid, nome: l ? l.nome : 'Sem local definido', grupo: ordem[l ? l.tipo : 'sem'], n: usados.get(lid) };
  }).sort((a, b) => a.grupo - b.grupo || b.n - a.n || a.nome.localeCompare(b.nome));
  if (!linhas.length) {
    $('#vista').innerHTML = '<div class="carregando">Nenhum evento neste mês para os filtros atuais.</div>';
    return;
  }
  let h = `<table class="ambientes" style="width:${210 + 108 * dias}px"><thead><tr><th class="nome">Ambiente</th>`;
  for (let d = 1; d <= dias; d++) {
    const dt = new Date(estado.ano, estado.mes, d);
    const cls = [dt.getDay() % 6 === 0 ? 'fds' : '', iso(estado.ano, estado.mes, d) === hoje ? 'hoje' : ''].join(' ');
    h += `<th class="${cls}"><span class="dia">${d}</span>${DIAS_SEMANA[dt.getDay()]}</th>`;
  }
  h += '</tr></thead><tbody>';
  let grupoAtual = -1;
  for (const ln of linhas) {
    if (ln.grupo !== grupoAtual) {
      grupoAtual = ln.grupo;
      h += `<tr class="grupo"><th>${secoes[ln.grupo]}</th><td colspan="${dias}"></td></tr>`;
    }
    const idNum = ln.lid === SEM_LOCAL ? null : Number(ln.lid);
    h += `<tr><th class="nome" style="--cor:${cor(idNum)}"><span class="bolinha"></span>${esc(ln.nome)}</th>`;
    for (let d = 1; d <= dias; d++) {
      const data = iso(estado.ano, estado.mes, d);
      const dt = new Date(estado.ano, estado.mes, d);
      const itens = [...(mapa.get(data + '|' + ln.lid)?.values() || [])].sort(porHorario);
      const cls = [dt.getDay() % 6 === 0 ? 'fds' : '', data === hoje ? 'hoje' : '',
        ctx.celulas.has(data + '|' + idNum) ? 'conflito' : ''].join(' ');
      h += `<td class="${cls}" data-data="${data}" data-local="${idNum ?? ''}">${itens.map((it) => chip(it, ctx, false)).join('')}</td>`;
    }
    h += '</tr>';
  }
  $('#vista').innerHTML = h + '</tbody></table>';
}

function renderMes(ctx) {
  const mapa = agrupar(ctx, (s) => s.data);
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
    const itens = fora ? [] : [...(mapa.get(data)?.values() || [])].sort(porHorario);
    const conflito = !fora && ctx.celulas.has(data);
    const cls = ['dia', fora ? 'fora' : '', dt.getDay() % 6 === 0 ? 'fds' : '', data === hoje ? 'hoje' : '', conflito ? 'conflito' : ''].join(' ');
    h += `<div class="${cls}" data-data="${fora ? '' : data}"><div class="num"><span>${dt.getDate()}</span>`
      + (conflito ? '<span class="alerta">⚠ conflito</span>' : '') + '</div>'
      + itens.map((it) => chip(it, ctx, true)).join('') + '</div>';
  }
  $('#vista').innerHTML = h + '</div>';
}

function textoDatas(datas) {
  if (!datas.length) return '—';
  if (datas.length <= 4) return datas.map(fmtData).join(', ');
  return `${fmtData(datas[0])} a ${fmtData(datas.at(-1))} (${datas.length} dias)`;
}

function renderLista(ctx) {
  const evs = ctx.eventos.filter((ev) => {
    const ss = ev.sessoes.filter((s) => sessaoVisivel(s, ev) && (estado.todoAno || s.data.startsWith(ctx.prefixo)));
    if (ss.length) return true;
    // Eventos sem data aparecem no mês de referência (ou sempre, no ano inteiro).
    return !ev.sessoes.length && !estado.filtroAmbiente && (estado.todoAno || ev.mes_referencia === estado.mes + 1);
  }).sort((a, b) => (a.datas[0] || '9999').localeCompare(b.datas[0] || '9999') || a.nome.localeCompare(b.nome));
  if (!evs.length) {
    $('#vista').innerHTML = '<div class="carregando">Nenhum evento para os filtros atuais.</div>';
    return;
  }
  const conflEv = new Set(calcularConflitos(estado.dados.eventos).flatMap((c) => [c.a.ev.id, c.b.ev.id]));
  let h = '<table class="tabela"><thead><tr><th>Datas</th><th>Evento</th><th>Local(is)</th><th>Horário</th><th>Modalidade</th><th>Situação</th></tr></thead><tbody>';
  for (const ev of evs) {
    const locais = [...new Set(ev.sessoes.map((s) => estado.locais.get(s.local_id)?.nome).filter(Boolean))];
    const horas = [...new Set(ev.sessoes.map(faixa).filter(Boolean))];
    const tags = (ev.revisar ? '<span class="etiqueta alerta">⚠ revisar</span>' : '')
      + (conflEv.has(ev.id) ? '<span class="etiqueta perigo">conflito</span>' : '');
    h += `<tr class="clicavel${ev.suspenso ? ' suspenso' : ''}" data-evento="${ev.id}"><td>${esc(textoDatas(ev.datas))}</td>`
      + `<td>${esc(ev.nome)} ${tags}</td><td>${locais.map((l) => `<span class="etiqueta">${esc(l)}</span>`).join('') || '—'}</td>`
      + `<td>${esc(horas.slice(0, 3).join(', ') + (horas.length > 3 ? '…' : '')) || '—'}</td>`
      + `<td>${esc(ev.modalidade)}</td><td>${esc(ev.situacao)}</td></tr>`;
  }
  $('#vista').innerHTML = h + '</tbody></table>';
}

function renderLateral(conflitos) {
  const nomeLocal = (id) => estado.locais.get(id)?.nome || '';
  $('#qtdConflitos').textContent = conflitos.length;
  $('#qtdConflitos').classList.toggle('tem', conflitos.length > 0);
  $('#listaConflitos').innerHTML = conflitos.length ? conflitos.map((c) => `<li class="conflito"><strong>${fmtData(c.data)}</strong> · ${esc(nomeLocal(c.local_id))}<br>`
    + `<a data-evento="${c.a.ev.id}">${esc(c.a.ev.nome)}</a> <span class="sutil">(${esc(faixa(c.a.s) || 'sem horário')})</span><br>`
    + `<a data-evento="${c.b.ev.id}">${esc(c.b.ev.nome)}</a> <span class="sutil">(${esc(faixa(c.b.s) || 'sem horário')})</span></li>`).join('')
    : '<li class="vazio">Nenhum conflito neste mês.</li>';

  const semData = estado.dados.eventos.filter((ev) => !ev.sessoes.length && ev.mes_referencia === estado.mes + 1 && eventoVisivel(ev));
  $('#qtdSemData').textContent = semData.length;
  $('#listaSemData').innerHTML = semData.length ? semData.map((ev) => `<li><a data-evento="${ev.id}">${esc(ev.nome)}</a></li>`).join('')
    : '<li class="vazio">Todos os eventos deste mês têm datas.</li>';

  const revisar = estado.dados.eventos.filter((ev) => ev.revisar);
  $('#qtdRevisar').textContent = revisar.length;
  $('#listaRevisar').innerHTML = revisar.length ? revisar.map((ev) => `<li class="revisar"><a data-evento="${ev.id}">${esc(ev.nome)}</a>`
    + `<br><span class="sutil">${esc(textoDatas(ev.datas))}</span></li>`).join('')
    : '<li class="vazio">Nada a revisar.</li>';
}

function preencherListas() {
  const evs = estado.dados.eventos;
  const unicos = (campo) => {
    const m = new Map();
    for (const ev of evs) { const v = ev[campo].trim(); if (v) m.set(v, (m.get(v) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  };
  for (const [campo, id] of [['modalidade', 'dlModalidades'], ['area', 'dlAreas'], ['origem', 'dlOrigens'], ['situacao', 'dlSituacoes']]) {
    $('#' + id).innerHTML = unicos(campo).map((v) => `<option value="${esc(v)}">`).join('');
  }
  const sel = $('#filtroAmbiente');
  const atual = estado.filtroAmbiente;
  const grupos = Object.entries(TIPOS_LOCAL).map(([tipo, rotulo]) => {
    const ls = estado.dados.locais.filter((l) => l.tipo === tipo && (l.ativo || l.eventos));
    return ls.length ? `<optgroup label="${rotulo}">${ls.map((l) => `<option value="${l.id}">${esc(l.nome)}</option>`).join('')}</optgroup>` : '';
  }).join('');
  sel.innerHTML = `<option value="">Todos os ambientes</option>${grupos}<option value="${SEM_LOCAL}">Sem local definido</option>`;
  sel.value = $$('option', sel).some((o) => o.value === atual) ? atual : '';
  estado.filtroAmbiente = sel.value;
}

// ---------- formulário de evento ----------
function opcoesLocal(selecionado) {
  const sel = selecionado == null ? '' : String(selecionado);
  const grupos = Object.entries(TIPOS_LOCAL).map(([tipo, rotulo]) => {
    const ls = estado.dados.locais.filter((l) => l.tipo === tipo && (l.ativo || String(l.id) === sel));
    return ls.length ? `<optgroup label="${rotulo}">${ls.map((l) => `<option value="${l.id}"${String(l.id) === sel ? ' selected' : ''}>`
      + `${esc(l.nome)}${l.ativo ? '' : ' (inativo)'}</option>`).join('')}</optgroup>` : '';
  }).join('');
  return `<option value="">— sem local —</option>${grupos}`;
}

function linhaSessao(s = {}) {
  return `<tr><td><input type="date" name="data" value="${esc(s.data || '')}" required></td>`
    + `<td class="semana">${s.data ? diaSemana(s.data) : ''}</td>`
    + `<td><input type="time" name="inicio" value="${esc(s.inicio || '')}"></td>`
    + `<td><input type="time" name="fim" value="${esc(s.fim || '')}"></td>`
    + `<td><select name="local_id">${opcoesLocal(s.local_id)}</select></td>`
    + '<td class="acoes-linha"><button type="button" class="icone" data-duplicar-linha title="Duplicar linha (outro turno ou outra sala no mesmo dia)">⧉</button> '
    + '<button type="button" class="icone" data-remover-linha title="Remover linha">×</button></td></tr>';
}

function abrirModal(ev, preset = {}) {
  estado.editando = ev;
  const base = ev || { nome: '', proad: '', area: '', origem: '', modalidade: '', carga_horaria: '', diarias: '', instrutor: '',
    parceria: '', publico: '', situacao: '', observacoes: '', mes_referencia: estado.mes + 1, sessoes: [] };
  const dados = { ...base, ...preset };
  $('#tituloModal').textContent = ev ? 'Editar evento' : 'Novo evento';
  $('#infoModal').textContent = ev ? (ev.linha_planilha ? `Importado da linha ${ev.linha_planilha} da planilha` : 'Criado no sistema') : '';
  $('#excluir').hidden = !ev;
  $('#duplicar').hidden = !ev;
  $('#caixaRevisar').innerHTML = ev?.revisar
    ? `<div class="aviso-revisar"><b>⚠ Conferir importação:</b>\n${esc(ev.revisar)}<pre>Texto original na planilha:\n${esc(ev.origem_planilha)}</pre>`
      + '<label><input type="checkbox" id="manterRevisao"> Manter marcado para revisar depois de salvar</label></div>'
    : '';
  $('#camposEvento').innerHTML = CAMPOS.map(([campo, rotulo, classe = '', lista, tipo]) => {
    const v = esc(dados[campo] ?? '');
    const el = tipo === 'textarea'
      ? `<textarea name="${campo}" rows="2">${v}</textarea>`
      : `<input name="${campo}" value="${v}"${lista ? ` list="${lista}"` : ''} autocomplete="off">`;
    return `<label class="${classe}">${rotulo}${el}</label>`;
  }).join('') + `<label>MÊS (enquanto não houver datas)<select name="mes_referencia">${NOMES_MES.map((m, i) =>
    `<option value="${i + 1}"${dados.mes_referencia === i + 1 ? ' selected' : ''}>${m}</option>`).join('')}</select></label>`;
  // Evento novo começa com uma linha em branco para a primeira data.
  const sessoes = dados.sessoes.length || ev ? dados.sessoes : [{}];
  $('#linhasSessoes').innerHTML = sessoes.map(linhaSessao).join('');
  $('#variasDatas').value = '';
  previa();
  $('#modal').showModal();
  $('#camposEvento [name=nome]').focus();
}

function lerSessoes() {
  return $$('#linhasSessoes tr').map((tr) => ({
    data: $('[name=data]', tr).value,
    inicio: $('[name=inicio]', tr).value,
    fim: $('[name=fim]', tr).value,
    local_id: $('[name=local_id]', tr).value ? Number($('[name=local_id]', tr).value) : null,
  }));
}

function lerEvento() {
  const f = new FormData($('#formEvento'));
  const ev = Object.fromEntries(CAMPOS.map(([c]) => [c, (f.get(c) ?? '').toString()]));
  ev.mes_referencia = Number(f.get('mes_referencia'));
  return ev;
}

function previa() {
  const sessoes = lerSessoes();
  const trs = $$('#linhasSessoes tr');
  trs.forEach((tr, i) => {
    $('.semana', tr).textContent = sessoes[i].data ? diaSemana(sessoes[i].data) : '';
    tr.classList.remove('em-conflito');
    tr.title = '';
  });
  const blocos = [];
  const validas = sessoes.filter((s) => s.data);
  if (!validas.length) {
    blocos.push('<div class="bloco alerta">Sem datas: o evento ficará na lista “Sem data” do mês escolhido.</div>');
  } else {
    const dias = new Set(validas.map((s) => s.data)).size;
    blocos.push(`<div class="bloco"><strong>${dias} dia(s), ${validas.length} sessão(ões).</strong></div>`);
    const ficticio = { id: estado.editando?.id ?? -1, nome: lerEvento().nome, situacao: lerEvento().situacao, sessoes: validas, suspenso: /suspens|cancelad/i.test(lerEvento().situacao) };
    const outros = estado.dados.eventos.filter((e) => e.id !== ficticio.id);
    const achados = calcularConflitos([ficticio, ...outros]).filter((c) => c.a.ev === ficticio || c.b.ev === ficticio);
    if (achados.length) {
      const linhas = [];
      for (const c of achados) {
        const meu = c.a.ev === ficticio ? c.a : c.b;
        const outro = c.a.ev === ficticio ? c.b : c.a;
        const idx = sessoes.indexOf(meu.s);
        if (idx >= 0) { trs[idx].classList.add('em-conflito'); trs[idx].title = `Conflito com: ${outro.ev.nome}`; }
        linhas.push(`${fmtData(c.data)} · ${esc(estado.locais.get(c.local_id)?.nome)} — ${esc(outro.ev.nome)} (${esc(faixa(outro.s) || 'sem horário')})`);
      }
      blocos.push(`<div class="bloco erro"><strong>⚠ Conflito de ambiente:</strong><br>${linhas.join('<br>')}</div>`);
    }
    const incompletas = sessoes.filter((s) => s.data && Boolean(s.inicio) !== Boolean(s.fim)).length;
    if (incompletas) blocos.push('<div class="bloco alerta">Há linhas com só início ou só fim preenchido.</div>');
  }
  $('#previa').innerHTML = blocos.join('');
}

async function salvar(e) {
  e.preventDefault();
  const evento = lerEvento();
  const sessoes = lerSessoes();
  if (sessoes.some((s) => !s.data)) { aviso('Há linhas sem data. Preencha a data ou remova a linha.', true); return; }
  const botao = $('#salvar');
  botao.disabled = true;
  try {
    const ev = estado.editando;
    const corpo = { evento, sessoes };
    const r = ev
      ? await api('PUT', `/api/eventos/${ev.id}`, { ...corpo, versao: ev.versao, manter_revisao: $('#manterRevisao')?.checked })
      : await api('POST', '/api/eventos', corpo);
    $('#modal').close();
    aplicarDados(r);
    aviso(ev ? 'Evento atualizado.' : 'Evento criado.');
  } catch (err) {
    aviso(err.message, true);
  } finally {
    botao.disabled = false;
  }
}

async function excluir() {
  const ev = estado.editando;
  if (!ev || !confirm(`Excluir “${ev.nome}”?\n\nO evento e todas as suas sessões serão removidos.`)) return;
  try {
    const r = await api('DELETE', `/api/eventos/${ev.id}`, { versao: ev.versao });
    $('#modal').close();
    aplicarDados(r);
    aviso('Evento excluído.');
  } catch (err) {
    aviso(err.message, true);
  }
}

function duplicar() {
  const dados = { ...lerEvento(), sessoes: lerSessoes() };
  $('#modal').close();
  abrirModal(null, dados);
  $('#tituloModal').textContent = 'Novo evento (cópia)';
}

async function adicionarVarias() {
  const texto = $('#variasDatas').value.trim();
  if (!texto) return;
  const r = await api('POST', '/api/interpretar', { texto });
  if (!r.datas.length) { aviso('Não reconheci datas. Exemplos: “09, 10 e 11/02” ou “06 a 10/04”.', true); return; }
  const modelo = lerSessoes().at(-1) || {};
  const existentes = new Set(lerSessoes().map((s) => s.data));
  const novas = r.datas.filter((d) => !existentes.has(d));
  $('#linhasSessoes').insertAdjacentHTML('beforeend', novas.map((d) => linhaSessao({ ...modelo, data: d })).join(''));
  $('#variasDatas').value = '';
  previa();
  aviso(`${novas.length} data(s) adicionada(s)` + (novas.length < r.datas.length ? ' (as repetidas foram ignoradas).' : '.'));
}

function aplicarTodas() {
  const trs = $$('#linhasSessoes tr');
  if (trs.length < 2) return;
  const [inicio, fim, local] = ['inicio', 'fim', 'local_id'].map((n) => $(`[name=${n}]`, trs[0]).value);
  for (const tr of trs.slice(1)) {
    $('[name=inicio]', tr).value = inicio;
    $('[name=fim]', tr).value = fim;
    $('[name=local_id]', tr).value = local;
  }
  previa();
}

// ---------- locais ----------
function renderLocais() {
  const ls = [...estado.dados.locais].sort((a, b) => a.tipo.localeCompare(b.tipo) || a.nome.localeCompare(b.nome));
  const linha = (l) => `<tr data-local-id="${l?.id ?? ''}" class="${l && !l.ativo ? 'inativo' : ''}">`
    + `<td><input type="text" name="nome" value="${esc(l?.nome || '')}" placeholder="Nome do novo local"></td>`
    + `<td><select name="tipo">${Object.entries(TIPOS_LOCAL).map(([v, r]) => `<option value="${v}"${(l?.tipo || 'fisico') === v ? ' selected' : ''}>${r}</option>`).join('')}</select></td>`
    + `<td><input type="checkbox" name="ativo"${!l || l.ativo ? ' checked' : ''}></td>`
    + `<td>${l ? l.eventos : ''}</td>`
    + `<td><button type="button" class="secundario" data-salvar-local>${l ? 'Salvar' : 'Adicionar'}</button>`
    + (l ? ` <button type="button" class="perigo" data-excluir-local${l.eventos ? ' disabled title="Em uso: desative em vez de excluir"' : ''}>Excluir</button>` : '') + '</td></tr>';
  $('#linhasLocais').innerHTML = ls.map(linha).join('') + linha(null);
}

async function salvarLocal(tr) {
  const id = tr.dataset.localId;
  const corpo = { nome: $('[name=nome]', tr).value, tipo: $('[name=tipo]', tr).value, ativo: $('[name=ativo]', tr).checked };
  try {
    const r = id ? await api('PUT', `/api/locais/${id}`, corpo) : await api('POST', '/api/locais', corpo);
    aplicarDados(r);
    renderLocais();
    aviso(id ? 'Local atualizado.' : 'Local adicionado.');
  } catch (err) { aviso(err.message, true); }
}

async function excluirLocal(tr) {
  const nome = $('[name=nome]', tr).value;
  if (!confirm(`Excluir o local “${nome}”?`)) return;
  try {
    aplicarDados(await api('DELETE', `/api/locais/${tr.dataset.localId}`));
    renderLocais();
    aviso('Local excluído.');
  } catch (err) { aviso(err.message, true); }
}

// ---------- eventos da página ----------
function mudarMes(delta) {
  estado.mes += delta;
  if (estado.mes < 0) { estado.mes = 11; estado.ano--; }
  if (estado.mes > 11) { estado.mes = 0; estado.ano++; }
  render();
}

function eventoPorId(id) { return estado.dados.eventos.find((e) => e.id === Number(id)); }

function abrirPorUrl() {
  const id = new URLSearchParams(location.search).get('evento');
  if (!id || abrirPorUrl.feito) return;
  abrirPorUrl.feito = true;
  const ev = eventoPorId(id);
  if (!ev) return;
  if (ev.datas.length) { estado.ano = Number(ev.datas[0].slice(0, 4)); estado.mes = Number(ev.datas[0].slice(5, 7)) - 1; render(); }
  if ($('#ajuda').open) $('#ajuda').close();
  abrirModal(ev);
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('[data-fechar]')) { t.closest('dialog').close(); return; }
  if (t.closest('[data-remover-linha]')) { t.closest('tr').remove(); previa(); return; }
  if (t.closest('[data-duplicar-linha]')) {
    const tr = t.closest('tr');
    const s = lerSessoes()[$$('#linhasSessoes tr').indexOf(tr)];
    tr.insertAdjacentHTML('afterend', linhaSessao(s));
    previa();
    return;
  }
  if (t.closest('[data-salvar-local]')) { salvarLocal(t.closest('tr')); return; }
  if (t.closest('[data-excluir-local]')) { excluirLocal(t.closest('tr')); return; }
  const alvo = t.closest('[data-evento]');
  if (alvo && !t.closest('dialog')) { const ev = eventoPorId(alvo.dataset.evento); if (ev) abrirModal(ev); return; }
  const celula = t.closest('#vista [data-data]');
  if (celula?.dataset.data && e.detail === 2) {
    const local = celula.dataset.local ? Number(celula.dataset.local) : null;
    abrirModal(null, { sessoes: [{ data: celula.dataset.data, inicio: '', fim: '', local_id: local }],
      mes_referencia: Number(celula.dataset.data.slice(5, 7)) });
  }
});

$('#formEvento').addEventListener('input', previa);
$('#formEvento').addEventListener('change', previa);
$('#formEvento').onsubmit = salvar;
$('#addSessao').onclick = () => {
  const ult = lerSessoes().at(-1);
  let data = '';
  if (ult?.data) { const d = new Date(ult.data + 'T12:00'); do { d.setDate(d.getDate() + 1); } while (d.getDay() % 6 === 0); data = d.toISOString().slice(0, 10); }
  $('#linhasSessoes').insertAdjacentHTML('beforeend', linhaSessao({ ...(ult || {}), data }));
  previa();
};
$('#addVarias').onclick = adicionarVarias;
$('#variasDatas').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); adicionarVarias(); } };
$('#aplicarTodas').onclick = aplicarTodas;
$('#excluir').onclick = excluir;
$('#duplicar').onclick = duplicar;
$('#abrirLocais').onclick = () => { renderLocais(); $('#modalLocais').showModal(); };
$('#abrirAjuda').onclick = () => $('#ajuda').showModal();
$('#ajuda').addEventListener('close', () => gravarPref('ajudaVista', '1'));
$('#mesAnterior').onclick = () => mudarMes(-1);
$('#mesSeguinte').onclick = () => mudarMes(1);
$('#hoje').onclick = () => { const h = new Date(); estado.ano = h.getFullYear(); estado.mes = h.getMonth(); render(); };
$$('.alternador button').forEach((b) => { b.onclick = () => { estado.vista = b.dataset.vista; gravarPref('vista', estado.vista); render(); }; });
$('#novo').onclick = () => abrirModal(null);
$('#filtroAmbiente').onchange = (e) => { estado.filtroAmbiente = e.target.value; render(); };
$('#filtroBusca').oninput = (e) => { estado.busca = e.target.value.trim().toLowerCase(); render(); };
$('#filtroVirtual').checked = estado.mostrarVirtual;
$('#filtroVirtual').onchange = (e) => { estado.mostrarVirtual = e.target.checked; gravarPref('virtual', e.target.checked ? '1' : '0'); render(); };
$('#filtroSuspensos').onchange = (e) => { estado.mostrarSuspensos = e.target.checked; render(); };
$('#filtroTodoAno').onchange = (e) => { estado.todoAno = e.target.checked; render(); };
document.addEventListener('keydown', (e) => {
  if ($$('dialog').some((d) => d.open) || e.target.matches('input, textarea, select')) return;
  if (e.key === 'ArrowLeft') mudarMes(-1);
  if (e.key === 'ArrowRight') mudarMes(1);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$$('dialog').some((d) => d.open)) carregar(); });

const params = new URLSearchParams(location.search);
if (params.get('mes')) estado.mes = Math.min(11, Math.max(0, Number(params.get('mes')) - 1));
if (params.get('vista')) estado.vista = params.get('vista');
$('#vista').innerHTML = '<div class="carregando">Carregando…</div>';
carregar();
if (lerPref('ajudaVista', '0') !== '1' && !params.get('evento')) $('#ajuda').showModal();
