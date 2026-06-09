'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import {
  Contact,
  CustomField,
  MessageTemplate,
  MessageTemplateButton,
  TemplateButtonParameter,
  TemplateHeaderInput,
  TemplateHeaderMediaType,
} from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  FileText,
  FileVideo,
  Image as ImageIcon,
  Link2,
  Loader2,
  Upload,
} from 'lucide-react';

type VariableType = 'static' | 'field' | 'custom_field';

interface VariableMapping {
  type: VariableType;
  value: string;
}

interface Step3Props {
  template: MessageTemplate;
  variables: Record<string, VariableMapping>;
  header: TemplateHeaderInput | null;
  buttonParams: TemplateButtonParameter[];
  onUpdate: (variables: Record<string, VariableMapping>) => void;
  onHeaderUpdate: (header: TemplateHeaderInput | null) => void;
  onButtonParamsUpdate: (buttonParams: TemplateButtonParameter[]) => void;
  onNext: () => void;
  onBack: () => void;
}

const contactFields = [
  { value: 'name', label: 'Contact Name' },
  { value: 'phone', label: 'Phone Number' },
  { value: 'email', label: 'Email Address' },
  { value: 'company', label: 'Company' },
];

const SAMPLE_CONTACT: Contact = {
  id: 'sample',
  user_id: '',
  name: 'John Doe',
  phone: '+1234567890',
  email: 'john@example.com',
  company: 'Acme Corp',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const MAX_HEADER_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_HEADER_DOCUMENT_BYTES = 100 * 1024 * 1024;
const HEADER_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);
const HEADER_DOCUMENT_TYPES = new Set(['application/pdf']);

function isMediaHeaderType(value: unknown): value is TemplateHeaderMediaType {
  return value === 'image' || value === 'video' || value === 'document';
}

function getButtonLabel(button: MessageTemplateButton): string {
  return button.text?.trim() || button.url?.trim() || 'Button';
}

function getButtonType(button: MessageTemplateButton): string {
  return button.type?.toUpperCase() ?? '';
}

function isDynamicUrlButton(button: MessageTemplateButton): boolean {
  return (
    getButtonType(button) === 'URL' && /\{\{\d+\}\}/.test(button.url ?? '')
  );
}

function isUrlButton(button: MessageTemplateButton): boolean {
  return getButtonType(button) === 'URL';
}

function normalizeDocumentFilename(value: string | undefined): string {
  return value?.trim().replace(/[\\/]/g, '') ?? '';
}

function inferDocumentFilename(mediaUrl: string): string {
  if (!mediaUrl.trim()) return '';
  try {
    const url = new URL(mediaUrl);
    const lastSegment = url.pathname.split('/').filter(Boolean).pop();
    return normalizeDocumentFilename(
      lastSegment ? decodeURIComponent(lastSegment) : undefined
    );
  } catch {
    return '';
  }
}

