"""Servidor local do Calendário PAC (somente visualização).

Uso:  python3 servidor.py ["caminho/da/planilha.xlsx"] [--porta 8765]
Depois abra http://localhost:8765 no navegador e use o botão "Abrir planilha".
A planilha escolhida é copiada para dados/planilha.xlsx; o arquivo original nunca é alterado.
"""
import argparse
import json
import os
import re
import sys
import tempfile
import webbrowser
from datetime import datetime
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import unquote, urlparse

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)

from periodo import interpretar_periodo, interpretar_horario  # noqa: E402
from planilha import Planilha, CAMPOS, MESES  # noqa: E402

DADOS = os.path.join(AQUI, 'dados')
COPIA = os.path.join(DADOS, 'planilha.xlsx')
INFO_COPIA = os.path.join(DADOS, 'planilha.json')
TAMANHO_MAXIMO = 30 * 1024 * 1024
ESTATICOS = os.path.join(AQUI, 'static')
TIPOS = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
         '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml'}

planilha = None
info_planilha = {}


def e_virtual(campos):
    """Eventos sem ambiente físico (EaD, online, Zoom, plataformas)."""
    mod = campos.get('M', '').lower()
    local = campos.get('N', '').lower()
    if 'presencial' in mod and 'tele' not in mod:
        return False
    if 'híbrido' in mod or 'hibrido' in mod:
        return False
    if any(p in mod for p in ('ead', 'online', 'telepresencial')):
        return True
    return 'plataforma' in local


class PlanilhaInvalida(Exception):
    pass


def carregar_copia():
    """Usa a última planilha aberta pelo botão, se houver."""
    global planilha, info_planilha
    if not os.path.isfile(COPIA):
        return
    try:
        with open(INFO_COPIA, encoding='utf-8') as f:
            info_planilha = json.load(f)
    except (OSError, ValueError):
        info_planilha = {}
    planilha = Planilha(COPIA, None)


def receber_planilha(nome, conteudo):
    """Confere se o arquivo tem a aba PAC e só então substitui a cópia local."""
    global planilha, info_planilha
    os.makedirs(DADOS, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix='.xlsx', dir=DADOS)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(conteudo)
        try:
            Planilha(tmp, None).ler()
        except Exception as e:
            raise PlanilhaInvalida(f'O arquivo "{nome}" não pôde ser lido como planilha do PAC: {e}')
        os.replace(tmp, COPIA)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    info_planilha = {'nome': nome, 'carregada_em': datetime.now().isoformat(timespec='seconds')}
    with open(INFO_COPIA, 'w', encoding='utf-8') as f:
        json.dump(info_planilha, f, ensure_ascii=False)
    planilha = Planilha(COPIA, None)


def chave_ambiente(local):
    return re.sub(r'\s+', ' ', local or '').strip()


def montar_evento(ev, mes_bloco):
    c = ev['campos']
    datas = interpretar_periodo(c['A'])
    return {
        'linha': ev['linha'],
        'campos': c,
        'datas': [d.isoformat() for d in datas],
        'horarios': interpretar_horario(c['I']),
        'virtual': e_virtual(c),
        'ambiente': chave_ambiente(c['N']),
        'suspenso': 'suspens' in c['O'].lower() or 'cancelad' in c['O'].lower(),
        'mes_bloco': mes_bloco,
    }


def listar():
    if planilha is None:
        return {'sem_planilha': True}
    eventos, cabecalhos, mtime = planilha.ler()
    saida = []
    for ev in eventos:
        anteriores = [r for r in cabecalhos if r < ev['linha']]
        mes = cabecalhos[max(anteriores)] if anteriores else None
        saida.append(montar_evento(ev, mes))
    return {
        'arquivo': info_planilha.get('nome') or os.path.basename(planilha.caminho),
        'carregada_em': info_planilha.get('carregada_em'),
        'modificado': mtime,
        'campos': CAMPOS,
        'meses': MESES,
        'eventos': saida,
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write('[%s] %s\n' % (self.log_date_time_string(), fmt % args))

    def _json(self, status, dados):
        corpo = json.dumps(dados, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(corpo)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(corpo)

    def _corpo(self):
        n = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(n) or b'{}') if n else {}

    def _origem_ok(self):
        # Bloqueia requisições de escrita vindas de outros sites abertos no navegador.
        origem = self.headers.get('Origin')
        host = self.headers.get('Host', '')
        return origem is None or urlparse(origem).netloc == host

    def do_GET(self):
        caminho = urlparse(self.path).path
        if caminho == '/api/eventos':
            try:
                return self._json(200, listar())
            except Exception as e:  # planilha aberta/corrompida etc.
                return self._json(500, {'erro': f'Não foi possível ler a planilha: {e}'})
        if caminho == '/':
            caminho = '/index.html'
        arq = os.path.normpath(os.path.join(ESTATICOS, caminho.lstrip('/')))
        if not arq.startswith(ESTATICOS + os.sep) or not os.path.isfile(arq):
            return self._json(404, {'erro': 'não encontrado'})
        with open(arq, 'rb') as f:
            dados = f.read()
        self.send_response(200)
        self.send_header('Content-Type', TIPOS.get(os.path.splitext(arq)[1], 'application/octet-stream'))
        self.send_header('Content-Length', str(len(dados)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(dados)

    def do_POST(self):
        caminho = urlparse(self.path).path
        if caminho == '/api/interpretar':
            corpo = self._corpo()
            return self._json(200, {
                'datas': [d.isoformat() for d in interpretar_periodo(corpo.get('periodo', ''))],
                'horarios': interpretar_horario(corpo.get('horario', '')),
            })
        if caminho == '/api/planilha':
            if not self._origem_ok():
                return self._json(403, {'erro': 'origem não permitida'})
            n = int(self.headers.get('Content-Length') or 0)
            if not n:
                return self._json(400, {'erro': 'Nenhum arquivo recebido.'})
            if n > TAMANHO_MAXIMO:
                return self._json(413, {'erro': 'Arquivo grande demais para uma planilha do PAC.'})
            nome = os.path.basename(unquote(self.headers.get('X-Nome-Arquivo', ''))) or 'planilha.xlsx'
            try:
                receber_planilha(nome, self.rfile.read(n))
                return self._json(200, listar())
            except PlanilhaInvalida as e:
                return self._json(422, {'erro': str(e)})
            except Exception as e:
                return self._json(500, {'erro': f'Falha ao abrir a planilha: {e}'})
        return self._json(404, {'erro': 'não encontrado'})


def main():
    global planilha
    ap = argparse.ArgumentParser(description='Calendário do PAC')
    ap.add_argument('planilha', nargs='?', help='abre este arquivo em vez da última planilha carregada')
    ap.add_argument('--porta', type=int, default=8765)
    ap.add_argument('--sem-navegador', action='store_true')
    args = ap.parse_args()
    if args.planilha:
        caminho = os.path.abspath(args.planilha)
        if not os.path.isfile(caminho):
            sys.exit(f'Planilha não encontrada: {caminho}')
        planilha = Planilha(caminho, None)
        planilha.ler()  # valida a aba PAC antes de subir
    else:
        carregar_copia()
    url = f'http://localhost:{args.porta}'
    servidor = ThreadingHTTPServer(('127.0.0.1', args.porta), Handler)
    origem = planilha.caminho if planilha else 'nenhuma (use o botão "Abrir planilha")'
    print(f'Calendário PAC em {url}\nPlanilha: {origem}\nCtrl+C para encerrar.')
    if not args.sem_navegador:
        webbrowser.open(url)
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print('\nEncerrado.')


if __name__ == '__main__':
    main()
