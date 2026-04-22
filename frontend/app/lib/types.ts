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
