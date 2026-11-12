import "server-only";
import { fetchJson, qs } from "./http";

const BASE = "https://services.leadconnectorhq.com";

export type GhlCreds = { token: string; locationId: string };

function headers(c: GhlCreds) {
  return { Authorization: `Bearer ${c.token}`, Version: "2021-07-28" };
}

export type FormSubmission = {
  id: string;
  formId: string;
  contactId?: string;
  email?: string;
  createdAt: string;
  others?: Record<string, unknown> & {
    eventData?: { url_params?: Record<string, string> };
  };
};

export async function listFormSubmissions(c: GhlCreds, formId: string, startAt: string, endAt: string, page: number) {
  return fetchJson<{ submissions: FormSubmission[]; meta: { total: number; nextPage: number | null } }>(
    `${BASE}/forms/submissions?${qs({ locationId: c.locationId, formId, startAt, endAt, limit: 100, page })}`,
    { headers: headers(c) },
  );
}

export type CalendarEvent = {
  id: string;
  calendarId: string;
  contactId?: string;
  startTime: string;
  appointmentStatus?: string;
  address?: string;
  deleted?: boolean;
  appointmentMeta?: { defaultFormDetails?: { email?: string } };
};

export async function listCalendarEvents(c: GhlCreds, calendarId: string, startMs: number, endMs: number) {
  const r = await fetchJson<{ events: CalendarEvent[] }>(
    `${BASE}/calendars/events?${qs({ locationId: c.locationId, calendarId, startTime: startMs, endTime: endMs })}`,
    { headers: headers(c) },
  );
  return r.events ?? [];
}

export async function getContactEmail(c: GhlCreds, contactId: string): Promise<string | null> {
  const r = await fetchJson<{ contact?: { email?: string | null } }>(`${BASE}/contacts/${encodeURIComponent(contactId)}`, {
    headers: headers(c),
  });
  return r.contact?.email ?? null;
}

export async function listCustomValues(c: GhlCreds): Promise<Array<{ name: string; value: string }>> {
  const r = await fetchJson<{ customValues?: Array<{ name?: string; value?: string }> }>(
    `${BASE}/locations/${encodeURIComponent(c.locationId)}/customValues`, { headers: headers(c) });
  return (r.customValues ?? []).map((v) => ({ name: v.name ?? "", value: String(v.value ?? "") }));
}
