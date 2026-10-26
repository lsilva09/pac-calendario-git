"""Banco de dados do Calendário PAC v2 (SQLite).

Um evento tem várias sessões; cada sessão tem data, horário e local próprios.
"""
import os
import re
import shutil
import sqlite3
import threading
from datetime import datetime, date

AQUI = os.path.dirname(os.path.abspath(__file__))
CAMINHO_DB = os.path.join(AQUI, 'dados', 'pac.db')
PASTA_BACKUPS = os.path.join(AQUI, 'backups')
MAX_BACKUPS = 50
INTERVALO_BACKUP = 30 * 60  # segundos entre backups automáticos

TIPOS_LOCAL = ('fisico', 'virtual', 'externo')
CAMPOS_EVENTO = ['nome', 'proad', 'area', 'origem', 'instrutor', 'parceria', 'diarias',
                 'carga_horaria', 'publico', 'modalidade', 'situacao', 'observacoes',
                 'mes_referencia']

ESQUEMA = """
CREATE TABLE IF NOT EXISTS local (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL UNIQUE COLLATE NOCASE,
    tipo TEXT NOT NULL DEFAULT 'fisico' CHECK (tipo IN ('fisico', 'virtual', 'externo')),
    ativo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS evento (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL,
    proad TEXT NOT NULL DEFAULT '',
    area TEXT NOT NULL DEFAULT '',
    origem TEXT NOT NULL DEFAULT '',
    instrutor TEXT NOT NULL DEFAULT '',
    parceria TEXT NOT NULL DEFAULT '',
    diarias TEXT NOT NULL DEFAULT '',
    carga_horaria TEXT NOT NULL DEFAULT '',
    publico TEXT NOT NULL DEFAULT '',
    modalidade TEXT NOT NULL DEFAULT '',
    situacao TEXT NOT NULL DEFAULT '',
    observacoes TEXT NOT NULL DEFAULT '',
    mes_referencia INTEGER,          -- usado quando o evento ainda não tem datas
    revisar TEXT NOT NULL DEFAULT '', -- avisos da importação a conferir
    origem_planilha TEXT NOT NULL DEFAULT '', -- texto original (PERÍODO/HORÁRIO/LOCAL)
    linha_planilha INTEGER,
    versao INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL,
    atualizado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessao (
    id INTEGER PRIMARY KEY,
    evento_id INTEGER NOT NULL REFERENCES evento(id) ON DELETE CASCADE,
    data TEXT NOT NULL,       -- AAAA-MM-DD
    inicio TEXT,              -- HH:MM (vazio = horário não definido)
    fim TEXT,
    local_id INTEGER REFERENCES local(id)
);
CREATE INDEX IF NOT EXISTS idx_sessao_evento ON sessao(evento_id);
CREATE INDEX IF NOT EXISTS idx_sessao_data ON sessao(data);
"""


class ErroValidacao(Exception):
    pass


class ConflitoVersao(Exception):
    pass


_trava = threading.Lock()
_ultimo_backup = 0.0


def agora():
    return datetime.now().isoformat(timespec='seconds')


def conectar(caminho=None):
    caminho = caminho or CAMINHO_DB
    os.makedirs(os.path.dirname(caminho), exist_ok=True)
    con = sqlite3.connect(caminho)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA foreign_keys = ON')
    con.executescript(ESQUEMA)
    return con


def backup(forcar=False):
    """Copia o banco para backups/ (no máximo a cada INTERVALO_BACKUP, salvo forcar)."""
    global _ultimo_backup
    if not os.path.exists(CAMINHO_DB):
        return None
    if not forcar and datetime.now().timestamp() - _ultimo_backup < INTERVALO_BACKUP:
        return None
    os.makedirs(PASTA_BACKUPS, exist_ok=True)
    destino = os.path.join(PASTA_BACKUPS, f"pac_{datetime.now().strftime('%Y%m%d-%H%M%S')}.db")
    origem = sqlite3.connect(CAMINHO_DB)
    with sqlite3.connect(destino) as copia:
        origem.backup(copia)
    origem.close()
    _ultimo_backup = datetime.now().timestamp()
    antigos = sorted(f for f in os.listdir(PASTA_BACKUPS) if f.endswith('.db'))
    for f in antigos[:-MAX_BACKUPS]:
        os.remove(os.path.join(PASTA_BACKUPS, f))
    return destino


