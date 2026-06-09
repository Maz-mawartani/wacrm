import type { SupabaseClient, User } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const MANAGED_USER_ROLES = ['user', 'admin'] as const;
export type ManagedUserRole = (typeof MANAGED_USER_ROLES)[number];

export interface AdminProfile {
  id: string;
  user_id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  role: string | null;
  created_at: string | null;
  updated_at?: string | null;
}

export type RequireAdminUserResult =
  | {
      ok: true;
      user: User;
      profile: AdminProfile;
      admin: SupabaseClient;
    }
  | {
      ok: false;
      status: 401 | 403 | 500;
      error: string;
    };

export function isManagedUserRole(role: unknown): role is ManagedUserRole {
  return role === 'user' || role === 'admin';
}

export function normalizeManagedRole(
  role: string | null | undefined,
): ManagedUserRole {
  return role === 'admin' ? 'admin' : 'user';
}

export async function requireAdminUser(): Promise<RequireAdminUserResult> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  const admin = supabaseAdmin();
  const { data, error: profileError } = await admin
    .from('profiles')
    .select('id, user_id, full_name, email, avatar_url, role, created_at, updated_at')
    .eq('user_id', user.id)
    .maybeSingle();

  if (profileError) {
    console.error('[admin/users] Failed to load admin profile:', profileError);
    return { ok: false, status: 500, error: 'Failed to load profile' };
  }

  const profile = data as AdminProfile | null;
  if (!profile || normalizeManagedRole(profile.role) !== 'admin') {
    return { ok: false, status: 403, error: 'Admin access required' };
  }

  return { ok: true, user, profile, admin };
}

export async function countAdminProfiles(admin: SupabaseClient) {
  const { count, error } = await admin
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'admin');

  return { count: count ?? 0, error };
}
