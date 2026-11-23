import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaudusClient, generarArchivosDigdash, toCsv } from './laudus-digdash.js';

test('continúa una página HTTP 206 corta y renueva el token una vez', async () => {
  const responses = [
    [200, { token: 'one' }], [401, {}], [200, { token: 'two' }],
    [206, [{ salesInvoiceId: '1' }]], [200, [{ salesInvoiceId: '2' }]],
  ];
  const offsets = [];
  const api = new LaudusClient({ rut: 'x', usuario: 'x', password: 'x', pageSize: 10,
    fetchImpl: async (url, init) => {
      if (url.endsWith('/list')) offsets.push(JSON.parse(init.body).options.offset);
      const [status, body] = responses.shift();
      return new Response(JSON.stringify(body), { status });
    },
  });
  assert.deepEqual(await api.list('/sales/invoices/list', 'salesInvoiceId'), ['1', '2']);
  assert.deepEqual(offsets, [0, 0, 1]);
  assert.equal(api.token, 'two');
});

function fixture() {
  return {
    list: async path => path.includes('products') ? [1] : ['F1', 'A1'],
    get: async path => {
      if (path.includes('/products/')) return { productId: 1, sku: '01-60-S990M', unitCost: 999,
        productCategory: { productCategoryId: '00O' } };
      if (path.includes('/customers/')) return { customerId: 1, name: 'Cliente; "prueba"',
        customerCategory: { customerCategoryId: '001' } };
      return { salesInvoiceId: path.split('/').at(-1), docNumber: 10,
        docType: { name: path.endsWith('A1') ? 'Nota de Crédito Electrónica' : 'Factura Electrónica' },
        issuedDate: '2026-11-01T13:00:00', customer: { customerId: 1 }, totals: { net: 180 },
        items: [{ itemId: 1, product: { productId: 1 }, quantity: 2,
          unitPrice: 100, discountPercentage: 10, currencyCode: 'CLP' }] };
    },
  };
}

test('cruza SKU, aplica descuento, costo y signo de nota de crédito; respeta columnas vacías', async () => {
  const salida = await mkdtemp(join(tmpdir(), 'digdash-'));
  try {
    const { datos, reporte } = await generarArchivosDigdash({
      desde: '2026-11-01', hasta: '2026-11-30', empresa: 'SCL', bodega: 'WCL',
      client: fixture(), salida, clpPorEur: 1000, resolveCost: async () => 60,
    });
    const [invoice, credit] = datos['MINOS SALES'];
    assert.equal(invoice.ID_Article_code, 'FFFM201RE0MD');
    assert.equal(invoice.ID_TO_Locale, 180);
    assert.equal(invoice.ID_Margin_Locale, 120);
    assert.equal(invoice.ID_TO_Euro, 0.18);
    assert.equal(credit.ID_TO_Locale, -180);
    assert.equal(credit.ID_Margin_Locale, -120);
    assert.equal(credit.ID_Quantity_invoiced, -2);
    assert.equal(credit.ID_A_F_ORDER, 'A');
    assert.equal(invoice.ID_Article_Brand, null);
    assert.equal(reporte.ready, false);
    const csv = await readFile(join(salida, 'minos_sales.csv'), 'utf8');
    assert.ok(csv.includes('"Cliente; ""prueba"""'));
    assert.equal(Object.keys(invoice).length, 87);
  } finally { await rm(salida, { recursive: true, force: true }); }
});

test('no usa costo actual ni inventa euros; strict impide generar datos nuevos', async () => {
  const salida = await mkdtemp(join(tmpdir(), 'digdash-'));
  try {
    const options = { desde: '2026-11-01', hasta: '2026-11-30', empresa: 'SCL', bodega: 'WCL', client: fixture(), salida };
    await assert.rejects(generarArchivosDigdash({ ...options, strict: true }), /pendientes/);
    await assert.rejects(readFile(join(salida, 'minos_sales.csv')), { code: 'ENOENT' });
    const { datos } = await generarArchivosDigdash(options);
    assert.equal(datos['MINOS SALES'][0].ID_Margin_Locale, null);
    assert.equal(datos['MINOS SALES'][0].ID_TO_Euro, null);
  } finally { await rm(salida, { recursive: true, force: true }); }
});

test('rechaza fechas imposibles antes de consultar y escapa CSV', async () => {
  await assert.rejects(generarArchivosDigdash({ desde: '2026-02-30', hasta: '2026-03-01' }), /fechas/);
  assert.equal(toCsv([{ a: 'uno\ndos', b: null }], ['a', 'b']), '\uFEFFa;b\r\n"uno\ndos";\r\n');
});

test('stock exige equivalencias explícitas y evita colisiones de bodegas', async () => {
  const options = { desde: '2026-11-01', hasta: '2026-11-30', empresa: 'SCL', bodega: 'WCL', includeStock: true };
  await assert.rejects(generarArchivosDigdash(options), /stockWarehouseMap/);
  await assert.rejects(generarArchivosDigdash({ ...options, stockWarehouseMap: { '001': 'WCL', '002': 'WCL' } }), /consolidación/);
});
