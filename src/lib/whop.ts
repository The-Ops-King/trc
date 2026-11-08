import "server-only";
import { fetchJson, qs } from "./http";

const BASE = "https://api.whop.com/api/v1";

type Money = { amount: string } | null;

export type WhopPayment = {
  id: string;
  status: string;
  substatus: string | null;
  customer_email: string | null;
  user: { id: string } | null;
  product_id: string | null;
  variant_id: string | null;
  line_items: Array<{ product_title: string | null; variant_id: string | null }> | null;
  payment_method_type: string | null;
  billing_reason: string | null;
  created_at: string;
  paid_at: string | null;
  total: Money;
  usd_total: Money;
  refunded_amount: Money;
  financing_installments_count: number | null;
};

export async function listPayments(key: string, after: string | null) {
  return fetchJson<{ data: WhopPayment[]; page_info: { end_cursor: string | null; has_next_page: boolean } }>(
    `${BASE}/payments?${qs({ first: 100, after, order: "created_at", direction: "desc" })}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
}

export const money = (m: Money): number => (m && m.amount ? Number(m.amount) : 0);
