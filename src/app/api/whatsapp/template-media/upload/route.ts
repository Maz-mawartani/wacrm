import { createClient as createAdminClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const BUCKET = 'template-media';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
const BUCKET_SIZE_BUFFER_BYTES = 512 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);
const ALLOWED_DOCUMENT_TYPES = new Set(['application/pdf']);
const ALLOWED_MEDIA_TYPES = new Set([
  ...ALLOWED_IMAGE_TYPES,
  ...ALLOWED_DOCUMENT_TYPES,
]);

function adminClient() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

async function ensureBucket(fileSize: number, mediaType: string) {
  const admin = adminClient();
  const { data } = await admin.storage.getBucket(BUCKET);
  if (data) {
    const update = buildBucketUpdate(data, fileSize, mediaType);
    if (!update) return;

    const { error } = await admin.storage.updateBucket(BUCKET, update);
    if (error) {
      throw new Error(formatBucketSetupError(error.message, update));
    }
    return;
  }

  const { error } = await admin.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: getDesiredBucketLimit(fileSize, mediaType),
    allowedMimeTypes: [...ALLOWED_MEDIA_TYPES],
  });

  if (error && !error.message.toLowerCase().includes('already exists')) {
    throw new Error(
      formatBucketSetupError(error.message, {
        public: true,
        fileSizeLimit: getDesiredBucketLimit(fileSize, mediaType),
        allowedMimeTypes: [...ALLOWED_MEDIA_TYPES],
      })
    );
  }
}

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

    const formData = await request.formData();
    const value = formData.get('file');

    if (!value || typeof value === 'string') {
      return NextResponse.json(
        { error: 'Media file is required' },
        { status: 400 }
      );
    }

    const file = value as File;
    const mediaType = detectMediaType(file);
    if (!mediaType) {
      return NextResponse.json(
        {
          error:
            'Upload a JPG/PNG image or PDF document for WhatsApp template headers.',
        },
        { status: 400 }
      );
    }

    if (ALLOWED_IMAGE_TYPES.has(mediaType) && file.size > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        { error: 'Header image must be 5 MB or smaller.' },
        { status: 400 }
      );
    }

    if (
      ALLOWED_DOCUMENT_TYPES.has(mediaType) &&
      file.size > MAX_DOCUMENT_BYTES
    ) {
      return NextResponse.json(
        { error: 'Header PDF must be 100 MB or smaller.' },
        { status: 400 }
      );
    }

    await ensureBucket(file.size, mediaType);

    const { ext, filename } = normalizeUploadName(file, mediaType);
    const path = `${user.id}/template-header-${crypto.randomUUID()}-${filename}`;
    const buffer = Buffer.from(await file.arrayBuffer());
    const admin = adminClient();
    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(path, buffer, {
        cacheControl: '31536000',
        contentType: mediaType,
        upsert: false,
      });

    if (uploadError) {
      return NextResponse.json(
        { error: `Upload failed: ${uploadError.message}` },
        { status: 500 }
      );
    }

    const {
      data: { publicUrl },
    } = admin.storage.from(BUCKET).getPublicUrl(path);

    return NextResponse.json({
      url: publicUrl,
      path,
      filename,
      mediaType: ALLOWED_DOCUMENT_TYPES.has(mediaType) ? 'document' : 'image',
      extension: ext,
    });
  } catch (error) {
    console.error('Template media upload failed:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to upload media',
      },
      { status: 500 }
    );
  }
}

function detectMediaType(file: File): string | null {
  if (ALLOWED_MEDIA_TYPES.has(file.type)) return file.type;
  if (file.name.toLowerCase().endsWith('.pdf')) return 'application/pdf';
  return null;
}

function buildBucketUpdate(
  bucket: {
    public?: boolean;
    file_size_limit?: number | null;
    allowed_mime_types?: string[] | null;
  },
  fileSize: number,
  mediaType: string
): {
  public: boolean;
  fileSizeLimit?: number;
  allowedMimeTypes?: string[];
} | null {
  const update: {
    public: boolean;
    fileSizeLimit?: number;
    allowedMimeTypes?: string[];
  } = { public: true };

  const currentLimit =
    typeof bucket.file_size_limit === 'number' ? bucket.file_size_limit : null;
  const desiredLimit = getDesiredBucketLimit(fileSize, mediaType);
  if (currentLimit !== null && currentLimit < fileSize) {
    update.fileSizeLimit = Math.max(desiredLimit, fileSize);
  }

  if (Array.isArray(bucket.allowed_mime_types)) {
    const nextTypes = new Set(bucket.allowed_mime_types);
    if (!nextTypes.has(mediaType)) {
      nextTypes.add(mediaType);
      update.allowedMimeTypes = [...nextTypes];
    }
  }

  const needsUpdate =
    bucket.public === false ||
    update.fileSizeLimit !== undefined ||
    update.allowedMimeTypes !== undefined;
  return needsUpdate ? update : null;
}

function getDesiredBucketLimit(fileSize: number, mediaType: string): number {
  if (ALLOWED_IMAGE_TYPES.has(mediaType)) return MAX_IMAGE_BYTES;
  return Math.min(
    MAX_DOCUMENT_BYTES,
    Math.max(MAX_IMAGE_BYTES, fileSize + BUCKET_SIZE_BUFFER_BYTES)
  );
}

function formatBucketSetupError(
  message: string,
  update: { fileSizeLimit?: number; [key: string]: unknown }
): string {
  if (message.toLowerCase().includes('maximum allowed size')) {
    const requested = update.fileSizeLimit
      ? ` Requested bucket limit: ${formatBytes(update.fileSizeLimit)}.`
      : '';
    return `Storage bucket setup failed: Supabase rejected the bucket file-size limit.${requested} Lower the PDF size or raise the Supabase Storage global file size limit.`;
  }
  return `Storage bucket setup failed: ${message}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeUploadName(
  file: File,
  mediaType: string
): { ext: string; filename: string } {
  const ext =
    mediaType === 'application/pdf'
      ? 'pdf'
      : mediaType === 'image/png'
        ? 'png'
        : 'jpg';
  const fallback = `template-header.${ext}`;
  const source = file.name || fallback;
  const withoutSlashes = source.replace(/[\\/]/g, '-');
  const clean = withoutSlashes
    .replace(/[^a-zA-Z0-9._ -]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 120);
  const withExtension = clean.toLowerCase().endsWith(`.${ext}`)
    ? clean
    : `${clean || 'template-header'}.${ext}`;
  return { ext, filename: withExtension };
}
