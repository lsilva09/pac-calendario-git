"""Importa a aba PAC da planilha para o banco do Calendário PAC v2 (somente leitura da planilha).

Uso:  python3 importar.py ["caminho/da/planilha.xlsx"] [--substituir] [--a-partir-do-mes=9]

--a-partir-do-mes=N importa só eventos com alguma data a partir do mês N
(eventos sem data entram pelo mês do bloco da planilha). Eventos que começam
antes e continuam no mês N entram com todas as datas.
"""
import json
import os
import re
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)

import db  # noqa: E402
from periodo import interpretar_periodo, interpretar_horario, horario_por_dia  # noqa: E402
from planilha import Planilha  # noqa: E402

PLANILHA_PADRAO = os.path.join(os.path.dirname(AQUI), 'PAC 2026.xlsx')
COLUNAS = {'B': 'proad', 'C': 'nome', 'E': 'area', 'F': 'origem', 'G': 'instrutor', 'H': 'parceria',
           'J': 'diarias', 'K': 'carga_horaria', 'L': 'publico', 'M': 'modalidade', 'O': 'situacao'}


def tipo_local(nome):
    n = nome.lower()
    if n.startswith('plataforma'):
        return 'virtual'
    if n == 'evento externo':
        return 'externo'
    return 'fisico'


def hhmm(minutos):
    return f'{minutos // 60:02d}:{minutos % 60:02d}'


def separar_local(texto, oficiais):
    v = re.sub(r'\s+', ' ', texto or '').strip()
    if not v:
        return []
    if v in oficiais:
        return [v]
    return [p.strip() for p in v.split(' / ') if p.strip()]


def importar(caminho, substituir=False, a_partir_do_mes=None):
    con = db.conectar()
    ja = con.execute('SELECT COUNT(*) FROM evento').fetchone()[0]
    if ja and not substituir:
        sys.exit(f'O banco já tem {ja} eventos. Use --substituir para apagar tudo e importar de novo '
                 '(um backup é feito antes).')
    if ja:
        con.close()
        print('Backup:', db.backup(forcar=True))
        con = db.conectar()

    with open(os.path.join(AQUI, 'locais.json'), encoding='utf-8') as f:
        oficiais = json.load(f)['locais']
    eventos, cabecalhos, _ = Planilha(caminho, '/dev/null').ler()

    with con:
        con.execute('DELETE FROM sessao')
        con.execute('DELETE FROM evento')
        con.execute('DELETE FROM local')
        ids_local = {}
        for nome in oficiais:
            ids_local[nome] = con.execute('INSERT INTO local (nome, tipo) VALUES (?, ?)',
                                          (nome, tipo_local(nome))).lastrowid
        resumo = {'eventos': 0, 'sessoes': 0, 'revisar': 0, 'sem_data': 0}
        for ev in eventos:
            c = ev['campos']
            avisos = []
            anteriores = [r for r in cabecalhos if r < ev['linha']]
            mes_bloco = cabecalhos[max(anteriores)] if anteriores else None

            datas = interpretar_periodo(c['A'])
            if a_partir_do_mes:
                ref = max(d.month for d in datas) if datas else (mes_bloco or 0)
                if ref < a_partir_do_mes:
                    continue
            if c['A'].strip() and not datas:
                avisos.append(f'PERÍODO não reconhecido: “{c["A"]}”. Cadastre as datas manualmente.')
            elif '(' in c['A'] or re.search(r'[a-zçã]{4,}', c['A'].lower().replace(' a ', ' ')):
                avisos.append(f'PERÍODO tinha observações: “{c["A"]}”. Confira as datas.')

            intervalos = interpretar_horario(c['I'])
            if c['I'].strip() and not intervalos and 'aplic' not in c['I'].lower():
                avisos.append(f'HORÁRIO não reconhecido: “{c["I"]}”.')
            por_dia = {}
            if re.search(r'\d{1,2}/\d{1,2}', c['I']):
                por_dia = horario_por_dia(c['I'])
                if datas and por_dia and all(d in por_dia for d in datas):
                    avisos.append(f'Horário diferente por dia importado de “{c["I"]}”. Confira as sessões.')
                else:
                    por_dia = {}
                    avisos.append(f'HORÁRIO parece variar por dia: “{c["I"]}”. Ajuste cada sessão.')

            locais = separar_local(c['N'], oficiais)
            for nome in locais:
                if nome not in ids_local:
                    ids_local[nome] = con.execute('INSERT INTO local (nome, tipo) VALUES (?, ?)',
                                                  (nome, tipo_local(nome))).lastrowid
                    avisos.append(f'Local “{nome}” não estava na lista oficial e foi criado.')

            dados = {campo: c[col] for col, campo in COLUNAS.items()}
            dados['carga_horaria'] = dados['carga_horaria'].replace('.', ',') if dados['carga_horaria'] else ''
            origem = f'PERÍODO: {c["A"] or "—"}\nHORÁRIO: {c["I"] or "—"}\nLOCAL: {c["N"] or "—"}'
            agora = db.agora()
            evento_id = con.execute(
                'INSERT INTO evento (nome, proad, area, origem, instrutor, parceria, diarias, carga_horaria, '
                'publico, modalidade, situacao, mes_referencia, revisar, origem_planilha, linha_planilha, '
                'criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (dados['nome'] or '(sem nome)', dados['proad'], dados['area'], dados['origem'],
                 dados['instrutor'], dados['parceria'], dados['diarias'], dados['carga_horaria'],
                 dados['publico'], dados['modalidade'], dados['situacao'], mes_bloco,
                 '\n'.join(avisos), origem, ev['linha'], agora, agora)).lastrowid

            faixas = [(hhmm(i), hhmm(f)) for i, f in intervalos] or [(None, None)]
            for d in datas:
                faixas_dia = [(hhmm(i), hhmm(f)) for i, f in por_dia[d]] if d in por_dia else faixas
                for ini, fim in faixas_dia:
                    for lid in ([ids_local[n] for n in locais] or [None]):
                        con.execute('INSERT INTO sessao (evento_id, data, inicio, fim, local_id) VALUES (?, ?, ?, ?, ?)',
                                    (evento_id, d.isoformat(), ini, fim, lid))
                        resumo['sessoes'] += 1
            resumo['eventos'] += 1
            resumo['revisar'] += bool(avisos)
            resumo['sem_data'] += not datas
    con.close()
    return resumo


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    caminho = os.path.abspath(args[0] if args else PLANILHA_PADRAO)
    mes = next((int(a.split('=')[1]) for a in sys.argv if a.startswith('--a-partir-do-mes=')), None)
    r = importar(caminho, '--substituir' in sys.argv, mes)
    print(f"Importados {r['eventos']} eventos e {r['sessoes']} sessões de {caminho}")
    print(f"{r['sem_data']} evento(s) sem data · {r['revisar']} evento(s) marcados para revisar")
