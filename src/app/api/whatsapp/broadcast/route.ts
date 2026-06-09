import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import type { TemplateButtonParameter, TemplateHeaderInput } from '@/types';

interface BroadcastResult {
  phone: string;
  status: 'sent' | 'failed';
  whatsapp_message_id?: string;
  error?: string;
}

/**
 * Two input shapes are accepted:
 *
 *   NEW (preferred — supports per-recipient variable substitution):
 *     {
 *       recipients: Array<{ phone: string; params: string[] }>,
 *       template_name, template_language
 *     }
 *
 *   LEGACY (all phones receive the same params — kept so existing
 *   callers don't break):
 *     {
 *       phone_numbers: string[],
 *       template_params: string[],
 *       template_name, template_language
 *     }
 *
 * Previous implementation only supported the legacy shape, and the
 * sending hook was forced to ship every batch with `templateParams[0]`
 * — meaning every recipient got contact-0's personalization. The new
 * shape is what actually fixes that.
 */
interface NewRecipient {
  recipient_id?: string;
  phone: string;
  params?: string[];
  header?: TemplateHeaderInput | null;
  button_params?: TemplateButtonParameter[];
}

type TemplateHeaderType = 'text' | 'image' | 'video' | 'document';

export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Per-user broadcast budget. Note: this limits how often a user
    // can *start* a campaign, not how many messages go out inside
    // one — the fan-out loop below runs without additional gating.
    const limit = checkRateLimit(`broadcast:${user.id}`, RATE_LIMITS.broadcast);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const body = await request.json();
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
      header,
      template_header,
      button_params,
      template_buttons,
    } = body;

    // Normalize to a list of {phone, params} regardless of shape.
    let recipients: NewRecipient[];
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients;
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params)
        ? template_params
        : [];
      recipients = phone_numbers.map((phone: string) => ({
        phone,
        params: shared,
      }));
    } else {
      return NextResponse.json(
        {
          error:
            'Provide either `recipients` (preferred) or `phone_numbers` — must be a non-empty array',
        },
        { status: 400 }
      );
    }

    if (!template_name) {
      return NextResponse.json(
        { error: 'template_name is required' },
        { status: 400 }
      );
    }

    const sharedHeader = normalizeTemplateHeader(header ?? template_header);
    const sharedButtonParams = normalizeButtonParams(
      button_params ?? template_buttons
    );

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Please set up your WhatsApp integration first.',
        },
        { status: 400 }
      );
    }

    const accessToken = decrypt(config.access_token);

    const { data: templateRow } = await supabase
      .from('message_templates')
      .select('header_type')
      .eq('user_id', user.id)
      .eq('name', template_name)
      .eq('language', template_language || 'en_US')
      .maybeSingle();

    const headerType = normalizeHeaderType(templateRow?.header_type);
    if (
      isMediaHeaderType(headerType) &&
      !recipients.every((r) =>
        hasHeaderMedia(
          normalizeTemplateHeader(r.header ?? sharedHeader),
          headerType
        )
      )
    ) {
      return NextResponse.json(
        {
          error: `Template "${template_name}" requires a public ${headerType} header URL before sending.`,
        },
        { status: 400 }
      );
    }

    const headerMediaError = await validateSharedHeaderMedia(sharedHeader);
    if (headerMediaError) {
      return NextResponse.json({ error: headerMediaError }, { status: 400 });
    }

    const results: BroadcastResult[] = [];
    let sentCount = 0;
    let failedCount = 0;

    for (const recipient of recipients) {
      const sanitized = sanitizePhoneForMeta(recipient.phone);

      if (!isValidE164(sanitized)) {
        if (recipient.recipient_id) {
          await supabase
            .from('broadcast_recipients')
            .update({
              status: 'failed',
              error_message: 'Invalid phone number format',
            })
            .eq('id', recipient.recipient_id)
            .in('status', ['pending', 'sent']);
        }

        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: 'Invalid phone number format',
        });
        failedCount++;
        continue;
      }

      // Retry with phone variants on "not in allowed list" so numbers
      // that differ only in a trunk-prefix 0 still reach recipients.
      const variants = phoneVariants(sanitized);
      let sentMessageId: string | null = null;
      let lastError: string | null = null;

      for (const variant of variants) {
        try {
          const result = await sendTemplateMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: variant,
            templateName: template_name,
            language: template_language || 'en_US',
            params: recipient.params ?? [],
            header: normalizeTemplateHeader(recipient.header ?? sharedHeader),
            buttonParams: normalizeButtonParams(
              recipient.button_params ?? sharedButtonParams
            ),
          });
          sentMessageId = result.messageId;
          lastError = null;
          break;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
          if (!isRecipientNotAllowedError(errorMessage)) {
            lastError = errorMessage;
            break;
          }
          lastError = errorMessage;
          // retry with next variant
        }
      }

      if (sentMessageId) {
        if (recipient.recipient_id) {
          await supabase
            .from('broadcast_recipients')
            .update({
              whatsapp_message_id: sentMessageId,
              error_message: null,
            })
            .eq('id', recipient.recipient_id)
            .eq('status', 'pending');
        }

        results.push({
          phone: recipient.phone,
          status: 'sent',
          whatsapp_message_id: sentMessageId,
        });
        sentCount++;
      } else {
        console.error(
          `Failed to send broadcast to ${recipient.phone}:`,
          lastError
        );
        if (recipient.recipient_id) {
          await supabase
            .from('broadcast_recipients')
            .update({
              status: 'failed',
              error_message: lastError || 'Unknown error',
            })
            .eq('id', recipient.recipient_id)
            .in('status', ['pending', 'sent']);
        }

        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: lastError || 'Unknown error',
        });
        failedCount++;
      }
    }

    return NextResponse.json({
      success: true,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      results,
    });
  } catch (error) {
    console.error('Error in WhatsApp broadcast POST:', error);
    return NextResponse.json(
      { error: 'Failed to process broadcast' },
      { status: 500 }
    );
  }
}