export function Step3Personalize({
  template,
  variables,
  header,
  buttonParams,
  onUpdate,
  onHeaderUpdate,
  onButtonParamsUpdate,
  onNext,
  onBack,
}: Step3Props) {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingFields, setLoadingFields] = useState(true);
  const [uploadingHeaderImage, setUploadingHeaderImage] = useState(false);
  const [uploadingHeaderDocument, setUploadingHeaderDocument] = useState(false);
  const [firstContact, setFirstContact] = useState<Contact | null>(null);
  const [firstContactCustomValues, setFirstContactCustomValues] = useState<
    Map<string, string>
  >(new Map());
  const [loadingPreview, setLoadingPreview] = useState(true);

  // Load user's custom fields + a representative contact for the
  // live preview. Fall back to sample data if no contacts exist yet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const [fieldsRes, contactRes] = await Promise.all([
        supabase.from('custom_fields').select('*').order('field_name'),
        supabase
          .from('contacts')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (cancelled) return;

      setCustomFields(fieldsRes.data ?? []);
      setLoadingFields(false);

      const contact = contactRes.data ?? null;
      setFirstContact(contact);

      if (contact) {
        const { data: customVals } = await supabase
          .from('contact_custom_values')
          .select('custom_field_id, value')
          .eq('contact_id', contact.id);
        if (!cancelled) {
          const map = new Map<string, string>();
          for (const row of customVals ?? []) {
            map.set(row.custom_field_id, row.value ?? '');
          }
          setFirstContactCustomValues(map);
        }
      }
      setLoadingPreview(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const mediaHeaderType = isMediaHeaderType(template.header_type)
    ? template.header_type
    : null;
  const headerMediaUrl =
    mediaHeaderType && header?.type === mediaHeaderType
      ? (header.media_url ?? header.mediaUrl ?? '')
      : '';
  const headerDocumentFilename =
    mediaHeaderType === 'document' && header?.type === 'document'
      ? (header.filename ?? '')
      : '';
  const templateButtons = useMemo(
    () => template.buttons ?? [],
    [template.buttons]
  );
  const urlButtons = useMemo(
    () =>
      templateButtons
        .map((button, index) => ({ button, index }))
        .filter(({ button }) => isUrlButton(button)),
    [templateButtons]
  );

  const placeholders = useMemo(() => {
    const matches = template.body_text.match(/\{\{(\d+)\}\}/g);
    if (!matches) return [];
    return [...new Set(matches)].sort();
  }, [template.body_text]);

  const dynamicUrlButtons = useMemo(
    () => urlButtons.filter(({ button }) => isDynamicUrlButton(button)),
    [urlButtons]
  );

  /**
   * A placeholder is "unmapped" if the user hasn't picked either a
   * static value or a field/custom-field source. Blocks Next until
   * every placeholder has something — otherwise the broadcast would
   * ship with empty strings and confuse recipients.
   */
  const unmappedKeys = useMemo(() => {
    const missing: string[] = [];
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      if (!mapping || !mapping.value?.trim()) {
        missing.push(placeholder);
      }
    }
    if (mediaHeaderType && !headerMediaUrl.trim()) {
      missing.push(`${mediaHeaderType} header`);
    }
    if (
      mediaHeaderType === 'document' &&
      !headerDocumentFilename.trim() &&
      !inferDocumentFilename(headerMediaUrl)
    ) {
      missing.push('document filename');
    }
    for (const { index } of dynamicUrlButtons) {
      const param = buttonParams.find(
        (p) => p.type === 'url' && String(p.index) === String(index)
      );
      if (!param || param.type !== 'url' || !param.text.trim()) {
        missing.push(`button ${index + 1} URL`);
      }
    }
    return missing;
  }, [
    placeholders,
    variables,
    mediaHeaderType,
    headerMediaUrl,
    headerDocumentFilename,
    dynamicUrlButtons,
    buttonParams,
  ]);

  function updateVariable(key: string, patch: Partial<VariableMapping>) {
    const current = variables[key] ?? {
      type: 'static' as VariableType,
      value: '',
    };
    onUpdate({
      ...variables,
      [key]: { ...current, ...patch },
    });
  }

  function updateHeaderMediaUrl(mediaUrl: string) {
    if (!mediaHeaderType) return;
    const currentFilename =
      mediaHeaderType === 'document' && header?.type === 'document'
        ? normalizeDocumentFilename(header.filename)
        : '';
    const previousInferredFilename =
      mediaHeaderType === 'document'
        ? inferDocumentFilename(headerMediaUrl)
        : '';
    const inferredFilename =
      mediaHeaderType === 'document' ? inferDocumentFilename(mediaUrl) : '';
    const hasCustomFilename =
      currentFilename && currentFilename !== previousInferredFilename;
    const filename = hasCustomFilename
      ? currentFilename
      : inferredFilename || currentFilename;
    onHeaderUpdate(
      mediaUrl
        ? {
            type: mediaHeaderType,
            media_url: mediaUrl,
            ...(mediaHeaderType === 'document' && filename ? { filename } : {}),
          }
        : null
    );
  }

  function updateHeaderDocumentFilename(filename: string) {
    if (mediaHeaderType !== 'document') return;
    const cleanFilename = normalizeDocumentFilename(filename);
    onHeaderUpdate(
      headerMediaUrl || cleanFilename
        ? {
            type: 'document',
            media_url: headerMediaUrl,
            ...(cleanFilename ? { filename: cleanFilename } : {}),
          }
        : null
    );
  }

  function getUrlButtonParam(index: number): string {
    const param = buttonParams.find(
      (p) => p.type === 'url' && String(p.index) === String(index)
    );
    return param?.type === 'url' ? param.text : '';
  }

  function updateUrlButtonParam(index: number, text: string) {
    const next = buttonParams.filter(
      (p) => !(p.type === 'url' && String(p.index) === String(index))
    );
    if (text) {
      next.push({ type: 'url', index, text });
    }
    onButtonParamsUpdate(next);
  }

  async function uploadHeaderImage(file: File | undefined) {
    if (!file) return;

    if (!HEADER_IMAGE_TYPES.has(file.type)) {
      toast.error('Upload a JPG or PNG image.');
      return;
    }

    if (file.size > MAX_HEADER_IMAGE_BYTES) {
      toast.error('Header image must be 5 MB or smaller.');
      return;
    }

    setUploadingHeaderImage(true);
    try {
      const formData = new FormData();
      formData.set('file', file);
      const response = await fetch('/api/whatsapp/template-media/upload', {
        method: 'POST',
        body: formData,
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload?.error || `Upload failed (${response.status})`);
      }

      updateHeaderMediaUrl(payload.url);
      toast.success('Header image uploaded');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Upload failed');
    } finally {
      setUploadingHeaderImage(false);
    }
  }

  async function uploadHeaderDocument(file: File | undefined) {
    if (!file) return;

    if (
      !HEADER_DOCUMENT_TYPES.has(file.type) &&
      !file.name.toLowerCase().endsWith('.pdf')
    ) {
      toast.error('Upload a PDF document.');
      return;
    }

    if (file.size > MAX_HEADER_DOCUMENT_BYTES) {
      toast.error('Header PDF must be 100 MB or smaller.');
      return;
    }

    setUploadingHeaderDocument(true);
    try {
      const formData = new FormData();
      formData.set('file', file);
      const response = await fetch('/api/whatsapp/template-media/upload', {
        method: 'POST',
        body: formData,
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload?.error || `Upload failed (${response.status})`);
      }

      onHeaderUpdate({
        type: 'document',
        media_url: payload.url,
        filename:
          normalizeDocumentFilename(payload.filename) ||
          normalizeDocumentFilename(file.name) ||
          inferDocumentFilename(payload.url),
      });
      toast.success('Header PDF uploaded');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Upload failed');
    } finally {
      setUploadingHeaderDocument(false);
    }
  }

  /**
   * Substitute placeholders using the first real contact where
   * possible. Placeholders keyed by "{{N}}" map to variable key "N".
   */
  const previewText = useMemo(() => {
    const contact = firstContact ?? SAMPLE_CONTACT;
    const customValues = firstContact
      ? firstContactCustomValues
      : new Map<string, string>();

    let text = template.body_text;
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      let replacement = placeholder;

      if (mapping) {
        if (mapping.type === 'static' && mapping.value) {
          replacement = mapping.value;
        } else if (mapping.type === 'field' && mapping.value) {
          const fieldMap: Record<string, string | undefined> = {
            name: contact.name,
            phone: contact.phone,
            email: contact.email,
            company: contact.company,
          };
          replacement = fieldMap[mapping.value] ?? placeholder;
        } else if (mapping.type === 'custom_field' && mapping.value) {
          replacement = customValues.get(mapping.value) || placeholder;
        }
      }
      text = text.replaceAll(placeholder, replacement);
    }
    return text;
  }, [
    template.body_text,
    variables,
    placeholders,
    firstContact,
    firstContactCustomValues,
  ]);

  const previewLabel = firstContact
    ? firstContact.name || firstContact.phone
    : 'sample data';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">
          Personalize Message
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          Map template variables to contact fields, custom fields, or static
          values.
        </p>
      </div>

      {mediaHeaderType && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <div className="mb-3 flex items-center gap-2">
            {mediaHeaderType === 'image' ? (
              <ImageIcon className="text-primary h-4 w-4" />
            ) : mediaHeaderType === 'video' ? (
              <FileVideo className="text-primary h-4 w-4" />
            ) : (
              <FileText className="text-primary h-4 w-4" />
            )}
            <span className="text-sm font-medium text-white">
              {mediaHeaderType.charAt(0).toUpperCase() +
                mediaHeaderType.slice(1)}{' '}
              header
            </span>
          </div>
          <Input
            value={headerMediaUrl}
            onChange={(e) => updateHeaderMediaUrl(e.target.value)}
            placeholder={
              mediaHeaderType === 'image'
                ? 'https://example.com/header.jpg'
                : mediaHeaderType === 'video'
                  ? 'https://example.com/header.mp4'
                  : 'https://example.com/header.pdf'
            }
            className="border-slate-700 bg-slate-800 text-white placeholder:text-slate-500"
          />
          {mediaHeaderType === 'document' && (
            <div className="mt-3">
              <label className="mb-1.5 block text-xs font-medium text-slate-400">
                Document filename
              </label>
              <Input
                value={headerDocumentFilename}
                onChange={(e) => updateHeaderDocumentFilename(e.target.value)}
                placeholder={
                  inferDocumentFilename(headerMediaUrl) ||
                  'auction-catalogue.pdf'
                }
                className="border-slate-700 bg-slate-800 text-white placeholder:text-slate-500"
              />
              <p className="mt-2 text-xs text-slate-500">
                This is the name recipients see in WhatsApp instead of Untitled.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  ref={documentInputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    void uploadHeaderDocument(file);
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => documentInputRef.current?.click()}
                  disabled={uploadingHeaderDocument}
                  className="border-slate-700 text-slate-300"
                >
                  {uploadingHeaderDocument ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  Upload PDF
                </Button>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                A direct public PDF URL with application/pdf metadata gives
                WhatsApp the best chance to render the document preview.
              </p>
            </div>
          )}
          {mediaHeaderType === 'image' && (
            <>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/jpeg,image/png"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    void uploadHeaderImage(file);
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={uploadingHeaderImage}
                  className="border-slate-700 text-slate-300"
                >
                  {uploadingHeaderImage ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  Upload JPG/PNG
                </Button>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Use a public JPG or PNG URL. WhatsApp does not accept WebP for
                template image headers.
              </p>
            </>
          )}
        </div>
      )}

      {placeholders.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 text-center">
          <p className="text-sm text-slate-400">
            This template has no variables to personalize.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {placeholders.map((placeholder) => {
            const key = placeholder.replace(/^\{\{|\}\}$/g, '');
            const mapping = variables[key] ?? { type: 'static', value: '' };

            return (
              <div
                key={placeholder}
                className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <span className="bg-primary/10 text-primary inline-flex items-center rounded-md px-2 py-0.5 font-mono text-xs font-medium">
                    {placeholder}
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-slate-400">
                      Mapping Type
                    </label>
                    <Select
                      value={mapping.type}
                      onValueChange={(val) =>
                        updateVariable(key, {
                          type: val as VariableType,
                          value: '',
                        })
                      }
                    >
                      <SelectTrigger className="w-full border-slate-700 bg-slate-800 text-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-slate-700 bg-slate-800">
                        <SelectItem value="static">Static Value</SelectItem>
                        <SelectItem value="field">Contact Field</SelectItem>
                        <SelectItem value="custom_field">
                          Custom Field
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-slate-400">
                      {mapping.type === 'static' ? 'Value' : 'Field'}
                    </label>
                    {mapping.type === 'static' ? (
                      <Input
                        value={mapping.value}
                        onChange={(e) =>
                          updateVariable(key, { value: e.target.value })
                        }
                        placeholder="Enter value..."
                        className="border-slate-700 bg-slate-800 text-white placeholder:text-slate-500"
                      />
                    ) : mapping.type === 'field' ? (
                      <Select
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateVariable(key, { value: val || '' })
                        }
                      >
                        <SelectTrigger className="w-full border-slate-700 bg-slate-800 text-white">
                          <SelectValue placeholder="Select field..." />
                        </SelectTrigger>
                        <SelectContent className="border-slate-700 bg-slate-800">
                          {contactFields.map((field) => (
                            <SelectItem key={field.value} value={field.value}>
                              {field.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Select
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateVariable(key, { value: val || '' })
                        }
                      >
                        <SelectTrigger className="w-full border-slate-700 bg-slate-800 text-white">
                          <SelectValue
                            placeholder={
                              loadingFields
                                ? 'Loading…'
                                : customFields.length === 0
                                  ? 'No custom fields'
                                  : 'Select custom field…'
                            }
                          />
                        </SelectTrigger>
                        <SelectContent className="border-slate-700 bg-slate-800">
                          {customFields.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {f.field_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {urlButtons.length > 0 && (
        <div className="space-y-4">
          {urlButtons.map(({ button, index }) => {
            const dynamic = isDynamicUrlButton(button);

            return (
              <div
                key={`${index}-${getButtonLabel(button)}`}
                className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <Link2 className="text-primary h-4 w-4" />
                  <span className="text-sm font-medium text-white">
                    {getButtonLabel(button)}
                  </span>
                </div>
                {dynamic ? (
                  <Input
                    value={getUrlButtonParam(index)}
                    onChange={(e) =>
                      updateUrlButtonParam(index, e.target.value)
                    }
                    placeholder="URL suffix"
                    className="border-slate-700 bg-slate-800 text-white placeholder:text-slate-500"
                  />
                ) : (
                  <Input
                    value={button.url ?? ''}
                    readOnly
                    className="border-slate-700 bg-slate-800 text-white"
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Live Preview — rendered as a WhatsApp-style bubble so the user
          sees approximately what the recipient will see. */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Eye className="text-primary h-4 w-4" />
          <p className="text-sm font-medium text-white">Live Preview</p>
          <span className="text-xs text-slate-500">({previewLabel})</span>
          {loadingPreview && (
            <Loader2 className="text-primary h-3.5 w-3.5 animate-spin" />
          )}
        </div>
        <div className="rounded-lg bg-[#0e1a12] p-3">
          <div className="bg-primary/30 ml-auto max-w-[85%] overflow-hidden rounded-lg shadow-sm">
            {mediaHeaderType === 'image' && headerMediaUrl && (
              <img
                src={headerMediaUrl}
                alt=""
                className="max-h-56 w-full object-cover"
              />
            )}
            {mediaHeaderType &&
              mediaHeaderType !== 'image' &&
              headerMediaUrl && (
                <div className="border-primary/20 text-primary flex items-center gap-2 border-b px-3 py-2 text-xs">
                  {mediaHeaderType === 'video' ? (
                    <FileVideo className="h-4 w-4" />
                  ) : (
                    <FileText className="h-4 w-4" />
                  )}
                  <span className="truncate">
                    {mediaHeaderType === 'document'
                      ? headerDocumentFilename ||
                        inferDocumentFilename(headerMediaUrl) ||
                        headerMediaUrl
                      : headerMediaUrl}
                  </span>
                </div>
              )}
            {mediaHeaderType && !headerMediaUrl && (
              <div className="border-primary/20 text-primary/70 flex h-28 items-center justify-center border-b">
                {mediaHeaderType === 'image' ? (
                  <ImageIcon className="h-8 w-8" />
                ) : mediaHeaderType === 'video' ? (
                  <FileVideo className="h-8 w-8" />
                ) : (
                  <FileText className="h-8 w-8" />
                )}
              </div>
            )}
            <div className="px-3 py-2">
              <p className="text-primary text-sm whitespace-pre-wrap">
                {previewText}
              </p>
              {template.footer_text && (
                <p className="text-primary/70 mt-2 text-xs italic">
                  {template.footer_text}
                </p>
              )}
            </div>
            {templateButtons.length > 0 && (
              <div className="divide-primary/15 border-primary/20 divide-y border-t">
                {templateButtons.map((button, index) => (
                  <div
                    key={`${index}-${getButtonLabel(button)}`}
                    className="text-primary flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium"
                  >
                    <Link2 className="h-4 w-4" />
                    <span className="truncate">{getButtonLabel(button)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {unmappedKeys.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          Complete every required template input before continuing — still
          missing{' '}
          <span className="font-mono font-semibold">
            {unmappedKeys.join(', ')}
          </span>
          .
        </div>
      )}

      <div className="flex items-center justify-between border-t border-slate-800 pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-slate-700 text-slate-300"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        <Button
          onClick={onNext}
          disabled={unmappedKeys.length > 0}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Next
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
