import { NextResponse } from 'next/server';
import type { SupabaseClient, User } from '@supabase/supabase-js';

import {
  countAdminProfiles,
  isManagedUserRole,
  normalizeManagedRole,
  requireAdminUser,
  type AdminProfile,
} from '@/lib/admin/users';

type RouteContext = {
  params: Promise<{ userId: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function metadataName(user: User): string {
  const metadata = user.user_metadata as Record<string, unknown> | undefined;
  const name = metadata?.full_name ?? metadata?.name;
  return typeof name === 'string' ? name : '';
}

async function loadProfile(admin: SupabaseClient, userId: string) {
  const { data, error } = await admin
    .from('profiles')
    .select('id, user_id, full_name, email, avatar_url, role, created_at, updated_at')
    .eq('user_id', userId)
    .maybeSingle();

  return { profile: data as AdminProfile | null, error };
}

async function assertCanRemoveAdminRole(
  admin: SupabaseClient,
  targetProfile: AdminProfile | null,
) {
  if (normalizeManagedRole(targetProfile?.role) !== 'admin') return null;

  const { count, error } = await countAdminProfiles(admin);
  if (error) {
    console.error('[admin/users] Failed to count admins:', error);
    return NextResponse.json(
      { error: 'Failed to verify admin count' },
      { status: 500 },
    );
  }

  if (count <= 1) {
    return NextResponse.json(
      { error: 'Cannot remove the last admin account' },
      { status: 400 },
    );
  }

  return null;
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const auth = await requireAdminUser();
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status },
    );
  }

  const { userId } = await params;
  if (!userId) {
    return NextResponse.json({ error: 'Missing user id' }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  if (!isRecord(body) || !isManagedUserRole(body.role)) {
    return NextResponse.json(
      { error: 'role must be "user" or "admin"' },
      { status: 400 },
    );
  }

  const { admin } = auth;
  const { data: targetData, error: targetError } =
    await admin.auth.admin.getUserById(userId);

  if (targetError || !targetData.user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const { profile, error: profileError } = await loadProfile(admin, userId);
  if (profileError) {
    console.error('[admin/users] Failed to load target profile:', profileError);
    return NextResponse.json(
      { error: 'Failed to load target profile' },
      { status: 500 },
    );
  }

  if (body.role === 'user') {
    const blocked = await assertCanRemoveAdminRole(admin, profile);
    if (blocked) return blocked;
  }

  if (profile) {
    const { error } = await admin
      .from('profiles')
      .update({ role: body.role })
      .eq('user_id', userId);

    if (error) {
      console.error('[admin/users] Failed to update role:', error);
      return NextResponse.json(
        { error: 'Failed to update role' },
        { status: 500 },
      );
    }
  } else {
    const targetUser = targetData.user;
    const { error } = await admin.from('profiles').insert({
      user_id: userId,
      full_name: metadataName(targetUser),
      email: targetUser.email ?? '',
      role: body.role,
    });

    if (error) {
      console.error('[admin/users] Failed to create profile:', error);
      return NextResponse.json(
        { error: 'Failed to create user profile' },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ ok: true, user_id: userId, role: body.role });
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const auth = await requireAdminUser();
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status },
    );
  }

  const { userId } = await params;
  if (!userId) {
    return NextResponse.json({ error: 'Missing user id' }, { status: 400 });
  }

  if (userId === auth.user.id) {
    return NextResponse.json(
      { error: 'You cannot delete your own account from user management' },
      { status: 400 },
    );
  }

  const { admin } = auth;
  const { profile, error: profileError } = await loadProfile(admin, userId);
  if (profileError) {
    console.error('[admin/users] Failed to load target profile:', profileError);
    return NextResponse.json(
      { error: 'Failed to load target profile' },
      { status: 500 },
    );
  }

  const blocked = await assertCanRemoveAdminRole(admin, profile);
  if (blocked) return blocked;

  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    console.error('[admin/users] Failed to delete auth user:', error);
    return NextResponse.json(
      { error: 'Failed to delete user' },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
