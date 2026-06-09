import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { verifyPhoneNumber } from '@/lib/whatsapp/meta-api'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

/**
 * GET /api/whatsapp/config
 *
 * Used by the "Test API Connection" button and by the page to check
 * whether the saved config is healthy. Returns 200 in all non-auth cases
 * so the UI can render an appropriate message rather than show a 500.
 *
 * Response shape:
 *   { connected: true,  phone_info: {...} }
 *   { connected: false, reason: 'no_config',        message: '...' }
 *   { connected: false, reason: 'token_corrupted',  message: '...', needs_reset: true }
 *   { connected: false, reason: 'meta_api_error',   message: '...' }
 */
export async function GET() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token, status')
      .eq('user_id', user.id)
      .maybeSingle()

    if (configError) {
      console.error('Error fetching whatsapp_config:', configError)
      return NextResponse.json(
        { connected: false, reason: 'db_error', message: 'Failed to fetch configuration' },
        { status: 200 }
      )
    }

    if (!config) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message: 'No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.',
        },
        { status: 200 }
      )
    }

    // Try to decrypt the stored token with the current ENCRYPTION_KEY.
    // If this fails, the key changed (or was never consistent across envs).
    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch (err) {
      console.error('[whatsapp/config GET] Token decryption failed:', err)
      return NextResponse.json(
        {
          connected: false,
          reason: 'token_corrupted',
          needs_reset: true,
          message:
            'The stored access token cannot be decrypted with the current ENCRYPTION_KEY. This usually means the key changed, or it differs between environments (local vs Hostinger vs Vercel). Click "Reset Configuration" below, then re-save.',
        },
        { status: 200 }
      )
    }

    // Validate credentials against Meta
    try {
      const phoneInfo = await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken,
      })
      return NextResponse.json({ connected: true, phone_info: phoneInfo })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('[whatsapp/config GET] Meta API verification failed:', message)
      return NextResponse.json(
        {
          connected: false,
          reason: 'meta_api_error',
          message: `Meta API rejected the credentials: ${message}`,
        },
        { status: 200 }
      )
    }
  } catch (error) {
    console.error('Error in WhatsApp config GET:', error)
    return NextResponse.json(
      { connected: false, reason: 'unknown', message: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/whatsapp/config
 *
 * Saves or updates the WhatsApp config for the authenticated user.
 * Verifies credentials with Meta first, then encrypts and stores.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const phoneNumberId =
      typeof body.phone_number_id === 'string' ? body.phone_number_id.trim() : ''
    const wabaId = typeof body.waba_id === 'string' ? body.waba_id.trim() : ''
    const accessTokenInput =
      typeof body.access_token === 'string' ? body.access_token.trim() : ''
    const verifyTokenInput =
      typeof body.verify_token === 'string' ? body.verify_token.trim() : ''
    const hasVerifyTokenInput = Object.prototype.hasOwnProperty.call(
      body,
      'verify_token'
    )

    if (!phoneNumberId) {
      return NextResponse.json(
        { error: 'phone_number_id is required' },
        { status: 400 }
      )
    }

    const { data: existing, error: existingError } = await supabase
      .from('whatsapp_config')
      .select('id, access_token')
      .eq('user_id', user.id)
      .maybeSingle()

    if (existingError) {
      console.error('Error fetching existing whatsapp_config:', existingError)
      return NextResponse.json(
        { error: 'Failed to fetch existing configuration' },
        { status: 500 }
      )
    }

    if (!existing && !accessTokenInput) {
      return NextResponse.json(
        { error: 'access_token and phone_number_id are required' },
        { status: 400 }
      )
    }

    let accessToken = accessTokenInput
    if (!accessToken && existing?.access_token) {
      try {
        accessToken = decrypt(existing.access_token)
      } catch (err) {
        console.error('[whatsapp/config POST] Token decryption failed:', err)
        return NextResponse.json(
          {
            error:
              'Stored access token cannot be decrypted with the current ENCRYPTION_KEY. Reset the configuration, then re-save it with the permanent access token.',
          },
          { status: 400 }
        )
      }
    }

    // Verify credentials with Meta BEFORE saving
    let phoneInfo
    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId,
        accessToken,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('Meta API verification failed during save:', message)
      return NextResponse.json(
        { error: `Meta API error: ${message}` },
        { status: 400 }
      )
    }

    // Encrypt sensitive tokens before storing
    let encryptedAccessToken: string | undefined
    let encryptedVerifyToken: string | null | undefined
    try {
      encryptedAccessToken = accessTokenInput
        ? encrypt(accessTokenInput)
        : undefined
      encryptedVerifyToken = hasVerifyTokenInput
        ? verifyTokenInput
          ? encrypt(verifyTokenInput)
          : null
        : undefined
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown encryption error'
      console.error('Encryption failed:', message)
      return NextResponse.json(
        {
          error:
            'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        { status: 500 }
      )
    }

    if (existing) {
      const update: Record<string, unknown> = {
        phone_number_id: phoneNumberId,
        waba_id: wabaId || null,
        status: 'connected',
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      if (encryptedAccessToken !== undefined) {
        update.access_token = encryptedAccessToken
      }
      if (encryptedVerifyToken !== undefined) {
        update.verify_token = encryptedVerifyToken
      }

      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update(update)
        .eq('user_id', user.id)

      if (updateError) {
        console.error('Error updating whatsapp_config:', updateError)
        return NextResponse.json(
          { error: 'Failed to update configuration' },
          { status: 500 }
        )
      }
    } else {
      const { error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({
          user_id: user.id,
          phone_number_id: phoneNumberId,
          waba_id: wabaId || null,
          access_token: encryptedAccessToken,
          verify_token: encryptedVerifyToken ?? null,
          status: 'connected',
          connected_at: new Date().toISOString(),
        })

      if (insertError) {
        console.error('Error inserting whatsapp_config:', insertError)
        return NextResponse.json(
          { error: 'Failed to save configuration' },
          { status: 500 }
        )
      }
    }

    return NextResponse.json({ success: true, phone_info: phoneInfo })
  } catch (error) {
    console.error('Error in WhatsApp config POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/whatsapp/config
 *
 * Removes the authenticated user's WhatsApp configuration row.
 * Used by the "Reset Configuration" button to recover from a corrupted
 * encrypted token (mismatched ENCRYPTION_KEY across environments).
 */
export async function DELETE() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { error: deleteError } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('user_id', user.id)

    if (deleteError) {
      console.error('Error deleting whatsapp_config:', deleteError)
      return NextResponse.json(
        { error: 'Failed to delete configuration' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in WhatsApp config DELETE:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
