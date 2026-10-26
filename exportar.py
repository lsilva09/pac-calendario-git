"""Gera um .xlsx no formato da aba PAC a partir do banco (não altera a planilha original)."""
import io
import zipfile
from datetime import date, timedelta
from html import escape

MESES = ['JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO',
         'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO']
COLUNAS = [  # (título, largura)
    ('PERÍODO', 18), ('PROAD', 14), ('EVENTO', 48), ('ÁREA', 8), ('ORIGEM DOS RECURSOS', 16),
    ('INSTRUTOR / CONTEUDISTA / TUTOR', 26), ('PARCERIA', 12), ('HORÁRIO', 24), ('DIÁRIAS?', 10),
    ('CARGA HORÁRIA', 10), ('PÚBLICO ALVO', 28), ('MODALIDADE', 14), ('LOCAL', 36),
    ('SITUAÇÃO', 18), ('OBSERVAÇÕES', 28),
]


def _ddmm(d):
    return d.strftime('%d/%m')


def _juntar(partes):
    return partes[0] if len(partes) == 1 else ', '.join(partes[:-1]) + ' e ' + partes[-1]


def texto_periodo(datas):
    """Datas -> '06 a 10/04, 15/04 e 20/04' (sequências de 3+ dias úteis viram intervalo)."""
    datas = sorted(set(datas))
    if not datas:
        return ''
    blocos, atual = [], [datas[0]]
    for d in datas[1:]:
        prox = atual[-1] + timedelta(days=1)
        while prox.weekday() >= 5:
            prox += timedelta(days=1)
        if d == prox:
            atual.append(d)
        else:
            blocos.append(atual)
            atual = [d]
    blocos.append(atual)
    partes = []
    for b in blocos:
        if len(b) >= 3:
            partes.append(f'{_ddmm(b[0])} a {_ddmm(b[-1])}')
        else:
            partes.extend(_ddmm(d) for d in b)
    return _juntar(partes)


def _hora(h):
    hh, mm = h.split(':')
    return f'{hh}h' + ('' if mm == '00' else mm)


def _faixas(sessoes):
    faixas = sorted({(s['inicio'], s['fim']) for s in sessoes if s['inicio']})
    return _juntar([f'{_hora(i)} às {_hora(f)}' for i, f in faixas]) if faixas else ''


def _por_data(sessoes, chave):
    """Agrupa datas com o mesmo valor: {valor: [datas]} preservando a ordem."""
    por_dia = {}
    for s in sessoes:
        por_dia.setdefault(s['data'], []).append(s)
    grupos = {}
    for d in sorted(por_dia):
        grupos.setdefault(chave(por_dia[d]), []).append(date.fromisoformat(d))
    return grupos


def texto_variavel(sessoes, chave):
    """Valor único se igual em todas as datas; senão uma linha 'datas: valor' por grupo."""
    grupos = _por_data(sessoes, chave)
    if len(grupos) <= 1:
        return next(iter(grupos), '')
    return '\n'.join(f'{texto_periodo(ds)}: {v or "—"}' for v, ds in grupos.items())


def linha_evento(ev, nomes_locais):
    ss = ev['sessoes']
    datas = [date.fromisoformat(s['data']) for s in ss]
    local = lambda grupo: ' / '.join(dict.fromkeys(nomes_locais.get(s['local_id'], '') for s in grupo if s['local_id']))
    return [
        texto_periodo(datas), ev['proad'], ev['nome'], ev['area'], ev['origem'], ev['instrutor'],
        ev['parceria'], texto_variavel(ss, _faixas), ev['diarias'], ev['carga_horaria'], ev['publico'],
        ev['modalidade'], texto_variavel(ss, local), ev['situacao'], ev['observacoes'],
    ]


def _col(i):
    s = ''
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def _celula(ref, valor, estilo):
    if valor in (None, ''):
        return f'<c r="{ref}" s="{estilo}"/>'
    num = str(valor).replace(',', '.')
    if estilo == 2 and ref[0] == 'J' and num.replace('.', '', 1).isdigit():
        return f'<c r="{ref}" s="{estilo}"><v>{num}</v></c>'
    return (f'<c r="{ref}" s="{estilo}" t="inlineStr"><is><t xml:space="preserve">'
            f'{escape(str(valor), quote=False)}</t></is></c>')


