"""Padroniza os nomes de ambientes (coluna LOCAL) da aba PAC.

Uso:  python3 padronizar_locais.py            -> apenas mostra o que mudaria
      python3 padronizar_locais.py --aplicar  -> grava (com backup automático)
"""
import os
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)

from planilha import Planilha  # noqa: E402

# valor atual exato -> nome padronizado
MAPA = {
    'Labor': 'Laboratório de Inovação (LABOR - Sede do TRT-13)',
    'LABOR': 'Laboratório de Inovação (LABOR - Sede do TRT-13)',
    'Sede TRT/ LABOR': 'Laboratório de Inovação (LABOR - Sede do TRT-13)',
    'Auditório TRT/Pleno': 'Auditório do Tribunal Pleno',
    'Auditório do Fórum Irineu Jóffily\r': 'Auditório do Fórum Irineu Jóffily',
    'Plataforma da Empresa ': 'Plataforma da Empresa Contratada',
    'BPchoque': 'Batalhão de Policiamento de Choque – BPChoque',
    'Aud. Forum Maximiano': 'Auditório FMF',
    'CPchoque': 'Batalhão de Policiamento de Choque – BPChoque',
    'Auditório do Fórum Irineu Jóffily': 'Auditório do Fórum Irineu Joffily',
    # Eventos em mais de um ambiente: nomes padronizados separados por " / "
    'Labor\nSede TRT/ Pleno':
        'Laboratório de Inovação (LABOR - Sede do TRT-13) / Auditório do Tribunal Pleno',
    'Auditório do Pleno / Sala de Reuniões da PresidÊncia e Sala de Treinamentos da EJUD':
        'Auditório do Tribunal Pleno / Sala de Reuniões da Presidência / Sala de Treinamentos da EJud-13',
}


def main():
    aplicar = '--aplicar' in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    caminho = args[0] if args else os.path.join(os.path.dirname(AQUI), 'PAC 2026.xlsx')
    p = Planilha(caminho, os.path.join(AQUI, 'backups'))
    eventos, _, _ = p.ler()
    mudancas = {e['linha']: (e['campos']['N'], MAPA[e['campos']['N']])
                for e in eventos if e['campos']['N'] in MAPA}
    for linha, (antigo, novo) in sorted(mudancas.items()):
        print(f'linha {linha:>3}: {antigo!r:45} -> {novo}')
    print(f'\n{len(mudancas)} célula(s) a alterar.')
    if aplicar and mudancas:
        p.substituir_em_massa('N', mudancas)
        print('Gravado. Backup salvo em', os.path.join(AQUI, 'backups'))
    elif mudancas:
        print('Nada foi gravado. Rode com --aplicar para gravar.')


if __name__ == '__main__':
    main()
