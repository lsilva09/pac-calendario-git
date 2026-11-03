"""Interpretação dos textos livres de PERÍODO e HORÁRIO da planilha PAC."""
import re
from datetime import date, timedelta

ANO_PADRAO = 2026
EXCEL_EPOCH = date(1899, 12, 30)

_DATA = re.compile(r'(?<!\d)(\d{1,2})(?:/(\d{1,2})(?:/(\d{2,4}))?)?(?!\d)')
_TOKEN = re.compile(r'(?<!\d)\d{1,2}(?:/\d{1,2}(?:/\d{2,4})?)?(?!\d)|\ba\b|\baté\b')


def serial_para_data(valor):
    return EXCEL_EPOCH + timedelta(days=int(float(valor)))


def interpretar_periodo(texto, ano=ANO_PADRAO):
    """Converte o texto do período numa lista ordenada de datas.

    Exemplos aceitos: '9,10 e 11/02', '20/01 a 09/02', '25 e 26/02/2026',
    '14 (Turma 1) e 15/09 (Turma 2)', '23 e 01/10' (23/09 e 01/10).
    Intervalos com 'a' incluem apenas dias úteis.
    """
    if texto is None:
        return []
    s = str(texto).strip().lower()
    if not s:
        return []
    if re.fullmatch(r'\d{4,6}(\.0+)?', s):
        return [serial_para_data(s)]
    # Observações de remarcação citam a data antiga: descartar o trecho inteiro.
    s = re.sub(r'\([^)]*(transf|tranf|remarc|reman|adiad|mudad|antes)[^)]*\)', ' ', s)
    s = re.sub(r'\b(turma|módulo|modulo|parte|etapa|grupo|aula)\s*\d+', ' ', s)
    s = s.replace('(', ' ').replace(')', ' ')

    itens = []  # cada item: [dia, mes|None, ano|None] ou 'a'
    for tok in _TOKEN.findall(s):
        if tok in ('a', 'até'):
            if itens and itens[-1] != 'a':
                itens.append('a')
            continue
        m = _DATA.fullmatch(tok)
        dia, mes, an = m.group(1), m.group(2), m.group(3)
        an = int(an) + (2000 if an and len(an) == 2 else 0) if an else None
        itens.append([int(dia), int(mes) if mes else None, an])
    while itens and itens[-1] == 'a':
        itens.pop()

    # Dias sem mês herdam o mês do próximo item que o tenha (da direita p/ esquerda).
    mes_seg, ano_seg, dia_seg = None, None, None
    for it in reversed(itens):
        if it == 'a':
            continue
        if it[1] is None:
            if mes_seg is None:
                return []
            m = mes_seg
            # '23 e 01/10' -> 23 pertence ao mês anterior
            if dia_seg is not None and it[0] > dia_seg and m == mes_seg:
                m = mes_seg - 1 or 12
            it[1] = m
        if it[2] is None:
            it[2] = ano_seg or ano
        mes_seg, ano_seg, dia_seg = it[1], it[2], it[0]

    datas = set()
    i = 0
    while i < len(itens):
        it = itens[i]
        d = _criar(it)
        if i + 2 < len(itens) and itens[i + 1] == 'a':
            fim = _criar(itens[i + 2])
            if d and fim:
                atual = d
                while atual <= fim and (fim - d).days < 400:
                    if atual.weekday() < 5:
                        datas.add(atual)
                    atual += timedelta(days=1)
            i += 3
            continue
        if d:
            datas.add(d)
        i += 1
    return sorted(datas)


def _criar(it):
    try:
        return date(it[2], it[1], it[0])
    except (ValueError, TypeError):
        return None


_HORA = re.compile(
    r'(\d{1,2})\s*h\s*(\d{2})?\s*(?:min)?\s*(?:às|as|a|-|–|até)\s*(\d{1,2})\s*h\s*(\d{2})?')


def interpretar_horario(texto):
    """Retorna intervalos em minutos [(inicio, fim), ...]; vazio se não reconhecido."""
    if not texto:
        return []
    s = str(texto).lower().replace('às', 'às')
    out = []
    for h1, m1, h2, m2 in _HORA.findall(s):
        ini = int(h1) * 60 + int(m1 or 0)
        fim = int(h2) * 60 + int(m2 or 0)
        if fim > ini:
            out.append((ini, fim))
    return out


def formatar_periodo(datas):
    """Gera um texto de período padronizado a partir de datas (usado em novos eventos)."""
    datas = sorted(set(datas))
    if not datas:
        return ''
    partes = [d.strftime('%d/%m') for d in datas]
    if len(partes) == 1:
        return partes[0]
    return ', '.join(partes[:-1]) + ' e ' + partes[-1]
