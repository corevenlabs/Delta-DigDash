# Laudus → Digdash

Extracción de lectura para Node.js 22 o superior, sin dependencias externas.
Basada en `MAPEO LAUDUS - DIGDASH V1611.xlsx`. Las reglas y equivalencias extraídas
del libro están en `config/mapeo.json` y `config/productos-digdash.json` (85 filas).
Se conservan los nombres y el orden de columnas, incluidos errores tipográficos del contrato.

## Ejecutar

1. Copiar `.env.example` a `.env` y completar las credenciales locales y códigos de destino.
2. Ejecutar:

```sh
node --env-file=.env laudus-digdash.js 2026-11-01 2026-11-30
```

Se generan CSV UTF-8 con BOM, separador `;`, números con punto decimal, fechas
`YYYYMMDD`, y versiones JSON en `salida/`. El separador y las fechas de entrega
deben confirmarse con Digdash. Los null se representan vacíos en CSV.
`reporte.json` contiene filas, consultas realizadas y pendientes.

No hay envío automático: falta el destino y protocolo de recepción de Digdash
(carga manual, carpeta, SFTP o API). No se ha ejecutado contra una empresa real.
Las pruebas usan respuestas simuladas.

## Usar la función

```js
import { generarArchivosDigdash } from './laudus-digdash.js';

const resultado = await generarArchivosDigdash({
  desde: '2026-11-01',
  hasta: '2026-11-30',
  empresa: 'SCL', // confirmar
  bodega: 'WCL', // confirmar
  salida: './salida/2026-11',
  // clpPorEur: tasa aprobada para este período,
  // strict: true, // solo genera datos si el reporte no tiene pendientes
});
console.log(resultado.reporte);
```

Las credenciales se leen de `LAUDUS_RUT`, `LAUDUS_USUARIO`, `LAUDUS_PASSWORD`.
No se imprimen tokens ni respuestas de autenticación.

## Alcance y reglas pendientes

- Por defecto genera ARTICLES, SALES, LIGHT y STOCK SALES. SALES tiene una fila
  por línea de documento. El maestro ARTICLES incluye todo el catálogo.
- Cada producto, cliente y factura se consulta por ID, con caché en la ejecución.
  Se prioriza trazabilidad sobre número de llamadas. Cliente configurable con
  `maxRequests` (1800 por defecto) y `pageSize` (100). El límite es por ejecución;
  no conoce el consumo mensual del RUT ni el de otras integraciones.
- El listado debe devolver un array de objetos. Si la cuenta devuelve otro
  envoltorio, la función se detiene para adaptar el contrato con una respuesta real.
  Pagina por offset, respeta respuestas parciales 206, renueva token ante 401 y
  reintenta 429/5xx hasta dos veces.
- Excluye documentos anulados. Por defecto supone que las notas de crédito vienen
  con cantidad e importe positivos y les aplica signo negativo. Si Laudus ya
  devuelve líneas firmadas, configurar `creditSigns: 'signed'` tras validar ejemplos.
  Las notas de crédito de corrección de texto/monto necesitan validación adicional.
- El neto usa cantidad × precio × (1 − descuento/100). Se compara con neto de
  cabecera y reporta discrepancias superiores a 1 unidad monetaria. No se reparte
  automáticamente una discrepancia ni se inventan cargos o descuentos globales.
- `resolveCost({ invoice, item, product, client })` debe retornar el costo TOTAL
  histórico de la línea, sin signo. Sin resolverlo, costo y margen quedan null.
  `allowCatalogCost: true` habilita una estimación con costo actual y la marca en
  el reporte; no sirve como margen histórico validado.
- `exchangeRate(context)` puede devolver CLP por EUR para cada fecha. Alternativamente
  `clpPorEur` aplica una tasa fija explícita. Sin tasa, euros quedan null.
- `resolveOrder({ invoice, client })` debe devolver `issuedDate` y `deliveryDate`
  después de resolver el pedido por trazabilidad. No se une por nombre de cliente
  ni por número de orden de compra. Cliente pedido/entrega, idioma y otros campos
  no resueltos aparecen en el reporte.
- LIGHT conserva las categorías de Laudus; las demás estructuras usan el lookup
  corporativo. Sus campos de familia raíz, gama y presupuesto siguen pendientes.
- `includeStock: true` agrega STOCK PERIODE a la fecha `hasta` (un corte por llamada,
  no todos los cierres mensuales del intervalo). Las existencias vienen por bodega
  de origen. Requiere `stockWarehouseMap: { '001': 'WCL' }` con la equivalencia de
  cada bodega. Se rechazan equivalencias faltantes y varias bodegas con el mismo
  destino; esa consolidación debe implementarse con una regla aprobada.
  `resolveStockValue({ product, warehouse, date, client })` debe devolver
  `{ totalCost, averageCost, lastPurchaseCost }`; sin él, valorización queda null.
- Si faltan equivalencias SKU, los atributos corporativos quedan vacíos y se
  reportan; no se reemplazan por códigos de Laudus silenciosamente.
- `strict: true` escribe el reporte y lanza error ante cualquier pendiente.
  No borra exportaciones anteriores: utilizar una carpeta nueva por ejecución
  y comprobar siempre `reporte.ready` antes de entregar datos.

## Verificar

```sh
npm test
```

## Generar Excel de la vista previa

El script convierte los JSON de `salida/vista-previa/` a un Excel con las cuatro
tablas de muestra, un resumen, una lectura vertical de la primera venta y los
pendientes. No consulta Laudus ni envía datos. Está destinado a la muestra de una
factura, no a una exportación completa de stock.

```sh
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt
.venv/bin/python scripts/crear_excel.py
```

Resultado: `outputs/vista-previa-digdash/Vista_previa_Laudus_DigDash.xlsx`.
Se pueden indicar otras carpetas mediante `--entrada` y `--salida`.
Los archivos con datos y las credenciales permanecen excluidos de Git.

Documentación oficial: https://laudus.cl/ayuda/api/

Especificación de endpoints consultada: https://api.laudus.cl/swagger/index.html

Para terminar la integración faltan respuestas reales de prueba, confirmar
empresa/bodegas, signos de documentos, costo histórico, tasas EUR y contrato de
recepción. Un CSV generado con pendientes es un borrador para revisión.
