"""Servidor local do Calendário PAC v2.

Uso:  python3 servidor.py [--porta 8766] [--sem-navegador]
Na primeira execução, se o banco estiver vazio, importa a aba PAC de '../PAC 2026.xlsx'.
"""
import argparse
import json
import os
import re
import sys
import webbrowser
from datetime import datetime
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)

import db  # noqa: E402
import exportar  # noqa: E402
from periodo import interpretar_periodo  # noqa: E402

ESTATICOS = os.path.join(AQUI, 'static')
TIPOS = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
         '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml'}


def dados():
    con = db.conectar()
    try:
        return {'eventos': db.listar_eventos(con), 'locais': db.listar_locais(con)}
    finally:
        con.close()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write('[%s] %s\n' % (self.log_date_time_string(), fmt % args))

    def _enviar(self, status, corpo, tipo, extra=None):
        self.send_response(status)
        self.send_header('Content-Type', tipo)
        self.send_header('Content-Length', str(len(corpo)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(corpo)

    def _json(self, status, obj):
        self._enviar(status, json.dumps(obj, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')

    def _corpo(self):
        n = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(n)) if n else {}

    def _origem_ok(self):
        # Bloqueia escritas disparadas por outros sites abertos no navegador.
        origem = self.headers.get('Origin')
        return origem is None or urlparse(origem).netloc == self.headers.get('Host', '')

    def _escrita(self, acao):
        if not self._origem_ok():
            return self._json(403, {'erro': 'origem não permitida'})
        try:
            ident = acao(self._corpo())
            return self._json(200, {'ok': True, 'id': ident, **dados()})
        except db.ErroValidacao as e:
            return self._json(422, {'erro': str(e)})
        except db.ConflitoVersao as e:
            return self._json(409, {'erro': str(e)})
        except Exception as e:
            return self._json(500, {'erro': f'Falha ao gravar: {e}'})

    def _rota(self):
        caminho = urlparse(self.path).path
        m = re.fullmatch(r'/api/(eventos|locais)(?:/(\d+))?', caminho)
        return caminho, (m.group(1), int(m.group(2)) if m.group(2) else None) if m else (None, None)

    def do_GET(self):
        caminho, _ = self._rota()
        if caminho == '/api/dados':
            return self._json(200, dados())
        if caminho == '/api/exportar.xlsx':
            d = dados()
            arquivo = exportar.gerar_xlsx(d['eventos'], d['locais'])
            nome = f"PAC 2026 - exportado {datetime.now().strftime('%Y-%m-%d %Hh%M')}.xlsx"
            return self._enviar(200, arquivo,
                                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                                {'Content-Disposition': f"attachment; filename*=UTF-8''{_url(nome)}"})
        if caminho == '/':
            caminho = '/index.html'
        arq = os.path.normpath(os.path.join(ESTATICOS, caminho.lstrip('/')))
        if not arq.startswith(ESTATICOS + os.sep) or not os.path.isfile(arq):
            return self._json(404, {'erro': 'não encontrado'})
        with open(arq, 'rb') as f:
            self._enviar(200, f.read(), TIPOS.get(os.path.splitext(arq)[1], 'application/octet-stream'))

    def do_POST(self):
        caminho, (recurso, ident) = self._rota()
        if caminho == '/api/interpretar':
            corpo = self._corpo()
            return self._json(200, {'datas': [d.isoformat() for d in interpretar_periodo(corpo.get('texto', ''))]})
        if recurso == 'eventos' and ident is None:
            return self._escrita(lambda c: db.criar_evento(c.get('evento', {}), c.get('sessoes', [])))
        if recurso == 'locais' and ident is None:
            return self._escrita(db.criar_local)
        return self._json(404, {'erro': 'não encontrado'})

    def do_PUT(self):
        _, (recurso, ident) = self._rota()
        if recurso == 'eventos' and ident:
            return self._escrita(lambda c: db.atualizar_evento(
                ident, c.get('versao'), c.get('evento', {}), c.get('sessoes', []), bool(c.get('manter_revisao'))))
        if recurso == 'locais' and ident:
            return self._escrita(lambda c: db.atualizar_local(ident, c))
        return self._json(404, {'erro': 'não encontrado'})

    def do_DELETE(self):
        _, (recurso, ident) = self._rota()
        if recurso == 'eventos' and ident:
            return self._escrita(lambda c: db.excluir_evento(ident, c.get('versao')))
        if recurso == 'locais' and ident:
            return self._escrita(lambda c: db.excluir_local(ident))
        return self._json(404, {'erro': 'não encontrado'})


def _url(texto):
    from urllib.parse import quote
    return quote(texto)


def main():
    ap = argparse.ArgumentParser(description='Calendário PAC v2')
    ap.add_argument('--porta', type=int, default=8766)
    ap.add_argument('--sem-navegador', action='store_true')
    args = ap.parse_args()
    con = db.conectar()
    vazio = con.execute('SELECT COUNT(*) FROM evento').fetchone()[0] == 0
    con.close()
    if vazio:
        import importar
        r = importar.importar(importar.PLANILHA_PADRAO)
        print(f"Primeira execução: importados {r['eventos']} eventos da planilha.")
    db.backup(forcar=True)
    url = f'http://localhost:{args.porta}'
    servidor = ThreadingHTTPServer(('127.0.0.1', args.porta), Handler)
    print(f'Calendário PAC v2 em {url}\nBanco: {db.CAMINHO_DB}\nCtrl+C para encerrar.', flush=True)
    if not args.sem_navegador:
        webbrowser.open(url)
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print('\nEncerrado.')


if __name__ == '__main__':
    main()
