"""Leitura e gravação da aba PAC direto no XML do .xlsx.

A gravação altera somente as células editadas da aba PAC; as demais abas,
estilos, comentários, links e mesclagens são copiados sem modificação.
"""
import html
import os
import re
import shutil
import tempfile
import threading
import zipfile
from datetime import datetime

from periodo import serial_para_data

NOME_ABA = 'PAC'
COLUNAS = list('ABCDEFGHIJKLMNO')
CAMPOS = {
    'A': 'PERÍODO', 'B': 'PROAD', 'C': 'EVENTO', 'E': 'ÁREA',
    'F': 'ORIGEM DOS RECURSOS', 'G': 'INSTRUTOR / CONTEUDISTA / TUTOR',
    'H': 'PARCERIA', 'I': 'HORÁRIO', 'J': 'DIÁRIAS?', 'K': 'CARGA HORÁRIA',
    'L': 'PÚBLICO ALVO', 'M': 'MODALIDADE', 'N': 'LOCAL', 'O': 'SITUAÇÃO',
}
COLUNAS_EDITAVEIS = list(CAMPOS)
MESES = ['JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO',
         'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO']
PRIMEIRA_LINHA = 5
MAX_BACKUPS = 30

_trava = threading.Lock()
_CELULA = re.compile(r'<c r="([A-Z]+)(\d+)"([^>]*?)(?:/>|>(.*?)</c>)', re.S)
_LINHA = re.compile(r'<row [^>]*?r="(\d+)"[^>]*?(?:/>|>.*?</row>)', re.S)


class ConflitoEdicao(Exception):
    """A linha foi alterada na planilha depois que a página a carregou."""


def _col_idx(col):
    n = 0
    for ch in col:
        n = n * 26 + ord(ch) - 64
    return n


def _texto_t(xml):
    # Junta os <t> ignorando a fonética (<rPh>).
    xml = re.sub(r'<rPh\b.*?</rPh>', '', xml, flags=re.S)
    return html.unescape(''.join(re.findall(r'<t[^>]*>(.*?)</t>', xml, re.S)))


def _normalizar(col, valor, tipo):
    """Valor como exibido na página: datas seriais viram dd/mm/aaaa e '8.0' vira '8'."""
    if tipo != 'n':
        return valor
    try:
        num = float(valor)
    except ValueError:
        return valor
    if col == 'A' and num > 1000:
        return serial_para_data(num).strftime('%d/%m/%Y')
    return str(int(num)) if num.is_integer() else valor


def _escapar(texto):
    texto = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', texto)
    return html.escape(texto, quote=False)


