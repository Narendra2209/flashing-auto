import express, { Request, Response } from 'express';
import multer from 'multer';
import cors from 'cors';
import 'dotenv/config';

interface LineItem {
  item_number: number;
  colour: string;
  colour_code: string;
  folds: number;
  girth_original: number;
  girth_rounded: number;
  inventory_id: string;
  pieces: number;
  length: number;
  qty: number;
  tapered: boolean;
  notes: string;
}

interface Order {
  customer_name: string;
  po_number: string;
  job_number: string;
  contact: string;
  date_ordered: string;
  date_required: string;
  delivery_type: string;
  location: string;
  description: string;
  colours: string[];
  line_items: LineItem[];
  total_lm: number;
  total_sqm: number;
  production_notes: string[];
}

interface MyobSession {
  cookie: string;
  expires_at: number;
}

interface CustomerMatch {
  id: string;
  name: string;
}

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json({ limit: '25mb' }));

const EXTRACTION_PROMPT = `You are an order processor for Metfold Sheet Metal in Australia.
Extract ALL flashing order details from the two PDFs provided (Purchase Order + Flashing Drawing).

RULES:
- Round girth UP to nearest standard: 100,150,200,240,300,350,400,450,500,550,600,650,700,750,800,900,1000,1100,1200
- Max folds: 10
- Colorbond code format: FC[Girth]G[Folds]F-[ColorCode]
- Color codes: NS=Night Sky, SU=Surfmist, BA=Basalt, MO=Monument, BG=Bluegum, CC=Classic Cream, CG=Cottage Green, DO=Deep Ocean, DU=Dune, DW=Dover White, EH=Evening Haze, GU=Gully, IR=Iron Stone, JA=Jasper, MR=Manor Red, PB=Paper Bark, PE=Pale Eucalpt, SG=Shale Grey, SO=Southerly, WB=Wallaby, WG=Woodland Grey, WS=Windspray
- For tapered flashings flag them
- If pickup: set delivery_type to "PICKUP", else "DELIVERY"

Return ONLY valid JSON, no markdown, no explanation:
{
  "customer_name": "",
  "po_number": "",
  "job_number": "",
  "contact": "",
  "date_ordered": "",
  "date_required": "",
  "delivery_type": "PICKUP or DELIVERY",
  "location": "",
  "description": "",
  "colours": [],
  "line_items": [
    {
      "item_number": 1,
      "colour": "",
      "colour_code": "",
      "folds": 0,
      "girth_original": 0,
      "girth_rounded": 0,
      "inventory_id": "",
      "pieces": 1,
      "length": 0.0,
      "qty": 0.0,
      "tapered": false,
      "notes": ""
    }
  ],
  "total_lm": 0.0,
  "total_sqm": 0.0,
  "production_notes": []
}`;