# ---------- leitura ----------
def listar_locais(con):
    usados = {r['local_id']: r['n'] for r in con.execute(
        'SELECT local_id, COUNT(DISTINCT evento_id) n FROM sessao WHERE local_id IS NOT NULL GROUP BY local_id')}
    return [{**dict(r), 'ativo': bool(r['ativo']), 'eventos': usados.get(r['id'], 0)}
            for r in con.execute('SELECT * FROM local ORDER BY tipo, nome COLLATE NOCASE')]


def listar_eventos(con):
    sessoes = {}
    for s in con.execute('SELECT * FROM sessao ORDER BY data, inicio, id'):
        sessoes.setdefault(s['evento_id'], []).append(
            {'id': s['id'], 'data': s['data'], 'inicio': s['inicio'] or '', 'fim': s['fim'] or '',
             'local_id': s['local_id']})
    eventos = []
    for e in con.execute('SELECT * FROM evento ORDER BY id'):
        d = dict(e)
        d['sessoes'] = sessoes.get(e['id'], [])
        eventos.append(d)
    return eventos


# ---------- validação ----------
_DATA = re.compile(r'\d{4}-\d{2}-\d{2}')
_HORA = re.compile(r'([01]\d|2[0-3]):[0-5]\d')


def _validar_evento(dados):
    ev = {c: dados.get(c) for c in CAMPOS_EVENTO}
    for c in CAMPOS_EVENTO:
        if c != 'mes_referencia':
            ev[c] = str(ev[c] or '').strip()
    if not ev['nome']:
        raise ErroValidacao('Informe o nome do evento.')
    mes = ev['mes_referencia']
    ev['mes_referencia'] = int(mes) if str(mes or '').isdigit() and 1 <= int(mes) <= 12 else None
    return ev


def _validar_sessoes(con, sessoes):
    locais = {r['id']: r for r in con.execute('SELECT id, nome, ativo FROM local')}
    saida = []
    for i, s in enumerate(sessoes or [], 1):
        data_s = str(s.get('data') or '')
        if not _DATA.fullmatch(data_s):
            raise ErroValidacao(f'Sessão {i}: data inválida.')
        try:
            date.fromisoformat(data_s)
        except ValueError:
            raise ErroValidacao(f'Sessão {i}: data inexistente ({data_s}).')
        inicio, fim = (s.get('inicio') or '').strip(), (s.get('fim') or '').strip()
        for h in (inicio, fim):
            if h and not _HORA.fullmatch(h):
                raise ErroValidacao(f'Sessão {i}: horário inválido ({h}).')
        if bool(inicio) != bool(fim):
            raise ErroValidacao(f'Sessão {i}: informe início e fim, ou deixe os dois vazios.')
        if inicio and fim <= inicio:
            raise ErroValidacao(f'Sessão {i}: o fim deve ser depois do início.')
        local_id = s.get('local_id')
        if local_id in ('', None):
            local_id = None
        else:
            local_id = int(local_id)
            if local_id not in locais:
                raise ErroValidacao(f'Sessão {i}: local inexistente.')
        saida.append((data_s, inicio or None, fim or None, local_id))
    return saida


# ---------- escrita ----------
def _escrever(fn):
    with _trava:
        backup()
        con = conectar()
        try:
            with con:
                return fn(con)
        finally:
            con.close()


def _gravar_sessoes(con, evento_id, sessoes):
    con.execute('DELETE FROM sessao WHERE evento_id = ?', (evento_id,))
    con.executemany('INSERT INTO sessao (evento_id, data, inicio, fim, local_id) VALUES (?, ?, ?, ?, ?)',
                    [(evento_id, *s) for s in sessoes])


