export interface LineItem {
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

export interface Order {
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

export interface CustomerCandidate {
  id: string;
  name: string;
}

export interface MyobStatus {
  configured: boolean;
  host: string | null;
  connected: boolean;
}

export interface SubmitResult {
  Number: string;
  CustomerOrder?: string;
  poSuffixed?: boolean;
  customFieldsStripped?: boolean;
}

export type Screen = 'upload' | 'processing' | 'review' | 'success';

export type Tab = 'flashing' | 'roofing';

export interface RoofingCut {
  pieces: number;
  length_mm: number;
}

export interface RoofingLineItem {
  item_number: number;
  description: string;
  profile: string;
  quantity: number;
  unit: string;
  inventory_id: string;
  cuts: RoofingCut[];
  notes: string;
}

export interface CatalogFileEntry {
  source_file: string;
  count: number;
  uploaded_at: string | null;
}

export interface CatalogStatus {
  configured: boolean;
  connected: boolean;
  message?: string;
  total: number;
  files: CatalogFileEntry[];
}

export interface CatalogUploadResult {
  uploaded: {
    file: string;
    sheets: { name: string; rows: number; inserted: number }[];
    total_rows: number;
    total_inserted: number;
  }[];
  errors: { file: string; error: string }[];
  total_in_catalog: number;
  files_in_catalog: number;
}

export interface SkuMatchResult {
  sku: string;
  matched_product: string;
  matched_colour: string;
  score: number;
  confident: boolean;
}

export interface RoofingOrder {
  customer_name: string;
  po_number: string;
  job_number: string;
  contact: string;
  date_ordered: string;
  date_required: string;
  delivery_type: string;
  site_address: string;
  description: string;
  colour: string;
  colour_code: string;
  roof_profile: string;
  pitch: number;
  total_area_sqm: number;
  line_items: RoofingLineItem[];
  production_notes: string[];
}