// ─── OpenAI PDF extraction ─────────────────────────────────
app.post(
  '/api/extract',
  upload.fields([
    { name: 'po', maxCount: 1 },
    { name: 'drawing', maxCount: 1 }
  ]),
  async (req: Request, res: Response) => {
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: 'OPENAI_API_KEY not set on server (.env)' });
      }

      const files = req.files as { [field: string]: Express.Multer.File[] };
      const poFile = files?.['po']?.[0];
      const drawFile = files?.['drawing']?.[0];
      if (!poFile || !drawFile) {
        return res.status(400).json({ error: 'Both PO and drawing PDFs are required' });
      }

      const poB64 = poFile.buffer.toString('base64');
      const drawB64 = drawFile.buffer.toString('base64');

      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-4o',
          max_tokens: 4000,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'file',
                  file: {
                    filename: poFile.originalname || 'po.pdf',
                    file_data: `data:application/pdf;base64,${poB64}`
                  }
                },
                {
                  type: 'file',
                  file: {
                    filename: drawFile.originalname || 'drawing.pdf',
                    file_data: `data:application/pdf;base64,${drawB64}`
                  }
                },
                { type: 'text', text: EXTRACTION_PROMPT }
              ]
            }
          ]
        })
      });

      const data: any = await openaiRes.json();
      if (!openaiRes.ok) {
        return res
          .status(openaiRes.status)
          .json({ error: data.error?.message || 'OpenAI API error', details: data });
      }

      const raw = data.choices?.[0]?.message?.content || '';
      const clean = raw.replace(/```json|```/g, '').trim();

      let order: Order;
      try {
        order = JSON.parse(clean);
      } catch {
        return res.status(500).json({ error: 'Model returned invalid JSON', raw });
      }

      res.json(order);
    } catch (err: any) {
      console.error('Extract error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── MYOB Advanced (Acumatica) integration ────────────────
const MYOB_HOST = process.env.MYOB_HOST || '';
const MYOB_API = MYOB_HOST + (process.env.MYOB_API_PATH || '');

let myobSession: MyobSession | null = null;
// Cache across requests so we don't re-hit the "unknown column" error every time.
// Resets to true on server restart (which is also when .env is re-read).
let lineCustomFieldsSupported: boolean = true;

function extractCookies(response: Response | any): string {
  const raw =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : response.headers.raw?.()['set-cookie'] || [];
  return (raw as string[]).map((c: string) => c.split(';')[0]).join('; ');
}

async function myobLogin(): Promise<string> {
  if (!MYOB_HOST || !process.env.MYOB_USERNAME || !process.env.MYOB_PASSWORD) {
    throw new Error('MYOB credentials not configured in .env (MYOB_HOST, MYOB_USERNAME, MYOB_PASSWORD)');
  }
  const r = await fetch(`${MYOB_HOST}/entity/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: process.env.MYOB_USERNAME,
      password: process.env.MYOB_PASSWORD,
      company: process.env.MYOB_COMPANY_NAME || '',
      branch: process.env.MYOB_BRANCH || ''
    })
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`MYOB login failed (${r.status}): ${t}`);
  }
  const cookie = extractCookies(r);
  myobSession = { cookie, expires_at: Date.now() + 20 * 60 * 1000 };
  return cookie;
}

async function ensureSession(): Promise<string> {
  if (myobSession && Date.now() < myobSession.expires_at) return myobSession.cookie;
  return await myobLogin();
}

async function myobFetch(
  pathOrUrl: string,
  options: RequestInit = {},
  retryOnAuth = true
): Promise<globalThis.Response> {
  const cookie = await ensureSession();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : MYOB_API + pathOrUrl;
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
      Cookie: cookie
    } as any
  });
  if (res.status === 401 && retryOnAuth) {
    myobSession = null;
    return myobFetch(pathOrUrl, options, false);
  }
  return res;
}

app.get('/api/myob/status', (_req, res) => {
  res.json({
    configured: !!(MYOB_HOST && process.env.MYOB_USERNAME),
    host: MYOB_HOST || null,
    connected: !!myobSession
  });
});

// Find an existing MYOB Contact by display name (scoped to the customer where possible),
// or create a new one linked to the customer. Returns the ContactID to put on the SO.
async function ensureContact(customerId: string, contactStr: string): Promise<number | null> {
  if (!contactStr) return null;
  const { name, phone } = parseContact(contactStr);
  if (!name) return null;

  // 1. Lookup by DisplayName
  try {
    const safe = name.replace(/'/g, "''");
    const r = await myobFetch(
      `/Contact?$filter=DisplayName eq '${encodeURIComponent(safe)}'&$top=5`
    );
    if (r.ok) {
      const arr = (await r.json()) as any[];
      const preferred =
        arr.find((c) => c.BusinessAccount?.value === customerId) || arr[0];
      if (preferred?.ContactID?.value) {
        console.log(`[MYOB] Contact "${name}" found → ContactID ${preferred.ContactID.value}`);
        return preferred.ContactID.value;
      }
    }
  } catch (e: any) {
    console.warn('[MYOB] Contact lookup error:', e.message);
  }

  // 2. Create new Contact linked to the customer
  try {
    const parts = name.split(/\s+/);
    const firstName = parts[0] || name;
    const lastName = parts.slice(1).join(' ') || '';

    const body: any = {
      DisplayName: { value: name },
      FirstName: { value: firstName },
      LastName: { value: lastName },
      BusinessAccount: { value: customerId }
    };
    if (phone) body.Phone1 = { value: phone };

    const r = await myobFetch('/Contact', {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    if (r.ok) {
      const data: any = await r.json();
      const id = data.ContactID?.value;
      console.log(`[MYOB] Created contact "${name}" → ContactID ${id}`);
      return id || null;
    }
    console.warn(`[MYOB] Contact create failed (${r.status}):`, await r.text());
  } catch (e: any) {
    console.warn('[MYOB] Contact create error:', e.message);
  }
  return null;
}

async function searchCustomers(nameRaw: string, limit = 8): Promise<CustomerMatch[]> {
  if (!nameRaw) return [];
  const tokens = String(nameRaw)
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  const safe = String(nameRaw).replace(/'/g, "''");
  const queries = [
    `/Customer?$filter=CustomerID eq '${encodeURIComponent(safe)}'&$select=CustomerID,CustomerName&$top=${limit}`,
    `/Customer?$filter=CustomerName eq '${encodeURIComponent(safe)}'&$select=CustomerID,CustomerName&$top=${limit}`,
    `/Customer?$filter=substringof('${encodeURIComponent(safe)}',CustomerName)&$select=CustomerID,CustomerName&$top=${limit}`,
    ...tokens.map(
      (t) =>
        `/Customer?$filter=substringof('${encodeURIComponent(t.replace(/'/g, "''"))}',CustomerName)&$select=CustomerID,CustomerName&$top=${limit}`
    ),
    ...tokens.map(
      (t) =>
        `/Customer?$filter=startswith(CustomerName,'${encodeURIComponent(t.replace(/'/g, "''"))}')&$select=CustomerID,CustomerName&$top=${limit}`
    )
  ];
  const seen = new Set<string>();
  const results: CustomerMatch[] = [];
  for (const q of queries) {
    try {
      const r = await myobFetch(q);
      if (!r.ok) continue;
      const arr: any = await r.json();
      for (const c of arr || []) {
        const id = c.CustomerID?.value;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        results.push({ id, name: c.CustomerName?.value || '' });
        if (results.length >= limit) return results;
      }
    } catch {
      /* ignore and try next strategy */
    }
  }
  return results;
}