class Planilha:
    def __init__(self, caminho, pasta_backups):
        self.caminho = caminho
        self.pasta_backups = pasta_backups

    # ---------- localização da aba ----------
    def _caminho_aba(self, z):
        wb = z.read('xl/workbook.xml').decode('utf-8')
        rels = z.read('xl/_rels/workbook.xml.rels').decode('utf-8')
        for attrs in re.findall(r'<sheet ([^>]*)/?>', wb):
            nome = re.search(r'name="([^"]*)"', attrs)
            if nome and html.unescape(nome.group(1)) == NOME_ABA:
                rid = re.search(r'r:id="([^"]+)"', attrs).group(1)
                for rel in re.findall(r'<Relationship [^>]*>', rels):
                    if f'Id="{rid}"' in rel:
                        alvo = re.search(r'Target="([^"]+)"', rel).group(1)
                        return alvo.lstrip('/') if alvo.startswith('/xl/') else 'xl/' + alvo
        raise RuntimeError(f'Aba "{NOME_ABA}" não encontrada na planilha.')

    def _strings(self, z):
        if 'xl/sharedStrings.xml' not in z.namelist():
            return []
        ss = z.read('xl/sharedStrings.xml').decode('utf-8')
        return [_texto_t(si) for si in re.findall(r'<si>(.*?)</si>', ss, re.S)]

    # ---------- leitura ----------
    def _ler_linhas(self, xml, strings):
        """{linha: {col: (valor, tipo)}} com tipo 'n' (número) ou 's' (texto)."""
        linhas = {}
        for m in _LINHA.finditer(xml):
            r = int(m.group(1))
            celulas = {}
            for c in _CELULA.finditer(m.group(0)):
                col, _, attrs, inner = c.groups()
                if col not in COLUNAS or not inner:
                    continue
                tipo = re.search(r'\bt="([^"]+)"', attrs)
                tipo = tipo.group(1) if tipo else 'n'
                v = re.search(r'<v>(.*?)</v>', inner, re.S)
                if tipo == 's' and v:
                    valor, t = strings[int(v.group(1))], 's'
                elif tipo == 'inlineStr':
                    valor, t = _texto_t(inner), 's'
                elif v:
                    valor = html.unescape(v.group(1))
                    t = 'n' if tipo == 'n' else 's'
                    if tipo == 'b':
                        valor = 'VERDADEIRO' if valor == '1' else 'FALSO'
                else:
                    continue
                if valor.strip():
                    celulas[col] = (valor, t)
            linhas[r] = celulas
        return linhas

    def ler(self):
        with zipfile.ZipFile(self.caminho) as z:
            xml = z.read(self._caminho_aba(z)).decode('utf-8')
            linhas = self._ler_linhas(xml, self._strings(z))
        eventos, cabecalhos = [], {}
        for r in sorted(linhas):
            cel = linhas[r]
            if r < PRIMEIRA_LINHA or not cel:
                continue
            if set(cel) == {'A'} and cel['A'][0].strip().upper() in MESES:
                cabecalhos[r] = MESES.index(cel['A'][0].strip().upper()) + 1
                continue
            eventos.append({
                'linha': r,
                'campos': {c: _normalizar(c, *cel[c]) if c in cel else ''
                           for c in COLUNAS_EDITAVEIS},
                'tipos': {c: cel[c][1] for c in cel},
            })
        return eventos, cabecalhos, os.path.getmtime(self.caminho)

    # ---------- gravação ----------
    def _backup(self):
        os.makedirs(self.pasta_backups, exist_ok=True)
        base = os.path.splitext(os.path.basename(self.caminho))[0]
        carimbo = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
        shutil.copy2(self.caminho, os.path.join(self.pasta_backups, f'{base}_{carimbo}.xlsx'))
        antigos = sorted(f for f in os.listdir(self.pasta_backups) if f.endswith('.xlsx'))
        for f in antigos[:-MAX_BACKUPS]:
            os.remove(os.path.join(self.pasta_backups, f))

    def _regravar(self, alterar_xml):
        """Aplica alterar_xml(xml, strings) -> (novo_xml, resultado) à aba PAC e salva."""
        with _trava:
            with zipfile.ZipFile(self.caminho) as z:
                aba = self._caminho_aba(z)
                strings = self._strings(z)
                entradas = [(info, z.read(info.filename)) for info in z.infolist()]
            xml = dict((i.filename, d) for i, d in entradas)[aba].decode('utf-8')
            novo_xml, resultado = alterar_xml(xml, strings)
            self._backup()
            pasta = os.path.dirname(os.path.abspath(self.caminho))
            fd, tmp = tempfile.mkstemp(suffix='.xlsx', dir=pasta)
            os.close(fd)
            try:
                with zipfile.ZipFile(tmp, 'w') as out:
                    for info, dados in entradas:
                        if info.filename == aba:
                            dados = novo_xml.encode('utf-8')
                        out.writestr(info, dados, compress_type=info.compress_type)
                shutil.copymode(self.caminho, tmp)
                os.replace(tmp, self.caminho)
            except BaseException:
                if os.path.exists(tmp):
                    os.remove(tmp)
                raise
            return resultado

    @staticmethod
    def _celula_xml(col, r, estilo, valor, numerico):
        s = f' s="{estilo}"' if estilo else ''
        if valor == '':
            return f'<c r="{col}{r}"{s}/>'
        if numerico:
            return f'<c r="{col}{r}"{s}><v>{valor}</v></c>'
        return (f'<c r="{col}{r}"{s} t="inlineStr"><is><t xml:space="preserve">'
                f'{_escapar(valor)}</t></is></c>')

    def _alterar_linha(self, xml, r, valores, estilos_modelo=None):
        """Substitui as células de `valores` ({col: texto}) na linha r."""
        m = re.search(r'<row [^>]*?r="%d"[^>]*?(?:/>|>.*?</row>)' % r, xml, re.S)
        if m:
            linha = m.group(0)
            abre = re.match(r'<row [^>]*?(?=/?>)', linha).group(0)
            celulas = {c.group(1): (c.group(0), re.search(r'\bs="(\d+)"', c.group(3)))
                       for c in _CELULA.finditer(linha)}
            celulas = {k: (x, e.group(1) if e else None) for k, (x, e) in celulas.items()}
        else:
            abre, celulas = f'<row r="{r}"', {}
        for col, valor in valores.items():
            estilo = celulas.get(col, (None, None))[1]
            if estilos_modelo and col in estilos_modelo:
                estilo = estilos_modelo[col]
            numerico = col == 'K' and re.fullmatch(r'\d+([.,]\d+)?', valor.strip() or 'x')
            if numerico:
                valor = valor.strip().replace(',', '.')
            celulas[col] = (self._celula_xml(col, r, estilo, valor, bool(numerico)), estilo)
        if estilos_modelo:
            for col, estilo in estilos_modelo.items():
                if col not in valores:
                    x = celulas.get(col, (None, None))[0]
                    vazio = x is None or x.endswith('/>')
                    if vazio:
                        celulas[col] = (self._celula_xml(col, r, estilo, '', False), estilo)
        corpo = ''.join(celulas[c][0] for c in sorted(celulas, key=_col_idx))
        nova = f'{abre}>{corpo}</row>'
        if m:
            return xml[:m.start()] + nova + xml[m.end():]
        # Linha inexistente: inserir na posição correta.
        for lm in _LINHA.finditer(xml):
            if int(lm.group(1)) > r:
                return xml[:lm.start()] + nova + xml[lm.start():]
        fim = xml.index('</sheetData>')
        return xml[:fim] + nova + xml[fim:]

    def _conferir(self, xml, strings, r, original):
        atuais = self._ler_linhas(xml, strings).get(r, {})
        for col in COLUNAS_EDITAVEIS:
            atual = _normalizar(col, *atuais[col]) if col in atuais else ''
            if atual.strip() != (original.get(col) or '').strip():
                raise ConflitoEdicao(
                    f'A linha {r} foi alterada na planilha por outra pessoa ou programa. '
                    'Recarregue a página para ver a versão atual.')

    def atualizar(self, r, original, novos):
        """Grava apenas os campos que mudaram em relação a `original`."""
        mudancas = {c: v for c, v in novos.items()
                    if c in COLUNAS_EDITAVEIS and (v or '') != (original.get(c) or '')}

        def alterar(xml, strings):
            self._conferir(xml, strings, r, original)
            return (self._alterar_linha(xml, r, mudancas) if mudancas else xml), r
        if not mudancas:
            return r
        return self._regravar(alterar)

    def excluir(self, r, original):
        def alterar(xml, strings):
            self._conferir(xml, strings, r, original)
            return self._alterar_linha(xml, r, {c: '' for c in COLUNAS_EDITAVEIS}), r
        return self._regravar(alterar)

    def criar(self, campos, mes):
        """Grava um novo evento numa linha vazia do bloco do mês (ou no fim da aba)."""
        def alterar(xml, strings):
            linhas = self._ler_linhas(xml, strings)
            cabecalhos = sorted(r for r, c in linhas.items() if r >= PRIMEIRA_LINHA and
                                set(c) == {'A'} and c['A'][0].strip().upper() in MESES)
            usadas = [r for r, c in linhas.items() if c and r >= PRIMEIRA_LINHA]
            ultima = max(usadas) if usadas else PRIMEIRA_LINHA
            alvo, modelo = None, None
            if mes:
                cab = next((r for r in cabecalhos
                            if linhas[r]['A'][0].strip().upper() == MESES[mes - 1]), None)
                if cab:
                    prox = next((r for r in cabecalhos if r > cab), ultima + 1)
                    eventos = [r for r in range(cab + 1, prox) if linhas.get(r)]
                    ultimo_ev = max(eventos) if eventos else cab
                    vazias = [r for r in range(cab + 1, prox) if not linhas.get(r)]
                    alvo = next((r for r in vazias if r > ultimo_ev), vazias[0] if vazias else None)
                    modelo = ultimo_ev if eventos else None
            if alvo is None:
                alvo = ultima + 1
            if modelo is None:
                modelo = max((r for r in usadas if r not in cabecalhos), default=None)
            estilos = {}
            if modelo:
                mm = re.search(r'<row [^>]*?r="%d"[^>]*?>.*?</row>' % modelo, xml, re.S)
                for c in _CELULA.finditer(mm.group(0) if mm else ''):
                    e = re.search(r'\bs="(\d+)"', c.group(3))
                    if c.group(1) in COLUNAS and e:
                        estilos[c.group(1)] = e.group(1)
            valores = {c: campos.get(c, '') or '' for c in COLUNAS_EDITAVEIS}
            xml = self._alterar_linha(xml, alvo, valores, estilos or None)
            xml = self._garantir_mescla(xml, f'C{alvo}:D{alvo}')
            return xml, alvo
        return self._regravar(alterar)

    @staticmethod
    def _garantir_mescla(xml, ref):
        if f'<mergeCell ref="{ref}"/>' in xml:
            return xml
        m = re.search(r'<mergeCells count="(\d+)">', xml)
        if m:
            novo = f'<mergeCells count="{int(m.group(1)) + 1}"><mergeCell ref="{ref}"/>'
            return xml[:m.start()] + novo + xml[m.end():]
        fim = xml.index('</sheetData>') + len('</sheetData>')
        return xml[:fim] + f'<mergeCells count="1"><mergeCell ref="{ref}"/></mergeCells>' + xml[fim:]

    def substituir_em_massa(self, coluna, mapa):
        """Troca valores exatos de uma coluna: mapa {linha: (antigo, novo)}."""
        def alterar(xml, strings):
            linhas = self._ler_linhas(xml, strings)
            for r, (antigo, novo) in mapa.items():
                atual = linhas.get(r, {}).get(coluna, ('', ''))[0]
                if atual != antigo:
                    raise ConflitoEdicao(f'Linha {r}: valor atual difere do esperado.')
                xml = self._alterar_linha(xml, r, {coluna: novo})
            return xml, len(mapa)
        return self._regravar(alterar)
