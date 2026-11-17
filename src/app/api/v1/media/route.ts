// ============================================================
// POST /api/v1/media — upload an image and get back a public URL.
//
// Integrators that generate media on a private network (e.g. an
// access-control server producing visitor QR codes on a LAN IP) can't
// hand Meta a link it can fetch — Meta's downloader rejects private
// addresses ("Blocked by fwdproxy destination filter"). This endpoint
// takes the bytes instead, stores them in the public `chat-media`
// bucket under the key's account, and returns an HTTPS URL to pass as
// `template.params.headerMediaUrl` on POST /api/v1/messages.
//
// Auth: API key with the `messages:send` scope (uploading only makes
// sense in order to send).
//
// Body — either:
//   multipart/form-data with a `file` field, or
//   application/json:
//     {
//       "data": "<base64>" | "data:image/png;base64,<base64>",   // required
//       "filename": "visitor-qr.png"                              // optional
//     }
//
// Only JPEG and PNG are accepted — the two image types WhatsApp
// allows in a template header — up to 4 MB (under both WhatsApp's
// 5 MB image limit and Vercel's 4.5 MB request-body cap). The type is
// sniffed from the bytes, not trusted from the caller.
//
// Response (201):
//   { "data": { "url", "path", "content_type", "size" } }
// ============================================================

import { randomUUID } from 'crypto';

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { buildMediaPath } from '@/lib/storage/upload-media';

const BUCKET = 'chat-media';
const FOLDER = 'api';
/** Below WhatsApp's 5 MB image limit and Vercel's 4.5 MB body cap. */
const MAX_BYTES = 4 * 1024 * 1024;

/** Identify JPEG / PNG from magic bytes. */
function sniffImageType(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { mime: 'image/png', ext: 'png' };
  }
  return null;
}

async function readUpload(
  request: Request,
): Promise<{ bytes: Buffer; filename: string | null } | { error: string }> {
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!file || typeof file === 'string') {
      return { error: "multipart body must include a 'file' field" };
    }
    return { bytes: Buffer.from(await file.arrayBuffer()), filename: file.name || null };
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return { error: "Body must be multipart/form-data with 'file', or JSON with 'data'" };
  }
  if (typeof body.data !== 'string' || !body.data.trim()) {
    return { error: "'data' (base64 image) is required" };
  }
  // Accept a bare base64 string or a full data: URI.
  const b64 = body.data.trim().replace(/^data:[^;,]*;base64,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    return { error: "'data' is not valid base64" };
  }
  return {
    bytes: Buffer.from(b64, 'base64'),
    filename: typeof body.filename === 'string' ? body.filename : null,
  };
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'messages:send');

    const upload = await readUpload(request);
    if ('error' in upload) return fail('bad_request', upload.error, 400);

    const { bytes } = upload;
    if (bytes.byteLength === 0) return fail('bad_request', 'The image is empty', 400);
    if (bytes.byteLength > MAX_BYTES) {
      return fail('bad_request', 'Image is larger than the 4 MB limit', 400);
    }
    const type = sniffImageType(bytes);
    if (!type) {
      return fail('bad_request', 'Only PNG and JPEG images are supported', 400);
    }

    // A random id keeps the URL unguessable — visitor passes are
    // access credentials, so sequential or name-derived paths would
    // let anyone enumerate them.
    const stem = (upload.filename ?? 'image').replace(/\.[^.]+$/, '');
    const path = buildMediaPath(ctx.accountId, `${randomUUID()}-${stem}.${type.ext}`, null, FOLDER);

    const storage = ctx.supabase.storage.from(BUCKET);
    const { error } = await storage.upload(path, bytes, {
      contentType: type.mime,
      cacheControl: '3600',
      upsert: false,
    });
    if (error) {
      console.error('[api/v1/media] upload failed:', error.message);
      return fail('internal', 'Could not store the image', 500);
    }

    const {
      data: { publicUrl },
    } = storage.getPublicUrl(path);

    return ok(
      { url: publicUrl, path, content_type: type.mime, size: bytes.byteLength },
      201,
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