def criar_evento(dados, sessoes):
    def fn(con):
        ev = _validar_evento(dados)
        ss = _validar_sessoes(con, sessoes)
        cols = CAMPOS_EVENTO + ['criado_em', 'atualizado_em']
        cur = con.execute(f"INSERT INTO evento ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                          [ev[c] for c in CAMPOS_EVENTO] + [agora(), agora()])
        _gravar_sessoes(con, cur.lastrowid, ss)
        return cur.lastrowid
    return _escrever(fn)


def atualizar_evento(evento_id, versao, dados, sessoes, manter_revisao=False):
    def fn(con):
        atual = con.execute('SELECT versao FROM evento WHERE id = ?', (evento_id,)).fetchone()
        if not atual:
            raise ErroValidacao('Evento não encontrado (talvez tenha sido excluído).')
        if int(versao or 0) != atual['versao']:
            raise ConflitoVersao('Este evento foi alterado em outra janela depois que você o abriu. '
                                 'Recarregue a página para ver a versão atual.')
        ev = _validar_evento(dados)
        ss = _validar_sessoes(con, sessoes)
        sets = ', '.join(f'{c} = ?' for c in CAMPOS_EVENTO)
        extra = '' if manter_revisao else ", revisar = ''"
        con.execute(f'UPDATE evento SET {sets}, versao = versao + 1, atualizado_em = ?{extra} WHERE id = ?',
                    [ev[c] for c in CAMPOS_EVENTO] + [agora(), evento_id])
        _gravar_sessoes(con, evento_id, ss)
        return evento_id
    return _escrever(fn)


def excluir_evento(evento_id, versao):
    def fn(con):
        atual = con.execute('SELECT versao FROM evento WHERE id = ?', (evento_id,)).fetchone()
        if not atual:
            raise ErroValidacao('Evento não encontrado.')
        if int(versao or 0) != atual['versao']:
            raise ConflitoVersao('Este evento foi alterado depois que você o abriu. Recarregue a página.')
        con.execute('DELETE FROM evento WHERE id = ?', (evento_id,))
        return evento_id
    return _escrever(fn)


def _validar_local(dados):
    nome = re.sub(r'\s+', ' ', str(dados.get('nome') or '')).strip()
    tipo = dados.get('tipo') or 'fisico'
    if not nome:
        raise ErroValidacao('Informe o nome do local.')
    if tipo not in TIPOS_LOCAL:
        raise ErroValidacao('Tipo de local inválido.')
    return nome, tipo, 1 if dados.get('ativo', True) else 0


def criar_local(dados):
    def fn(con):
        nome, tipo, ativo = _validar_local(dados)
        try:
            return con.execute('INSERT INTO local (nome, tipo, ativo) VALUES (?, ?, ?)', (nome, tipo, ativo)).lastrowid
        except sqlite3.IntegrityError:
            raise ErroValidacao(f'Já existe um local chamado “{nome}”.')
    return _escrever(fn)


def atualizar_local(local_id, dados):
    def fn(con):
        nome, tipo, ativo = _validar_local(dados)
        try:
            cur = con.execute('UPDATE local SET nome = ?, tipo = ?, ativo = ? WHERE id = ?', (nome, tipo, ativo, local_id))
        except sqlite3.IntegrityError:
            raise ErroValidacao(f'Já existe um local chamado “{nome}”.')
        if not cur.rowcount:
            raise ErroValidacao('Local não encontrado.')
        return local_id
    return _escrever(fn)


def excluir_local(local_id):
    def fn(con):
        n = con.execute('SELECT COUNT(DISTINCT evento_id) FROM sessao WHERE local_id = ?', (local_id,)).fetchone()[0]
        if n:
            raise ErroValidacao(f'Este local é usado por {n} evento(s). Troque o local desses eventos '
                                'ou desative o local em vez de excluí-lo.')
        con.execute('DELETE FROM local WHERE id = ?', (local_id,))
        return local_id
    return _escrever(fn)
