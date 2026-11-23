import json
import argparse
from pathlib import Path
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.worksheet.table import Table, TableStyleInfo

parser = argparse.ArgumentParser(description='Convierte la vista previa JSON de Laudus a Excel.')
parser.add_argument('--entrada', type=Path, default=Path(__file__).resolve().parents[1] / 'salida' / 'vista-previa')
parser.add_argument('--salida', type=Path, default=Path(__file__).resolve().parents[1] / 'outputs' / 'vista-previa-digdash')
args = parser.parse_args()
ROOT = args.entrada.resolve()
OUT = args.salida.resolve()
OUT.mkdir(parents=True, exist_ok=True)
report = json.loads((ROOT / 'reporte.json').read_text())
wb = Workbook()
summary = wb.active
summary.title = 'Resumen'
summary.append(['VISTA PREVIA LAUDUS → DIGDASH', ''])
summary.append(['Estado', 'BORRADOR: hay campos pendientes'])
summary.append(['Desde', report['desde']])
summary.append(['Hasta', report['hasta']])
summary.append(['Empresa configurada', report['empresa']])
summary.append(['Bodega configurada', report['bodega']])
summary.append(['Origen', 'Cuenta de prueba de Laudus; una factura seleccionada'])
summary.append(['Alcance', 'Muestra limitada; no representa todas las ventas del período'])
summary.append(['Campos vacíos', 'Pueden ser vacíos por diseño o datos pendientes; revisar Pendientes'])
summary.append(['Entrega', 'No enviado a Digdash'])
summary.append(['Stock de período', 'No incluido en esta muestra'])
summary.append(['Tabla', 'Filas'])

tables = {}
for index, (stem, title) in enumerate([
    ('minos_sales', 'MINOS SALES'), ('minos_articles', 'MINOS ARTICLES'),
    ('minos_light', 'MINOS LIGHT'), ('minos_stock_sales', 'MINOS STOCK SALES'),
], 1):
    rows = json.loads((ROOT / f'{stem}.json').read_text())
    tables[title] = rows
    summary.append([title, len(rows)])
    ws = wb.create_sheet(title)
    headers = list(rows[0]) if rows else []
    if headers:
        ws.append(headers)
        for row in rows:
            ws.append([row.get(h) for h in headers])
        for cell in ws[1]:
            cell.alignment = Alignment(wrap_text=True, vertical='center')
        ws.row_dimensions[1].height = 62
        if rows:
            tab = Table(displayName=f'Datos{index}', ref=ws.dimensions)
            tab.tableStyleInfo = TableStyleInfo(name='TableStyleMedium2', showRowStripes=True)
            ws.add_table(tab)
    ws.freeze_panes = 'C2'

vertical = wb.create_sheet('Ventas por campo', 1)
vertical.append(['Campo Digdash', 'Valor de la muestra', 'Observación'])
if tables['MINOS SALES']:
    for field, value in tables['MINOS SALES'][0].items():
        vertical.append([field, value, 'Vacío: revisar mapeo y pendientes' if value is None or value == '' else 'Valor disponible'])
vertical.freeze_panes = 'B2'
vertical.auto_filter.ref = vertical.dimensions

pending = wb.create_sheet('Pendientes')
pending.append(['Código', 'Detalle', 'Ocurrencias'])
for issue in report['issues']:
    pending.append([issue['code'], issue['detail'], issue['count']])
pending.freeze_panes = 'A2'
pending.auto_filter.ref = pending.dimensions

for ws in wb:
    ws.sheet_view.showGridLines = False
    for row in ws:
        for cell in row:
            cell.font = Font(name="Calibri", size=11)
            cell.alignment = Alignment(vertical="top", wrap_text=True)
    for column in ws.columns:
        ws.column_dimensions[column[0].column_letter].width = 27
    for row in range(2, ws.max_row + 1):
        ws.row_dimensions[row].height = 42
    ws.row_dimensions[1].height = 62
    if ws.title == "Resumen":
        ws.column_dimensions["A"].width = 43
        ws.column_dimensions["B"].width = 100
    if ws.title == "Ventas por campo":
        ws.column_dimensions["A"].width = 48
        ws.column_dimensions["B"].width = 52
        ws.column_dimensions["C"].width = 50
    if ws.title == "Pendientes":
        ws.column_dimensions["A"].width = 38
        ws.column_dimensions["B"].width = 115
        ws.column_dimensions["C"].width = 16
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.orientation = 'landscape'
    ws.page_setup.paperSize = ws.PAPERSIZE_A3
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.print_title_rows = '1:1'
    for cell in ws[1]:
        cell.font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
        cell.fill = PatternFill('solid', fgColor='17365D')
        cell.font = Font(name='Calibri', size=11, color='FFFFFF', bold=True)
        cell.alignment = Alignment(wrap_text=True, vertical='center')
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.font = Font(name='Calibri', size=11)
            cell.alignment = Alignment(vertical='top', wrap_text=True)
            if cell.data_type == 'f':
                cell.data_type = 's'  # Mantener como texto cualquier contenido de origen.
            if isinstance(cell.value, (int, float)):
                cell.number_format = '#,##0.00' if isinstance(cell.value, float) else '#,##0'
    for col in ws.columns:
        letter = col[0].column_letter
        max_len = max((len(str(c.value or '')) for c in col), default=10)
        ws.column_dimensions[letter].width = min(38, max(18, max_len + 2))
    if ws not in [summary, vertical, pending]:
        for row in list(ws.rows)[1:]:
            ws.row_dimensions[row[0].row].height = 44

summary.column_dimensions['A'].width = 30
summary.column_dimensions['B'].width = 88
summary.row_dimensions[1].height = 32
for row in range(2, summary.max_row + 1):
    summary.row_dimensions[row].height = 32
vertical.column_dimensions['A'].width = 44
vertical.column_dimensions['B'].width = 44
vertical.column_dimensions['C'].width = 44
for row in range(2, vertical.max_row + 1):
    vertical.row_dimensions[row].height = 32
pending.column_dimensions['A'].width = 34
pending.column_dimensions['B'].width = 105
pending.column_dimensions['C'].width = 16
for row in range(2, pending.max_row + 1):
    pending.row_dimensions[row].height = 42

target = OUT / 'Vista_previa_Laudus_DigDash.xlsx'
wb.save(target)
check = load_workbook(target, data_only=False)
assert len(check.sheetnames) == 7
assert check['MINOS SALES'].max_column == 87
for title, rows in tables.items():
    assert check[title].max_row == len(rows) + 1
    for i, row in enumerate(rows, 2):
        for j, value in enumerate(row.values(), 1):
            assert check[title].cell(i, j).value == (None if value == '' else value)
assert not any(c.data_type == 'f' for ws in check for row in ws for c in row)
print(target)
print({ws.title: {'rows': ws.max_row, 'columns': ws.max_column} for ws in check})
