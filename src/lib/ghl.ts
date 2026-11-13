import "server-only";
import { fetchJson, HttpError, qs } from "./http";

const BASE = "https://services.leadconnectorhq.com";

export type GhlCreds = { token: string; locationId: string };

function headers(c: GhlCreds) {
  return { Authorization: `Bearer ${c.token}`, Version: "2021-07-28" };
}

export type FormSubmission = {
  id: string;
  formId: string;
  contactId?: string;
  name?: string;
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

export type GhlContact = { id: string; name: string | null; email: string | null; phone: string | null; tags: string[] };

/** One contact's name, email, phone and tags; null when GHL no longer has it (merged or deleted). */
export async function getContact(c: GhlCreds, contactId: string): Promise<GhlContact | null> {
  try {
    const r = await fetchJson<{ contact?: { id: string; contactName?: string | null; firstName?: string | null; lastName?: string | null; email?: string | null; phone?: string | null; tags?: string[] } }>(
      `${BASE}/contacts/${encodeURIComponent(contactId)}`, { headers: headers(c) });
    const k = r.contact;
    if (!k) return null;
    const name = (k.contactName || [k.firstName, k.lastName].filter(Boolean).join(" ")).trim() || null;
    return { id: k.id, name, email: k.email?.trim() || null, phone: k.phone?.trim() || null, tags: k.tags ?? [] };
  } catch (err) {
    if (err instanceof HttpError && [400, 404, 422].includes(err.status)) return null;
    throw err;
  }
}

/** Every calendar in the location (id, name). */
export async function listCalendars(c: GhlCreds): Promise<Array<{ id: string; name: string }>> {
  const r = await fetchJson<{ calendars?: Array<{ id: string; name?: string }> }>(`${BASE}/calendars/?${qs({ locationId: c.locationId })}`, { headers: headers(c) });
  return (r.calendars ?? []).map((k) => ({ id: k.id, name: k.name ?? k.id }));
}

/** The location's users (the team). */
export async function listUsers(c: GhlCreds): Promise<Array<{ email: string; name: string }>> {
  const r = await fetchJson<{ users?: Array<{ email?: string; name?: string }> }>(`${BASE}/users/?${qs({ locationId: c.locationId })}`, { headers: headers(c) });
  return (r.users ?? []).filter((u) => u.email).map((u) => ({ email: u.email!.trim().toLowerCase(), name: u.name ?? "" }));
}

/** Contacts carrying a tag (GHL's contact search), each with its tags. */
export async function contactsWithTag(c: GhlCreds, tag: string): Promise<Array<{ id: string; tags: string[] }>> {
  const out: Array<{ id: string; tags: string[] }> = [];
  for (let page = 1; page <= 200; page++) {
    const r = await fetchJson<{ contacts?: Array<{ id: string; tags?: string[] }>; total?: number }>(`${BASE}/contacts/search`, {
      method: "POST", headers: { ...headers(c), "Content-Type": "application/json" },
      body: JSON.stringify({ locationId: c.locationId, page, pageLimit: 500, filters: [{ field: "tags", operator: "contains", value: tag }] }),
    });
    const batch = r.contacts ?? [];
    out.push(...batch.map((k) => ({ id: k.id, tags: k.tags ?? [] })));
    if (batch.length < 500) break;
  }
  return out;
}

export async function addTags(c: GhlCreds, contactId: string, tags: string[]) {
  await fetchJson(`${BASE}/contacts/${encodeURIComponent(contactId)}/tags`, {
    method: "POST", headers: { ...headers(c), "Content-Type": "application/json" }, body: JSON.stringify({ tags }) });
}

export async function removeTags(c: GhlCreds, contactId: string, tags: string[]) {
  await fetchJson(`${BASE}/contacts/${encodeURIComponent(contactId)}/tags`, {
    method: "DELETE", headers: { ...headers(c), "Content-Type": "application/json" }, body: JSON.stringify({ tags }) });
}

export async function listCustomValues(c: GhlCreds): Promise<Array<{ name: string; value: string }>> {
  const r = await fetchJson<{ customValues?: Array<{ name?: string; value?: string }> }>(
    `${BASE}/locations/${encodeURIComponent(c.locationId)}/customValues`, { headers: headers(c) });
  return (r.customValues ?? []).map((v) => ({ name: v.name ?? "", value: String(v.value ?? "") }));
}