function normalizeHeaderType(value: unknown): TemplateHeaderType | null {
  if (
    value === 'text' ||
    value === 'image' ||
    value === 'video' ||
    value === 'document'
  ) {
    return value;
  }
  return null;
}

function isMediaHeaderType(
  type: TemplateHeaderType | null
): type is Exclude<TemplateHeaderType, 'text'> {
  return type === 'image' || type === 'video' || type === 'document';
}

function normalizeTemplateHeader(value: unknown): TemplateHeaderInput | null {
  if (!value || typeof value !== 'object') return null;
  const header = value as Partial<TemplateHeaderInput>;
  if (
    header.type === 'text' ||
    header.type === 'image' ||
    header.type === 'video' ||
    header.type === 'document'
  ) {
    return header as TemplateHeaderInput;
  }
  return null;
}

function normalizeButtonParams(value: unknown): TemplateButtonParameter[] {
  if (!Array.isArray(value)) return [];
  return value.filter((button): button is TemplateButtonParameter => {
    if (!button || typeof button !== 'object') return false;
    const candidate = button as Partial<TemplateButtonParameter>;
    return (
      (candidate.type === 'url' && typeof candidate.text === 'string') ||
      (candidate.type === 'quick_reply' &&
        typeof candidate.payload === 'string')
    );
  });
}

function hasHeaderMedia(
  header: TemplateHeaderInput | null,
  type: Exclude<TemplateHeaderType, 'text'>
) {
  if (!header || header.type !== type) return false;
  return Boolean(
    header.media_url || header.mediaUrl || header.media_id || header.mediaId
  );
}

async function validateSharedHeaderMedia(
  header: TemplateHeaderInput | null
): Promise<string | null> {
  if (!header || (header.type !== 'image' && header.type !== 'document')) {
    return null;
  }

  const mediaUrl = header.media_url ?? header.mediaUrl;
  if (!mediaUrl) return null;

  let url: URL;
  try {
    url = new URL(mediaUrl);
  } catch {
    return `Template ${header.type} header URL is not a valid URL.`;
  }

  if (header.type === 'image' && url.pathname.toLowerCase().endsWith('.webp')) {
    return 'WhatsApp template image headers must use JPEG or PNG. Convert the .webp header image to .jpg or .png and use that public URL.';
  }

  let response: Response;
  try {
    response = await fetch(mediaUrl, { method: 'HEAD' });
  } catch {
    return `Could not verify the template ${header.type} header URL. Make sure it is publicly accessible.`;
  }

  if (!response.ok) {
    return `Template ${header.type} header URL is not accessible (HTTP ${response.status}).`;
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';

  if (header.type === 'image') {
    if (
      !['image/jpeg', 'image/png'].some((type) => contentType.startsWith(type))
    ) {
      return `WhatsApp template image headers must return image/jpeg or image/png. The current URL returns ${contentType || 'no content type'}.`;
    }
    return null;
  }

  if (!contentType.startsWith('application/pdf')) {
    return `WhatsApp PDF document headers should return application/pdf so WhatsApp can render the document preview. The current URL returns ${contentType || 'no content type'}. Upload the PDF here or use a direct public PDF URL.`;
  }

  const filename = header.filename?.trim() || url.pathname.split('/').pop();
  if (!filename?.toLowerCase().endsWith('.pdf')) {
    return 'WhatsApp PDF document headers should include a filename ending in .pdf.';
  }

  return null;
}
