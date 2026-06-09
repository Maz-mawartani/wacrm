'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  Contact,
  MessageTemplate,
  TemplateButtonParameter,
  TemplateHeaderInput,
} from '@/types';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'contacts' | 'tags' | 'custom_field' | 'csv';
  contactIds?: string[];
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  /** Contacts carrying any of these tags are subtracted from the result. */
  excludeTagIds?: string[];
}

/**
 * Variable mapping — each template placeholder (by key, usually "1",
 * "2", …) is resolved at send time. `field` maps to a built-in contact
 * field (name/phone/email/company); `custom_field` maps to a
 * contact_custom_values.value row keyed by the custom_fields.id stored
 * in `value`.
 */
export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

interface BroadcastPayload {
  /**
   * When present, send an existing draft broadcast instead of inserting a
   * second broadcast row.
   */
  broadcastId?: string;
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  header?: TemplateHeaderInput | null;
  buttonParams?: TemplateButtonParameter[];
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

/**
 * Meta rate-limit buffer. 10 per batch + 1 s pause matches the spec
 * and keeps us comfortably under Meta's per-phone-number messaging
 * rate so a large broadcast never trips the upstream limiter.
 */
const SEND_BATCH_SIZE = 10;
const SEND_BATCH_DELAY_MS = 1000;

/** `broadcast_recipients` inserts are independent of the send rate. */
const INSERT_BATCH_SIZE = 200;
const LOOKUP_BATCH_SIZE = 100;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BroadcastApiResult {
  phone: string;
  status: 'sent' | 'failed';
  whatsapp_message_id?: string;
  error?: string;
}

/** contactId → (customFieldId → value). */
type CustomValueIndex = Map<string, Map<string, string>>;

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function chunkValues<T>(values: T[], size = LOOKUP_BATCH_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

function isMissingTemplateComponentColumn(message: string | undefined) {
  return Boolean(
    message &&
    (message.includes("'template_header' column") ||
      message.includes("'template_buttons' column") ||
      message.includes('"template_header" column') ||
      message.includes('"template_buttons" column'))
  );
}

/**
 * Per-contact resolution of custom-field placeholders. Static and
 * built-in-field mappings resolve synchronously; custom fields read
 * from a pre-built index to avoid N+1 queries during the send loop.
 */
export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>
): string[] {
  // Keys are typically "1","2",... — numeric-aware sort keeps
  // {{1}} before {{10}}.
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  return keys.map((key) => {
    const v = variables[key];
    if (v.type === 'static') return v.value;

    if (v.type === 'field') {
      const fieldMap: Record<string, string | undefined> = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      };
      return fieldMap[v.value] ?? '';
    }

    // custom_field
    return customValues?.get(v.value) ?? '';
  });
}

/**
 * Bulk-fetch contact_custom_values for a set of contacts. Returns an
 * index keyed by contact_id → field_id → value.
 */
async function fetchCustomValueIndex(
  supabase: ReturnType<typeof createClient>,
  contactIds: string[]
): Promise<CustomValueIndex> {
  const index: CustomValueIndex = new Map();
  if (contactIds.length === 0) return index;

  for (const slice of chunkValues(uniqueValues(contactIds))) {
    const { data, error } = await supabase
      .from('contact_custom_values')
      .select('contact_id, custom_field_id, value')
      .in('contact_id', slice);

    if (error) {
      throw new Error(`Failed to fetch custom values: ${error.message}`);
    }

    for (const row of data ?? []) {
      const bucket = index.get(row.contact_id) ?? new Map<string, string>();
      bucket.set(row.custom_field_id, row.value ?? '');
      index.set(row.contact_id, bucket);
    }
  }
  return index;
}

