import { NextResponse } from 'next/server';
import type { User } from '@supabase/supabase-js';

import {
  normalizeManagedRole,
  requireAdminUser,
  type AdminProfile,
  type ManagedUserRole,
} from '@/lib/admin/users';

export const dynamic = 'force-dynamic';

interface ManagedUser {
  id: string;
  profile_id: string | null;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  role: ManagedUserRole;
  created_at: string | null;
  updated_at: string | null;
  last_sign_in_at: string | null;
  email_confirmed_at: string | null;
  is_current_user: boolean;
}

function metadataName(user: User | undefined): string | null {
  const metadata = user?.user_metadata as Record<string, unknown> | undefined;
  const name = metadata?.full_name ?? metadata?.name;
  return typeof name === 'string' && name.trim() ? name : null;
}

function toManagedUser(
  profile: AdminProfile | null,
  authUser: User | undefined,
  currentUserId: string,
): ManagedUser {
  const id = profile?.user_id ?? authUser?.id ?? '';

  return {
    id,
    profile_id: profile?.id ?? null,
    full_name: profile?.full_name || metadataName(authUser),
    email: profile?.email || authUser?.email || null,
    avatar_url: profile?.avatar_url ?? null,
    role: normalizeManagedRole(profile?.role),
    created_at: profile?.created_at ?? authUser?.created_at ?? null,
    updated_at: profile?.updated_at ?? null,
    last_sign_in_at: authUser?.last_sign_in_at ?? null,
    email_confirmed_at: authUser?.email_confirmed_at ?? null,
    is_current_user: id === currentUserId,
  };
}

function dateValue(value: string | null) {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

export async function GET() {
  const auth = await requireAdminUser();
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status },
    );
  }

  const { admin } = auth;

  const { data: profileRows, error: profileError } = await admin
    .from('profiles')
    .select('id, user_id, full_name, email, avatar_url, role, created_at, updated_at')
    .order('created_at', { ascending: false });

  if (profileError) {
    console.error('[admin/users] Failed to list profiles:', profileError);
    return NextResponse.json(
      { error: 'Failed to list users' },
      { status: 500 },
    );
  }

  const { data: authUsersData, error: authUsersError } =
    await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });

  if (authUsersError) {
    console.error('[admin/users] Failed to list auth users:', authUsersError);
    return NextResponse.json(
      { error: 'Failed to list auth users' },
      { status: 500 },
    );
  }

  const profiles = (profileRows ?? []) as AdminProfile[];
  const authUsers = authUsersData.users ?? [];
  const authById = new Map(authUsers.map((user) => [user.id, user]));
  const profileByUserId = new Map(
    profiles.map((profile) => [profile.user_id, profile]),
  );

  const users = profiles.map((profile) =>
    toManagedUser(profile, authById.get(profile.user_id), auth.user.id),
  );

  for (const authUser of authUsers) {
    if (!profileByUserId.has(authUser.id)) {
      users.push(toManagedUser(null, authUser, auth.user.id));
    }
  }

  users.sort(
    (a, b) => dateValue(b.created_at) - dateValue(a.created_at),
  );

  return NextResponse.json({
    users,
    admin_count: users.filter((user) => user.role === 'admin').length,
    current_user_id: auth.user.id,
  });
}