def gerar_xlsx(eventos, locais, titulo='EJUD 13 - PLANO ANUAL DE CAPACITAÇÃO 2026'):
    nomes = {l['id']: l['nome'] for l in locais}
    por_mes = {m: [] for m in range(1, 13)}
    sem_mes = []
    for ev in eventos:
        datas = sorted(s['data'] for s in ev['sessoes'])
        mes = int(datas[0][5:7]) if datas else ev.get('mes_referencia')
        (por_mes[mes] if mes else sem_mes).append((datas[0] if datas else '9999', ev))

    linhas, mesclas = [], []
    n = len(COLUNAS)
    ultima = _col(n - 1)
    linhas.append([(titulo, 3)] + [('', 3)] * (n - 1)); mesclas.append(f'A1:{ultima}1')
    linhas.append([(t, 1) for t, _ in COLUNAS])
    grupos = [(MESES[m - 1], por_mes[m]) for m in range(1, 13)]
    if sem_mes:
        grupos.append(('SEM MÊS DEFINIDO', sem_mes))
    for nome_mes, evs in grupos:
        if not evs:
            continue
        r = len(linhas) + 1
        linhas.append([(nome_mes, 4)] + [('', 4)] * (n - 1)); mesclas.append(f'A{r}:{ultima}{r}')
        for _, ev in sorted(evs, key=lambda x: (x[0], x[1]['nome'])):
            linhas.append([(v, 2) for v in linha_evento(ev, nomes)])

    xml_linhas = []
    for i, cel in enumerate(linhas, 1):
        corpo = ''.join(_celula(f'{_col(j)}{i}', v, e) for j, (v, e) in enumerate(cel))
        alto = ' ht="28" customHeight="1"' if i == 1 else ''
        xml_linhas.append(f'<row r="{i}"{alto}>{corpo}</row>')
    xml_mesclas = ''.join('<mergeCell ref="%s"/>' % m for m in mesclas)
    cols = ''.join(f'<col min="{j}" max="{j}" width="{w}" customWidth="1"/>' for j, (_, w) in enumerate(COLUNAS, 1))
    planilha = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
        f'<cols>{cols}</cols><sheetData>{"".join(xml_linhas)}</sheetData>'
        f'<autoFilter ref="A2:{ultima}{len(linhas)}"/>'
        f'<mergeCells count="{len(mesclas)}">{xml_mesclas}</mergeCells>'
        '</worksheet>')
    estilos = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<fonts count="3"><font><sz val="10"/><name val="Arial"/></font>'
        '<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>'
        '<font><b/><sz val="12"/><name val="Arial"/></font></fonts>'
        '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FF1F5FBF"/></patternFill></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FFDCE6F5"/></patternFill></fill></fills>'
        '<borders count="2"><border/><border><left style="thin"><color rgb="FFBFBFBF"/></left>'
        '<right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top>'
        '<bottom style="thin"><color rgb="FFBFBFBF"/></bottom></border></borders>'
        '<cellStyleXfs count="1"><xf/></cellStyleXfs>'
        '<cellXfs count="5"><xf/>'
        '<xf fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
        '<xf borderId="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
        '<xf fontId="2" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>'
        '<xf fontId="2" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/>'
        '</cellXfs></styleSheet>')
    arquivos = {
        '[Content_Types].xml': (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            '</Types>'),
        '_rels/.rels': (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>'),
        'xl/workbook.xml': (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets><sheet name="PAC" sheetId="1" r:id="rId1"/></sheets>'
            f'<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">PAC!$A$2:${ultima}${len(linhas)}</definedName></definedNames>'
            '</workbook>'),
        'xl/_rels/workbook.xml.rels': (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            '</Relationships>'),
        'xl/worksheets/sheet1.xml': planilha,
        'xl/styles.xml': estilos,
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for nome, conteudo in arquivos.items():
            z.writestr(nome, conteudo)
    return buf.getvalue()
