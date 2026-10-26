"""Servidor local do Calendário PAC.

Uso:  python3 servidor.py ["caminho/da/planilha.xlsx"] [--porta 8765]
Depois abra http://localhost:8765 no navegador.
"""
import argparse
import json
import os
import re
import sys
import webbrowser
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)

from periodo import interpretar_periodo, interpretar_horario  # noqa: E402
from planilha import Planilha, ConflitoEdicao, CAMPOS, MESES  # noqa: E402

PLANILHA_PADRAO = os.path.join(os.path.dirname(AQUI), 'PAC 2026.xlsx')
ARQUIVO_LOCAIS = os.path.join(AQUI, 'locais.json')
ESTATICOS = os.path.join(AQUI, 'static')
TIPOS = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
         '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml'}

planilha = None


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


class LocalInvalido(Exception):
    pass


def ler_locais():
    """Lista oficial de locais (relida a cada uso para refletir edições no arquivo)."""
    with open(ARQUIVO_LOCAIS, encoding='utf-8') as f:
        return json.load(f)['locais']


def validar_local(local):
    """Aceita vazio, um local da lista ou vários locais da lista separados por ' / '."""
    local = chave_ambiente(local)
    locais = ler_locais()
    if not local or local in locais:
        return
    fora = [p for p in (x.strip() for x in local.split(' / ')) if p and p not in locais]
    if fora:
        raise LocalInvalido('Local fora da lista oficial: ' + ', '.join(fora) +
                            '. Para incluir um local novo, edite o arquivo locais.json.')


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
    eventos, cabecalhos, mtime = planilha.ler()
    saida = []
    for ev in eventos:
        anteriores = [r for r in cabecalhos if r < ev['linha']]
        mes = cabecalhos[max(anteriores)] if anteriores else None
        saida.append(montar_evento(ev, mes))
    return {
        'arquivo': os.path.basename(planilha.caminho),
        'modificado': mtime,
        'campos': CAMPOS,
        'meses': MESES,
        'locais': ler_locais(),
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

    def _escrita(self, acao):
        if not self._origem_ok():
            return self._json(403, {'erro': 'origem não permitida'})
        try:
            corpo = self._corpo()
            linha = acao(corpo)
            return self._json(200, {'ok': True, 'linha': linha, **listar()})
        except ConflitoEdicao as e:
            return self._json(409, {'erro': str(e)})
        except LocalInvalido as e:
            return self._json(422, {'erro': str(e)})
        except PermissionError:
            return self._json(423, {'erro': 'A planilha está bloqueada. Feche-a no Excel e tente de novo.'})
        except Exception as e:
            return self._json(500, {'erro': f'Falha ao gravar: {e}'})

    def do_POST(self):
        caminho = urlparse(self.path).path
        if caminho == '/api/interpretar':
            corpo = self._corpo()
            return self._json(200, {
                'datas': [d.isoformat() for d in interpretar_periodo(corpo.get('periodo', ''))],
                'horarios': interpretar_horario(corpo.get('horario', '')),
            })
        if caminho == '/api/eventos':
            def criar(corpo):
                campos = corpo.get('campos', {})
                validar_local(campos.get('N', ''))
                datas = interpretar_periodo(campos.get('A', ''))
                mes = datas[0].month if datas else corpo.get('mes')
                return planilha.criar(campos, mes)
            return self._escrita(criar)
        return self._json(404, {'erro': 'não encontrado'})

    def do_PUT(self):
        m = re.fullmatch(r'/api/eventos/(\d+)', urlparse(self.path).path)
        if not m:
            return self._json(404, {'erro': 'não encontrado'})
        r = int(m.group(1))
        def atualizar(corpo):
            original, campos = corpo.get('original', {}), corpo.get('campos', {})
            # Locais antigos fora da lista continuam aceitos enquanto não forem alterados.
            if campos.get('N', '') != original.get('N', ''):
                validar_local(campos.get('N', ''))
            return planilha.atualizar(r, original, campos)
        return self._escrita(atualizar)

    def do_DELETE(self):
        m = re.fullmatch(r'/api/eventos/(\d+)', urlparse(self.path).path)
        if not m:
            return self._json(404, {'erro': 'não encontrado'})
        r = int(m.group(1))
        return self._escrita(lambda c: planilha.excluir(r, c.get('original', {})))


def main():
    global planilha
    ap = argparse.ArgumentParser(description='Calendário do PAC')
    ap.add_argument('planilha', nargs='?', default=PLANILHA_PADRAO)
    ap.add_argument('--porta', type=int, default=8765)
    ap.add_argument('--sem-navegador', action='store_true')
    args = ap.parse_args()
    caminho = os.path.abspath(args.planilha)
    if not os.path.isfile(caminho):
        sys.exit(f'Planilha não encontrada: {caminho}')
    planilha = Planilha(caminho, os.path.join(AQUI, 'backups'))
    planilha.ler()  # valida a aba PAC antes de subir
    url = f'http://localhost:{args.porta}'
    servidor = ThreadingHTTPServer(('127.0.0.1', args.porta), Handler)
    print(f'Calendário PAC em {url}\nPlanilha: {caminho}\nCtrl+C para encerrar.')
    if not args.sem_navegador:
        webbrowser.open(url)
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print('\nEncerrado.')


if __name__ == '__main__':
    main()