async function fetchContactsByIds(
  supabase: ReturnType<typeof createClient>,
  contactIds: string[]
): Promise<Contact[]> {
  const uniqueContactIds = uniqueValues(contactIds);
  if (uniqueContactIds.length === 0) return [];

  const byId = new Map<string, Contact>();
  for (const slice of chunkValues(uniqueContactIds)) {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .in('id', slice);
    if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);

    for (const contact of (data ?? []) as Contact[]) {
      byId.set(contact.id, contact);
    }
  }

  return uniqueContactIds
    .map((id) => byId.get(id))
    .filter((contact): contact is Contact => Boolean(contact));
}

async function fetchContactIdsByTagIds(
  supabase: ReturnType<typeof createClient>,
  tagIds: string[]
): Promise<string[]> {
  const uniqueTagIds = uniqueValues(tagIds);
  if (uniqueTagIds.length === 0) return [];

  const contactIds = new Set<string>();
  for (const slice of chunkValues(uniqueTagIds)) {
    const { data, error } = await supabase
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', slice);
    if (error)
      throw new Error(`Failed to fetch contact tags: ${error.message}`);

    for (const row of data ?? []) {
      if (row.contact_id) contactIds.add(row.contact_id);
    }
  }

  return [...contactIds];
}

async function fetchContactsByPhones(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  phones: string[]
): Promise<Contact[]> {
  const uniquePhones = uniqueValues(phones);
  if (uniquePhones.length === 0) return [];

  const contacts: Contact[] = [];
  for (const slice of chunkValues(uniquePhones)) {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('user_id', userId)
      .in('phone', slice);
    if (error) {
      throw new Error(`Failed to look up CSV contacts: ${error.message}`);
    }
    contacts.push(...((data ?? []) as Contact[]));
  }

  return contacts;
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function resolveAudience(audience: AudienceConfig): Promise<Contact[]> {
    const supabase = createClient();

    let contacts: Contact[] = [];

    if (audience.type === 'all') {
      const { data, error } = await supabase.from('contacts').select('*');
      if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
      contacts = data ?? [];
    } else if (
      audience.type === 'contacts' &&
      audience.contactIds &&
      audience.contactIds.length > 0
    ) {
      contacts = await fetchContactsByIds(supabase, audience.contactIds);
    } else if (
      audience.type === 'tags' &&
      audience.tagIds &&
      audience.tagIds.length > 0
    ) {
      const contactIds = await fetchContactIdsByTagIds(
        supabase,
        audience.tagIds
      );
      contacts = await fetchContactsByIds(supabase, contactIds);
    } else if (audience.type === 'custom_field' && audience.customField) {
      contacts = await resolveCustomFieldAudience(
        supabase,
        audience.customField
      );
    } else if (audience.type === 'csv' && audience.csvContacts) {
      contacts = await upsertCsvContacts(supabase, audience.csvContacts);
    }

    // Apply exclude tags (works across all contact-derived audience
    // types). CSV contacts are synthetic so exclusion doesn't apply.
    if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
      const excludedIds = new Set(
        await fetchContactIdsByTagIds(supabase, audience.excludeTagIds)
      );
      contacts = contacts.filter((c) => !excludedIds.has(c.id));
    }

    return contacts;
  }

  /**
   * CSV uploads arrive as raw phone/name pairs, not DB rows. Before we
   * can insert broadcast_recipients (whose contact_id FKs contacts.id),
   * we need real contacts.id UUIDs. So: look up each CSV phone in the
   * caller's contacts table; insert any that don't exist; return the
   * resolved set.
   *
   * Pre-existing implementation synthesized `csv-N` strings as
   * contact_id, which failed the UUID cast on insert — every CSV
   * broadcast silently created zero recipients.
   */
  async function upsertCsvContacts(
    supabase: ReturnType<typeof createClient>,
    csvRows: { phone: string; name?: string }[]
  ): Promise<Contact[]> {
    if (csvRows.length === 0) return [];

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      throw new Error('You are not signed in.');
    }

    // De-duplicate by phone within the CSV (users can paste duplicates).
    const uniqueByPhone = new Map<string, { phone: string; name?: string }>();
    for (const row of csvRows) {
      if (row.phone) uniqueByPhone.set(row.phone, row);
    }
    const phones = [...uniqueByPhone.keys()];

    const byPhone = new Map<string, Contact>();
    const existing = await fetchContactsByPhones(supabase, user.id, phones);
    for (const c of existing) {
      if (c.phone) byPhone.set(c.phone, c);
    }

    // Insert only missing contacts, in one batch per 200 rows (PostgREST
    // has a default payload cap — 200 keeps individual requests small).
    const missing = phones
      .filter((p) => !byPhone.has(p))
      .map((phone) => ({
        user_id: user.id,
        phone,
        name: uniqueByPhone.get(phone)?.name ?? null,
      }));

    const INSERT_CHUNK = 200;
    for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
      const chunk = missing.slice(i, i + INSERT_CHUNK);
      const { data: inserted, error: insertErr } = await supabase
        .from('contacts')
        .insert(chunk)
        .select();
      if (insertErr) {
        throw new Error(`Failed to create CSV contacts: ${insertErr.message}`);
      }
      for (const c of (inserted ?? []) as Contact[]) {
        if (c.phone) byPhone.set(c.phone, c);
      }
    }

    // Preserve input order so analytics roughly matches the CSV order.
    return phones
      .map((p) => byPhone.get(p))
      .filter((c): c is Contact => Boolean(c));
  }

  async function resolveCustomFieldAudience(
    supabase: ReturnType<typeof createClient>,
    filter: CustomFieldFilter
  ): Promise<Contact[]> {
    const { fieldId, operator, value } = filter;

    // Build the WHERE clause for the operator. PostgREST supports
    // eq/neq/ilike via the query builder — use ilike with wildcards
    // for "contains" so the match is case-insensitive.
    let query = supabase
      .from('contact_custom_values')
      .select('contact_id')
      .eq('custom_field_id', fieldId);

    if (operator === 'is') query = query.eq('value', value);
    else if (operator === 'is_not') query = query.neq('value', value);
    else if (operator === 'contains')
      query = query.ilike('value', `%${value}%`);

    const { data: matches, error: matchErr } = await query;
    if (matchErr)
      throw new Error(`Custom-field filter failed: ${matchErr.message}`);

    const contactIds = [...new Set((matches ?? []).map((m) => m.contact_id))];
    if (contactIds.length === 0) return [];

    return fetchContactsByIds(supabase, contactIds);
  }

  async function createAndSendBroadcast(
    payload: BroadcastPayload
  ): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    const supabase = createClient();

    try {
      // ── Step 0: Resolve current user ──────────────────────────────
      // broadcasts.user_id is NOT NULL + guarded by RLS
      // (auth.uid() = user_id). Without this, the INSERT below was
      // silently failing with 23502 / 42501 — the wizard would
      // no-op with no feedback.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        throw new Error('You are not signed in.');
      }

      // ── Step 1: Resolve audience contacts ─────────────────────────
      setProgress(5);
      const contacts = await resolveAudience(payload.audience);

      if (contacts.length === 0) {
        throw new Error('No contacts found for this audience.');
      }

      // ── Step 2: Create or claim broadcast row ─────────────────────
      setProgress(10);
      const broadcastPayload = {
        user_id: user.id,
        name: payload.name.trim(),
        template_name: payload.template.name,
        template_language: payload.template.language ?? 'en_US',
        template_variables: payload.variables,
        template_header: payload.header ?? null,
        template_buttons: payload.buttonParams ?? null,
        audience_filter: {
          type: payload.audience.type,
          contactIds: payload.audience.contactIds,
          tagIds: payload.audience.tagIds,
          customField: payload.audience.customField,
          csvContacts: payload.audience.csvContacts,
          excludeTagIds: payload.audience.excludeTagIds,
        },
        status: 'sending',
        total_recipients: contacts.length,
        sent_count: 0,
        delivered_count: 0,
        read_count: 0,
        replied_count: 0,
        failed_count: 0,
      };

      let broadcast;
      let broadcastError;

      if (payload.broadcastId) {
        const { data: existing, error: existingError } = await supabase
          .from('broadcasts')
          .select('id, status')
          .eq('id', payload.broadcastId)
          .eq('user_id', user.id)
          .single();

        if (existingError || !existing) {
          throw new Error(
            `Failed to load draft broadcast: ${existingError?.message ?? 'not found'}`
          );
        }
        if (existing.status !== 'draft') {
          throw new Error(
            'Only draft broadcasts can be sent from this action.'
          );
        }

        const { error: deleteRecipientsError } = await supabase
          .from('broadcast_recipients')
          .delete()
          .eq('broadcast_id', payload.broadcastId);

        if (deleteRecipientsError) {
          throw new Error(
            `Failed to prepare draft recipients: ${deleteRecipientsError.message}`
          );
        }

        const updatePayload = {
          ...broadcastPayload,
          scheduled_at: null,
        };

        const update = await supabase
          .from('broadcasts')
          .update(updatePayload)
          .eq('id', payload.broadcastId)
          .eq('status', 'draft')
          .select()
          .single();
        broadcast = update.data;
        broadcastError = update.error;

        if (isMissingTemplateComponentColumn(broadcastError?.message)) {
          const legacyBroadcastPayload: Record<string, unknown> = {
            ...updatePayload,
          };
          delete legacyBroadcastPayload.template_header;
          delete legacyBroadcastPayload.template_buttons;
          const retry = await supabase
            .from('broadcasts')
            .update(legacyBroadcastPayload)
            .eq('id', payload.broadcastId)
            .eq('status', 'draft')
            .select()
            .single();
          broadcast = retry.data;
          broadcastError = retry.error;
        }
      } else {
        const insert = await supabase
          .from('broadcasts')
          .insert(broadcastPayload)
          .select()
          .single();
        broadcast = insert.data;
        broadcastError = insert.error;

        if (isMissingTemplateComponentColumn(broadcastError?.message)) {
          const legacyBroadcastPayload: Record<string, unknown> = {
            ...broadcastPayload,
          };
          delete legacyBroadcastPayload.template_header;
          delete legacyBroadcastPayload.template_buttons;
          const retry = await supabase
            .from('broadcasts')
            .insert(legacyBroadcastPayload)
            .select()
            .single();
          broadcast = retry.data;
          broadcastError = retry.error;
        }
      }

      if (broadcastError || !broadcast) {
        throw new Error(
          `Failed to create broadcast: ${broadcastError?.message ?? 'unknown error'}`
        );
      }

      // ── Step 3: Insert recipient rows ─────────────────────────────
      setProgress(20);
      const recipientRows = contacts.map((contact) => ({
        broadcast_id: broadcast.id,
        contact_id: contact.id,
        status: 'pending' as const,
      }));

      for (let i = 0; i < recipientRows.length; i += INSERT_BATCH_SIZE) {
        const batch = recipientRows.slice(i, i + INSERT_BATCH_SIZE);
        const { error: recipientError } = await supabase
          .from('broadcast_recipients')
          .insert(batch);
        if (recipientError) {
          // Previous impl logged and marched on — the broadcast then ran
          // with an incomplete recipient set, so webhook status updates
          // couldn't find some rows and the aggregate counts drifted.
          // Flip the broadcast to failed so the user sees the problem
          // immediately, then throw to abort the send loop.
          await supabase
            .from('broadcasts')
            .update({
              status: 'failed',
              failed_count: contacts.length,
            })
            .eq('id', broadcast.id);
          throw new Error(
            `Failed to insert recipient batch ${i / INSERT_BATCH_SIZE + 1}: ${recipientError.message}`
          );
        }
      }

      // ── Step 4: Fetch recipients (joined contact) + preload custom values
      setProgress(30);
      const { data: recipients, error: recipientsFetchError } = await supabase
        .from('broadcast_recipients')
        .select('*, contact:contacts(*)')
        .eq('broadcast_id', broadcast.id);

      if (recipientsFetchError || !recipients) {
        throw new Error('Failed to fetch broadcast recipients');
      }

      // One bulk fetch of custom values for every contact in this
      // broadcast, avoiding N+1 during the send loop.
      const contactIds = recipients
        .map((r) => r.contact?.id)
        .filter((id): id is string => Boolean(id));
      const customValueIndex = await fetchCustomValueIndex(
        supabase,
        contactIds
      );

      let failedCount = 0;
      const totalRecipients = recipients.length;

      for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
        const batch = recipients.slice(i, i + SEND_BATCH_SIZE);

        const apiRecipients = batch
          .filter((r) => r.contact?.phone)
          .map((r) => ({
            recipient_id: r.id,
            phone: r.contact!.phone as string,
            params: r.contact
              ? resolveVariables(
                  payload.variables,
                  r.contact,
                  customValueIndex.get(r.contact.id)
                )
              : [],
          }));

        if (apiRecipients.length === 0) continue;

        try {
          const res = await fetch('/api/whatsapp/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              recipients: apiRecipients,
              template_name: payload.template.name,
              template_language: payload.template.language ?? 'en_US',
              header: payload.header ?? null,
              button_params: payload.buttonParams ?? [],
            }),
          });

          const data = await res.json();

          if (!res.ok) {
            throw new Error(data.error || 'Broadcast API request failed');
          }

          const resultsByPhone = new Map<string, BroadcastApiResult>();
          for (const r of (data.results ?? []) as BroadcastApiResult[]) {
            resultsByPhone.set(r.phone, r);
          }

          for (const recipient of batch) {
            const phone = recipient.contact?.phone;
            const result = phone ? resultsByPhone.get(phone) : undefined;

            if (!result) {
              failedCount++;
              await supabase
                .from('broadcast_recipients')
                .update({
                  status: 'failed',
                  error_message: 'No phone number on contact',
                })
                .eq('id', recipient.id)
                .in('status', ['pending', 'sent']);
              continue;
            }

            if (result.status === 'sent') {
              await supabase
                .from('broadcast_recipients')
                .update({
                  whatsapp_message_id: result.whatsapp_message_id ?? null,
                  error_message: null,
                })
                .eq('id', recipient.id)
                .eq('status', 'pending');
            } else {
              failedCount++;
              await supabase
                .from('broadcast_recipients')
                .update({
                  status: 'failed',
                  error_message: result.error ?? 'Unknown error',
                })
                .eq('id', recipient.id)
                .in('status', ['pending', 'sent']);
            }
          }
        } catch (err) {
          for (const recipient of batch) {
            failedCount++;
            await supabase
              .from('broadcast_recipients')
              .update({
                status: 'failed',
                error_message:
                  err instanceof Error ? err.message : 'Unknown error',
              })
              .eq('id', recipient.id)
              .in('status', ['pending', 'sent']);
          }
        }

        const progressPct =
          30 + Math.round(((i + batch.length) / totalRecipients) * 60);
        setProgress(progressPct);

        if (i + SEND_BATCH_SIZE < recipients.length) {
          await sleep(SEND_BATCH_DELAY_MS);
        }
      }

      // ── Step 5: Finalize status ───────────────────────────────────
      // Aggregate counts are maintained by the DB trigger (migration
      // 003); we only flip the final status here.
      setProgress(95);
      const finalStatus = failedCount === totalRecipients ? 'failed' : 'sent';
      await supabase
        .from('broadcasts')
        .update({ status: finalStatus })
        .eq('id', broadcast.id);

      setProgress(100);
      return broadcast.id;
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}
