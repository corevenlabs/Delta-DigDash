import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const configFile = name => new URL(`./config/${name}`, import.meta.url);
const key = value => String(value).toUpperCase();
const number = value => value === null || value === undefined || value === ''
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const round = value => value == null ? null : Math.round((value + Number.EPSILON) * 100) / 100;

/** Cliente de lectura. Los POST se limitan al login y consultas /list. */
export class LaudusClient {
  constructor({ rut, usuario, password, fetchImpl = fetch, pageSize = 100,
    maxRequests = 1800 } = {}) {
    if (!rut || !usuario || !password) throw new Error('Faltan RUT, usuario o contraseña de Laudus.');
    if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('pageSize inválido.');
    this.credentials = { companyVATId: rut, userName: usuario, password };
    this.fetch = fetchImpl;
    this.pageSize = pageSize;
    this.maxRequests = maxRequests;
    this.requests = 0;
    this.cache = new Map();
  }

  async request(path, body, renewed = false, attempt = 0) {
    if (!path.startsWith('/') || path.includes('://')) throw new Error('Ruta Laudus inválida.');
    if (body !== undefined && path !== '/security/login' && !path.endsWith('/list')) {
      throw new Error('Solo se permiten consultas de lectura.');
    }
    if (path !== '/security/login' && !this.token) await this.login();
    if (++this.requests > this.maxRequests) throw new Error('Se alcanzó el límite configurado de llamadas. Exportación cancelada.');
    const response = await this.fetch(`https://api.laudus.cl${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json',
        ...(path !== '/security/login' ? { Authorization: `Bearer ${this.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 401 && path !== '/security/login' && !renewed) {
      await this.login();
      return this.request(path, body, true);
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await new Promise(done => setTimeout(done, 500 * 2 ** attempt));
      return this.request(path, body, renewed, attempt + 1);
    }
    if (response.status === 204) return { data: [], partial: false };
    if (!response.ok) throw new Error(`Laudus HTTP ${response.status} en ${path}.`);
    return { data: await response.json(), partial: response.status === 206 };
  }

  async login() {
    const { data } = await this.request('/security/login', this.credentials);
    if (!data?.token) throw new Error('El login no devolvió un token.');
    this.token = data.token;
  }

  async list(path, idField, filterBy = []) {
    const result = [];
    const seen = new Set();
    for (let offset = 0; ; ) {
      const { data, partial } = await this.request(path, {
        options: { offset, limit: this.pageSize }, fields: [idField], filterBy,
        orderBy: [{ field: idField, direction: 'ASC' }],
      });
      if (!Array.isArray(data)) throw new Error(`Formato de listado no reconocido: ${path}. Se esperaba un array.`);
      if (!data.length) {
        if (partial) throw new Error('Página parcial vacía: no es posible continuar.');
        break;
      }
      for (const row of data) {
        const id = row[idField];
        if (id == null || seen.has(String(id))) throw new Error(`ID ausente o página repetida en ${path}.`);
        seen.add(String(id)); result.push(id);
      }
      offset += data.length;
      // Una respuesta 206 puede contener menos filas que el límite solicitado.
      if (!partial && data.length < this.pageSize) break;
    }
    return result;
  }

  async get(path) {
    if (!this.cache.has(path)) this.cache.set(path, (await this.request(path)).data);
    return this.cache.get(path);
  }
}

export function toCsv(rows, headers, separator = ';') {
  if (separator.length !== 1 || /["\r\n]/.test(separator)) throw new Error('Separador CSV inválido.');
  const escape = value => {
    const text = value == null ? '' : String(value);
    return text.includes(separator) || /["\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return '\uFEFF' + [headers, ...rows.map(row => headers.map(header => row[header]))]
    .map(row => row.map(escape).join(separator)).join('\r\n') + '\r\n';
}

function dateOnly(value) { return value ? String(value).slice(0, 10).replaceAll('-', '') : null; }
function validateDates(desde, hasta) {
  for (const value of [desde, hasta]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
      throw new Error('Las fechas deben ser válidas, con formato YYYY-MM-DD.');
    }
  }
  if (desde > hasta) throw new Error('La fecha inicial supera a la final.');
}

/**
 * Genera CSV y JSON según el Excel de mapeo. No envía datos a un servidor.
 * resolveCost(context) -> costo TOTAL histórico de la línea, sin signo.
 * resolveOrder(context) -> { issuedDate, deliveryDate }; resolver con trazabilidad real.
 * resolveStockValue({product, warehouse, date}) -> { totalCost, averageCost, lastPurchaseCost }.
 * exchangeRate(context) -> CLP por EUR para la fecha correspondiente.
 * Todas las funciones resolver pueden ser async. Un dato desconocido queda null.
 */
export async function generarArchivosDigdash({
  desde, hasta, salida = './salida', empresa, bodega,
  rut = process.env.LAUDUS_RUT, usuario = process.env.LAUDUS_USUARIO,
  password = process.env.LAUDUS_PASSWORD, client,
  clpPorEur, exchangeRate, resolveCost, resolveOrder, resolveStockValue,
  includeStock = false, stockWarehouseMap, allowCatalogCost = false, strict = false,
  separator = ';', creditSigns = 'positive',
  productLookupPath = configFile('productos-digdash.json'),
} = {}) {
  validateDates(desde, hasta);
  if (!empresa || !bodega) throw new Error('Configura empresa y bodega de destino.');
  if (includeStock && (!stockWarehouseMap || typeof stockWarehouseMap !== 'object')) {
    throw new Error('Para stock configura stockWarehouseMap: { codigoLaudus: codigoDigdash }.');
  }
  if (includeStock && new Set(Object.values(stockWarehouseMap)).size !== Object.values(stockWarehouseMap).length) {
    throw new Error('La consolidación de varias bodegas en una debe definirse antes de exportar stock.');
  }
  if (!['positive', 'signed'].includes(creditSigns)) throw new Error('creditSigns debe ser positive o signed.');
  if (clpPorEur != null && !(number(clpPorEur) > 0)) throw new Error('clpPorEur debe ser mayor que cero.');
  const api = client ?? new LaudusClient({ rut, usuario, password });
  const mapping = JSON.parse(await readFile(configFile('mapeo.json'), 'utf8'));
  const lookup = JSON.parse(await readFile(productLookupPath, 'utf8'));
  const productsBySku = new Map();
  for (const row of lookup) {
    const sku = String(row.productSKU ?? '').trim();
    if (!sku) continue;
    if (productsBySku.has(sku)) throw new Error(`SKU duplicado en equivalencias: ${sku}`);
    productsBySku.set(sku, row);
  }
  const outputs = Object.fromEntries(Object.keys(mapping).map(name => [name, []]));
  if (!includeStock) delete outputs['MINOS STOCK PERIODE'];
  const issues = new Map();
  const warn = (code, detail) => {
    const id = `${code}:${detail}`;
    if (!issues.has(id)) issues.set(id, { code, detail, count: 0 });
    issues.get(id).count++;
  };
  if (allowCatalogCost) warn('COSTO_ESTIMADO', 'Se autorizó costo del catálogo actual; no es costo histórico.');
  if (!resolveOrder) warn('PEDIDO_PENDIENTE', 'Falta resolver la relación factura/pedido para fechas del pedido y entrega.');
  const makeRow = (sheet, values, productLookup = {}) => {
    const normalized = Object.fromEntries(Object.entries(values).map(([k, v]) => [key(k), v]));
    const productFields = Object.fromEntries(Object.entries(productLookup).map(([k, v]) => [key(k), v]));
    return Object.fromEntries(mapping[sheet].map(spec => {
      const field = key(spec.field);
      // Las notas del libro se usan como especificaciones de mapeo, nunca como código.
      if (/dejar vacio/i.test(spec.notes)) return [spec.field, null];
      if (Object.hasOwn(normalized, field)) {
        if (normalized[field] == null) warn('CAMPO_PENDIENTE', `${sheet}.${spec.field}`);
        return [spec.field, normalized[field]];
      }
      if (/lookup sales product/i.test(spec.source) && Object.hasOwn(productFields, field)) {
        const value = productFields[field];
        if (/^#(N\/A|REF!|VALUE!|DIV\/0!|NAME\?)/.test(String(value))) {
          warn('ERROR_EN_EQUIVALENCIA', `${sheet}.${spec.field}`);
          return [spec.field, null];
        }
        return [spec.field, value];
      }
      if (spec.static !== '') return [spec.field, number(spec.static) ?? spec.static];
      warn('CAMPO_PENDIENTE', `${sheet}.${spec.field}`);
      return [spec.field, null];
    }));
  };
  const getRate = async context => {
    const rate = number(exchangeRate ? await exchangeRate(context) : clpPorEur);
    if (!(rate > 0)) { warn('TIPO_CAMBIO_PENDIENTE', 'Falta tasa CLP por EUR válida.'); return null; }
    return rate;
  };
  const productIds = await api.list('/production/products/list', 'productId');
  const products = new Map();
  for (const id of productIds) {
    const product = await api.get(`/production/products/${encodeURIComponent(id)}`);
    products.set(String(id), product);
    const equivalence = productsBySku.get(String(product.sku ?? '').trim());
    if (!equivalence) warn('SKU_SIN_EQUIVALENCIA', String(product.sku ?? id));
    outputs['MINOS ARTICLES'].push(makeRow('MINOS ARTICLES', {
      ID_DATE_CREATION_ARTICLE: dateOnly(product.createdAt),
    }, equivalence));
  }
  const invoiceIds = await api.list('/sales/invoices/list', 'salesInvoiceId', [
    { field: 'issuedDate', operator: '>=', value: `${desde}T00:00:00` },
    { field: 'issuedDate', operator: '<', value: new Date(Date.parse(hasta) + 86400000).toISOString().slice(0, 10) + 'T00:00:00' },
  ]);
  for (const id of invoiceIds) {
    const invoice = await api.get(`/sales/invoices/${encodeURIComponent(id)}`);
    if (invoice.nullDoc) { warn('DOCUMENTO_ANULADO_EXCLUIDO', String(id)); continue; }
    if (!Array.isArray(invoice.items) || !invoice.items.length) { warn('FACTURA_SIN_LINEAS', String(id)); continue; }
    const customerId = invoice.customer?.customerId;
    const customer = customerId == null ? invoice.customer ?? {} : await api.get(`/sales/customers/${encodeURIComponent(customerId)}`);
    const docName = String(invoice.docType?.name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const credit = docName.includes('nota de credito');
    const docKind = credit ? 'A' : /factura|nota de debito/.test(docName) ? 'F' : null;
    if (!docKind) warn('TIPO_DOCUMENTO_PENDIENTE', `${id}: ${invoice.docType?.name}`);
    const categoryName = String(customer.customerCategory?.name ?? '').toUpperCase();
    const categoryId = String(customer.customerCategory?.customerCategoryId ?? '');
    const category = categoryName.includes('EXPORT GRUPO') || categoryId === '004' ? 'GR'
      : categoryName.includes('DISTRIBUIDORES') || ['001', '003'].includes(categoryId) ? 'CL' : null;
    if (!category) warn('CATEGORIA_CLIENTE_PENDIENTE', String(customerId));
    const order = resolveOrder ? await resolveOrder({ invoice, client: api }) : null;
    const rate = await getRate({ invoice, date: invoice.issuedDate });
    let invoiceNet = 0;
    let completeNet = true;
    for (const item of invoice.items) {
      const product = products.get(String(item.product?.productId)) ?? item.product ?? {};
      const sku = String(product.sku ?? '').trim();
      const equivalence = productsBySku.get(sku);
      if (!equivalence) warn('SKU_SIN_EQUIVALENCIA', sku || `${id}/${item.itemId}`);
      const qty = number(item.quantity), price = number(item.unitPrice), discount = number(item.discountPercentage);
      const sign = credit && creditSigns === 'positive' ? -1 : 1;
      const net = qty == null || price == null || discount == null ? null : qty * price * (1 - discount / 100);
      if (net == null) { completeNet = false; warn('NETO_PENDIENTE', `${id}/${item.itemId}`); }
      else invoiceNet += net;
      const context = { invoice, item, product, client: api };
      let cost = number(resolveCost ? await resolveCost(context) : null);
      if (cost == null && allowCatalogCost && qty != null && number(product.unitCost) > 0) {
        cost = Math.abs(qty) * number(product.unitCost);
      }
      if (cost == null) warn('COSTO_HISTORICO_PENDIENTE', `${id}/${item.itemId}`);
      const signedCost = cost == null ? null : credit ? -Math.abs(cost) : Math.abs(cost);
      const signedNet = net == null ? null : net * sign;
      const margin = signedNet == null || signedCost == null ? null : signedNet - signedCost;
      const values = {
        ID_COMPANY: empresa, ID_WAREHOUSE: bodega,
        ID_DATE_INVOICE: dateOnly(invoice.issuedDate), ID_DATE_ORDER: dateOnly(order?.issuedDate),
        ID_DATE_DELIVERY: dateOnly(order?.deliveryDate),
        ID_HS_CUSTOMER_INVOICED: customerId ?? null,
        ID_CUSTOMER_CODE: customerId ?? null, ID_CUSTOMER_INVOICED: customerId ?? null,
        ID_CUSTOMER_NAME: customer.name ?? customer.legalName ?? null,
        ID_CUSTOMER_CITY: customer.cityBilling ?? customer.city ?? null,
        ID_CUSTOMER_COUNTRY: customer.countryBilling ?? customer.country ?? null,
        ID_CURRENCY_INVOICED: item.currencyCode ?? invoice.totalsOriginalCurrency?.currencyCode ?? null,
        ID_CUSTOMER_CATEGORY: category, ID_QUANTITY_INVOICED: qty == null ? null : qty * sign,
        ID_TO_LOCALE: round(signedNet), ID_TO_EURO: rate ? round(signedNet == null ? null : signedNet / rate) : null,
        ID_MARGIN_LOCALE: round(margin), ID_MARGIN_EURO: rate ? round(margin == null ? null : margin / rate) : null,
        ID_COST_PRICE_LOCALE: round(signedCost), ID_COST_PRICE_EURO: rate ? round(signedCost == null ? null : signedCost / rate) : null,
        ID_INVOICE_NUMBER: invoice.docNumber ?? null, ID_A_F_ORDER: docKind,
        ID_COMPANY_CUSTOMER_CATEGORY: empresa,
      };
      outputs['MINOS SALES'].push(makeRow('MINOS SALES', values, equivalence));
      outputs['MINOS STOCK SALES'].push(makeRow('MINOS STOCK SALES', values, equivalence));
      // MINOS LIGHT usa categorías de Laudus; las otras hojas usan el lookup corporativo.
      outputs['MINOS LIGHT'].push(makeRow('MINOS LIGHT', {
        ...values, ID_ARTICLE_CLASS1: product.productCategory?.productCategoryId ?? null,
        ID_CUSTOMER_CATEGORY: customer.customerCategory?.customerCategoryId ?? null,
      }, equivalence));
    }
    if (completeNet && number(invoice.totals?.net) != null && Math.abs(invoiceNet - Number(invoice.totals.net)) > 1) {
      warn('NETO_NO_CONCILIA', `Factura ${id}: líneas=${round(invoiceNet)}; cabecera=${invoice.totals.net}. Revisar descuentos/redondeo/cargos.`);
    }
  }
  if (includeStock) {
    const data = await api.get(`/production/products/stockByWarehouses?dateTo=${encodeURIComponent(hasta + 'T23:59:59')}`);
    if (!Array.isArray(data?.products)) throw new Error('Formato de stock no reconocido.');
    for (const entry of data.products) {
      if (!Array.isArray(entry.warehouses)) throw new Error('Faltan bodegas en respuesta de stock.');
      for (const warehouse of entry.warehouses) {
        const targetWarehouse = stockWarehouseMap[warehouse.warehouseId];
        if (!targetWarehouse) throw new Error(`Falta equivalencia de bodega ${warehouse.warehouseId}.`);
        const product = products.get(String(entry.productId)) ?? {};
        const valuation = resolveStockValue ? await resolveStockValue({ product, warehouse, date: hasta, client: api }) : null;
        if (!valuation) warn('VALORIZACION_PENDIENTE', `${entry.productId}/${warehouse.warehouseId}`);
        const rate = await getRate({ date: hasta, product });
        const total = number(valuation?.totalCost);
        outputs['MINOS STOCK PERIODE'].push(makeRow('MINOS STOCK PERIODE', {
          ID_COMPANY: empresa, ID_WAREHOUSE: targetWarehouse, ID_DATE_INVOICE: dateOnly(hasta),
          ID_QT_AVAILABLE: number(warehouse.stock), ID_VALUE_LOCAL: total,
          ID_VALUE_EURO: total != null && rate ? round(total / rate) : null,
          ID_PUMP_LOCALE: number(valuation?.averageCost), ID_DCA_LOCALE: number(valuation?.lastPurchaseCost),
        }, productsBySku.get(String(product.sku ?? '').trim())));
      }
    }
  }
  const report = {
    desde, hasta, empresa, bodega, generatedAt: new Date().toISOString(),
    ready: issues.size === 0, requests: api.requests ?? null,
    rows: Object.fromEntries(Object.entries(outputs).map(([name, rows]) => [name, rows.length])),
    issues: [...issues.values()],
  };
  await mkdir(salida, { recursive: true });
  await writeFile(join(salida, 'reporte.json'), JSON.stringify(report, null, 2));
  if (strict && !report.ready) throw new Error(`Hay pendientes. Revisa ${join(salida, 'reporte.json')}. No se generaron archivos nuevos de datos.`);
  for (const [name, rows] of Object.entries(outputs)) {
    const filename = name.toLowerCase().replaceAll(' ', '_');
    await writeFile(join(salida, filename + '.csv'), toCsv(rows, mapping[name].map(spec => spec.field), separator));
    await writeFile(join(salida, filename + '.json'), JSON.stringify(rows, null, 2));
  }
  return { datos: outputs, reporte: report, salida: resolve(salida) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [desde, hasta] = process.argv.slice(2);
  generarArchivosDigdash({ desde, hasta, empresa: process.env.DIGDASH_EMPRESA,
    bodega: process.env.DIGDASH_BODEGA, clpPorEur: process.env.CLP_POR_EUR || undefined,
  }).then(({ reporte, salida }) => console.log(JSON.stringify({ salida, ...reporte }, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
