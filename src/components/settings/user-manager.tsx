'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, RefreshCw, ShieldCheck, Trash2, Users } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type ManagedUserRole = 'user' | 'admin';

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

interface UsersResponse {
  users: ManagedUser[];
  admin_count: number;
  current_user_id: string;
}

function displayName(user: ManagedUser) {
  return user.full_name?.trim() || user.email || 'Unnamed user';
}

function initials(user: ManagedUser) {
  return displayName(user).charAt(0).toUpperCase();
}

function formatDate(value: string | null, emptyLabel = 'Never') {
  if (!value) return emptyLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return emptyLabel;
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

async function readError(response: Response) {
  const data = await response.json().catch(() => null);
  if (
    data &&
    typeof data === 'object' &&
    'error' in data &&
    typeof data.error === 'string'
  ) {
    return data.error;
  }
  return 'Request failed';
}

export function UserManager() {
  const { user, profile, profileLoading, refreshProfile } = useAuth();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [roleSavingId, setRoleSavingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ManagedUser | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const adminCount = useMemo(
    () => users.filter((managedUser) => managedUser.role === 'admin').length,
    [users],
  );

  const loadUsers = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    setForbidden(false);

    try {
      const response = await fetch('/api/admin/users', { cache: 'no-store' });

      if (response.status === 403) {
        setForbidden(true);
        setUsers([]);
        return;
      }

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const data = (await response.json()) as UsersResponse;
      setUsers(Array.isArray(data.users) ? data.users : []);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load users';
      toast.error(message);
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (profileLoading) return;

    if (profile?.role !== 'admin') {
      setForbidden(true);
      setLoading(false);
      return;
    }

    void loadUsers();
  }, [loadUsers, profile?.role, profileLoading]);

  const updateRole = async (managedUser: ManagedUser, role: ManagedUserRole) => {
    if (managedUser.role === role) return;

    setRoleSavingId(managedUser.id);
    try {
      const response = await fetch(`/api/admin/users/${managedUser.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      setUsers((current) =>
        current.map((item) =>
          item.id === managedUser.id ? { ...item, role } : item,
        ),
      );

      if (managedUser.id === user?.id) {
        await refreshProfile();
      }

      toast.success('Role updated');
      void loadUsers(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update role';
      toast.error(message);
    } finally {
      setRoleSavingId(null);
    }
  };

  const deleteUser = async () => {
    if (!deleteTarget) return;

    setDeletingId(deleteTarget.id);
    try {
      const response = await fetch(`/api/admin/users/${deleteTarget.id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      setUsers((current) =>
        current.filter((managedUser) => managedUser.id !== deleteTarget.id),
      );
      setDeleteTarget(null);
      toast.success('User deleted');
      void loadUsers(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete user';
      toast.error(message);
    } finally {
      setDeletingId(null);
    }
  };

  if (profileLoading || loading) {
    return (
      <Card className="border-slate-800 bg-slate-900/40">
        <CardContent className="flex min-h-40 items-center justify-center text-slate-400">
          <Loader2 className="mr-2 size-4 animate-spin" />
          Loading users...
        </CardContent>
      </Card>
    );
  }

  if (forbidden || profile?.role !== 'admin') {
    return (
      <Card className="border-slate-800 bg-slate-900/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-white">
            <Users className="size-4 text-primary" />
            Users
          </CardTitle>
          <CardDescription className="text-slate-400">
            Admin access is required to manage application users.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <>
      <Card className="border-slate-800 bg-slate-900/40">
        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-white">
              <Users className="size-4 text-primary" />
              Users
            </CardTitle>
            <CardDescription className="mt-2 text-slate-400">
              Manage account access and admin roles. CRM data remains scoped to
              each account.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadUsers()}
            disabled={loading}
          >
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {users.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-700 p-8 text-center text-sm text-slate-400">
              No users found.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-slate-800 hover:bg-transparent">
                  <TableHead className="text-slate-300">User</TableHead>
                  <TableHead className="text-slate-300">Role</TableHead>
                  <TableHead className="text-slate-300">Joined</TableHead>
                  <TableHead className="text-slate-300">Last sign in</TableHead>
                  <TableHead className="text-right text-slate-300">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((managedUser) => {
                  const onlyAdmin =
                    managedUser.role === 'admin' && adminCount <= 1;
                  const deleteDisabled =
                    managedUser.is_current_user || onlyAdmin || !!deletingId;

                  return (
                    <TableRow
                      key={managedUser.id}
                      className="border-slate-800 hover:bg-slate-800/50"
                    >
                      <TableCell>
                        <div className="flex min-w-64 items-center gap-3">
                          <Avatar className="size-9">
                            <AvatarImage
                              src={managedUser.avatar_url ?? undefined}
                              alt={displayName(managedUser)}
                            />
                            <AvatarFallback className="bg-slate-800 text-slate-200">
                              {initials(managedUser)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="truncate font-medium text-white">
                                {displayName(managedUser)}
                              </p>
                              {managedUser.is_current_user ? (
                                <Badge
                                  variant="outline"
                                  className="border-slate-700 text-slate-300"
                                >
                                  You
                                </Badge>
                              ) : null}
                            </div>
                            <p className="truncate text-xs text-slate-500">
                              {managedUser.email ?? 'No email'}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {managedUser.role === 'admin' ? (
                            <ShieldCheck className="size-4 text-primary" />
                          ) : null}
                          <Select
                            value={managedUser.role}
                            onValueChange={(value) =>
                              void updateRole(
                                managedUser,
                                value as ManagedUserRole,
                              )
                            }
                            disabled={roleSavingId === managedUser.id || onlyAdmin}
                          >
                            <SelectTrigger className="w-28 border-slate-700 bg-slate-800 text-white">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="border-slate-700 bg-slate-800">
                              <SelectItem value="user">User</SelectItem>
                              <SelectItem value="admin">Admin</SelectItem>
                            </SelectContent>
                          </Select>
                          {roleSavingId === managedUser.id ? (
                            <Loader2 className="size-4 animate-spin text-slate-400" />
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-slate-400">
                        {formatDate(managedUser.created_at, '-')}
                      </TableCell>
                      <TableCell className="text-slate-400">
                        {formatDate(managedUser.last_sign_in_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="destructive"
                          size="icon-sm"
                          onClick={() => setDeleteTarget(managedUser)}
                          disabled={deleteDisabled}
                          aria-label={`Delete ${displayName(managedUser)}`}
                        >
                          {deletingId === managedUser.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Trash2 className="size-4" />
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete user?</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? `This removes ${displayName(
                    deleteTarget,
                  )}'s login and account-owned CRM records.`
                : 'This removes this user login and account-owned CRM records.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={!!deletingId}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void deleteUser()}
              disabled={!!deletingId}
            >
              {deletingId ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete user'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