async function lookupCustomerId(nameRaw: string): Promise<CustomerMatch | null> {
  const results = await searchCustomers(nameRaw, 1);
  return results[0] || null;
}

app.get('/api/myob/customer-search', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.json({ candidates: [] });
    const candidates = await searchCustomers(q, 8);
    res.json({ candidates });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Submit Sales Order to MYOB Advanced ──────────────────
app.post('/api/submit-myob', async (req, res) => {
  try {
    const { order, customerIdOverride } = req.body as {
      order: Order;
      customerIdOverride?: string;
    };
    if (!order) return res.status(400).json({ error: 'Order payload required' });

    let customerId = (customerIdOverride || '').trim();
    let customerResolvedFrom: string = 'override';
    if (!customerId) {
      const match = await lookupCustomerId(order.customer_name);
      if (match) {
        customerId = match.id;
        customerResolvedFrom = `lookup (matched "${match.name}")`;
      }
    }
    if (!customerId && process.env.MYOB_DEFAULT_CUSTOMER_ID) {
      customerId = process.env.MYOB_DEFAULT_CUSTOMER_ID;
      customerResolvedFrom = 'env default';
    }
    if (!customerId) {
      return res.status(400).json({
        error: `Customer "${order.customer_name}" not found in MYOB. Pick one on the review screen, or set MYOB_DEFAULT_CUSTOMER_ID in .env.`
      });
    }

    const piecesField = process.env.MYOB_LINE_PIECES_FIELD || 'UsrACSNoOfPeices';
    const lengthField = process.env.MYOB_LINE_LENGTH_FIELD || 'UsrACSLength';
    const lineCustomView = process.env.MYOB_LINE_CUSTOM_VIEW || 'Transactions';

    // Send Pieces and Length as top-level line fields (same shape as OrderQty).
    // If MYOB says those fields don't exist, we remember that and skip them
    // on subsequent requests this session.
    const usePiecesLength = lineCustomFieldsSupported;

    const details = (order.line_items || []).map((item) => {
      const pieces = Number(item.pieces) || 0;
      const length = Number(item.length) || 0;
      const qty = Number(item.qty) || pieces * length;

      const profile = `${item.colour || ''} ${item.girth_rounded || ''}G ${item.folds || ''}F FLASHING${
        item.tapered ? ' (TAPERED)' : ''
      }`.trim();
      const breakdown = `${pieces} pc × ${length.toFixed(3)}m = ${qty.toFixed(3)}m`;

      const line: any = {
        InventoryID: { value: item.inventory_id || '' },
        OrderQty: { value: qty },
        UnitPrice: { value: 0 },
        TransactionDescription: { value: `${profile} | ${breakdown}` }
      };
      if (usePiecesLength) {
        line.custom = {
          [lineCustomView]: {
            [piecesField]: { type: 'CustomDecimalField', value: pieces },
            [lengthField]: { type: 'CustomDecimalField', value: length }
          }
        };
      }
      return line;
    });

    const requestedOn = parseDate(order.date_required) || parseDate(order.date_ordered);
    const contact = (order.contact || '').trim();

    const payload: any = {
      OrderType: { value: 'SO' },
      CustomerID: { value: customerId },
      CustomerOrder: { value: order.po_number || '' },
      Description: { value: (order.description || '').substring(0, 255) },
      Hold: { value: true },
      Details: details
    };

    if (requestedOn) payload.RequestedOn = { value: requestedOn };

    // Contact: look up existing MYOB Contact, or create a new one linked to this customer.
    let contactId: number | null = null;
    if (contact) {
      contactId = await ensureContact(customerId, contact);
      if (contactId) {
        payload.ContactID = { value: contactId };
      } else {
        // Fallback: override pattern if we couldn't get/create a ContactID
        const { name, phone } = parseContact(contact);
        payload.Contact = {
          OverrideContact: { value: true },
          Attention: { value: name || contact },
          ...(phone ? { Phone1: { value: phone } } : {})
        };
      }
    }

    console.log(`[MYOB] CustomerID resolved via ${customerResolvedFrom} → ${customerId}`);
    if (requestedOn) console.log(`[MYOB] RequestedOn → ${requestedOn}`);
    if (contact) console.log(`[MYOB] Contact → ${contact}${contactId ? ` (ContactID ${contactId})` : ' (fallback override)'}`);

    const basePoNumber = order.po_number || '';
    const MAX_RETRIES = 20;
    let attempt = 0;
    let soRes!: globalThis.Response;
    let bodyText = '';
    let usedPo = basePoNumber;

    while (attempt <= MAX_RETRIES) {
      payload.CustomerOrder = { value: usedPo };

      soRes = await myobFetch('/SalesOrder', {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      bodyText = await soRes.text();

      if (soRes.ok) break;

      // If MYOB doesn't recognise our custom column names, remember that for
      // the rest of this server session and fail cleanly — do NOT retry within
      // this request, otherwise Acumatica's partial-commit behaviour creates
      // a duplicate SO on the next attempt.
      if (isUnknownColumnError(bodyText)) {
        lineCustomFieldsSupported = false;
        return res.status(400).json({
          error: `MYOB doesn't have custom column "${piecesField}" or "${lengthField}" under view "${lineCustomView}". Open /api/myob/so-debug?nbr=<an-existing-SO> to see the real field names, set them in .env, and restart the backend. Future submissions (without restart) will skip custom fields automatically — click Submit once more.`,
          details: tryParseJson(bodyText)
        });
      }

      if (!isDuplicatePoError(bodyText)) break;

      attempt++;
      usedPo = `${basePoNumber}-${attempt + 1}`;
      console.log(`[MYOB] PO "${payload.CustomerOrder.value}" already used; retrying as "${usedPo}"`);
    }

    if (!soRes.ok) {
      return res.status(soRes.status).json({
        error: 'MYOB rejected the order',
        status: soRes.status,
        customerId,
        customerResolvedFrom,
        attempts: attempt + 1,
        details: tryParseJson(bodyText)
      });
    }

    const result: any = tryParseJson(bodyText) || {};
    res.json({
      Number: result.OrderNbr?.value || 'created',
      Type: result.OrderType?.value,
      Status: result.Status?.value,
      Hold: result.Hold?.value,
      CustomerID: result.CustomerID?.value,
      CustomerOrder: usedPo,
      poSuffixed: usedPo !== basePoNumber,
      piecesLengthSent: usePiecesLength,
      contactId,
      raw: result
    });
  } catch (err: any) {
    console.error('MYOB submit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic: GET /api/myob/so-debug?nbr=SO026068
// Dumps everything about an existing SO so you can find the real field names
// for Contact / Pieces / Length. Look for fields whose values match what you
// see in the MYOB UI for that SO (e.g. the real pieces number / length).
app.get('/api/myob/so-debug', async (req, res) => {
  try {
    const nbr = (req.query.nbr || '').toString().trim();
    if (!nbr) return res.status(400).json({ error: 'pass ?nbr=<SO number>' });
    const r = await myobFetch(
      `/SalesOrder/SO/${encodeURIComponent(nbr)}?$expand=Details,Details/custom,Contact,BillToContact,ShipToContact,custom`
    );
    const text = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: text });
    const data: any = tryParseJson(text);
    const firstLine = data?.Details?.[0] || {};

    const contactBlocks: any = {};
    for (const k of Object.keys(data || {})) {
      if (/contact/i.test(k)) contactBlocks[k] = data[k];
    }

    res.json({
      OrderNbr: data?.OrderNbr?.value,
      Description: data?.Description?.value,

      headerContactRelatedFields: contactBlocks,

      headerCustom: data?.custom || {},
      headerCustomFieldNames: Object.keys(data?.custom || {}).reduce(
        (acc: any, view: string) => {
          acc[view] = Object.keys(data.custom[view] || {});
          return acc;
        },
        {}
      ),

      firstLineAllKeys: Object.keys(firstLine || {}),
      firstLineStandard: Object.fromEntries(
        Object.entries(firstLine || {}).filter(([k]) => k !== 'custom')
      ),
      firstLineCustom: firstLine?.custom || {},
      firstLineCustomFieldNames: Object.keys(firstLine?.custom || {}).reduce(
        (acc: any, view: string) => {
          acc[view] = Object.keys(firstLine.custom[view] || {});
          return acc;
        },
        {}
      ),

      fullResponse: data
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Asks MYOB what fields are exposed on the SalesOrder endpoint.
// If "Pieces"/"Length" aren't listed here, they're NOT published to the REST
// API (even though they show in the UI) — the MYOB admin must add them to
// the Web Service Endpoint in MYOB Advanced → Customization → Web Service Endpoints.
app.get('/api/myob/schema', async (_req, res) => {
  try {
    const r = await myobFetch('/SalesOrder/$adHocSchema');
    const text = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: text });
    const data: any = tryParseJson(text);

    // Try to surface the most useful info — all field names on the detail lines
    const detailSchema = data?.Details || data?.Detail || null;
    const detailFieldNames = detailSchema
      ? Object.keys(detailSchema).filter((k) => typeof detailSchema[k] === 'object')
      : [];

    const headerFieldNames = Object.keys(data || {}).filter(
      (k) => typeof data[k] === 'object' && !Array.isArray(data[k])
    );

    res.json({
      headerFieldNames,
      detailFieldNames,
      hasPieces: detailFieldNames.some((n) => /piece/i.test(n)),
      hasLength: detailFieldNames.some((n) => /length/i.test(n)),
      detailSchema,
      fullSchema: data
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ─── helpers ──────────────────────────────────────────────
function tryParseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isDuplicatePoError(bodyText: string): boolean {
  const s = String(bodyText || '').toLowerCase();
  return s.includes('same customer order number') || s.includes('customer order nbr');
}

function isUnknownColumnError(bodyText: string): boolean {
  const s = String(bodyText || '').toLowerCase();
  return s.includes('is not found in the data set');
}

function parseDate(s: string): string | null {
  if (!s) return null;
  const dmY = String(s).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmY) return `${dmY[3]}-${dmY[2].padStart(2, '0')}-${dmY[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(String(s))) return String(s).substring(0, 10);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().substring(0, 10);
}

function parseContact(s: string): { name: string; phone: string } {
  if (!s) return { name: '', phone: '' };
  const phoneMatch = s.match(/(\+?\d[\d\s\-]{6,})/);
  const phone = phoneMatch ? phoneMatch[1].replace(/\s+/g, '') : '';
  const name = s.replace(/[-|,]/g, ' ').replace(phone, '').trim().replace(/\s+/g, ' ');
  return { name, phone };
}

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Metfold backend running on http://localhost:${PORT}`);
});
