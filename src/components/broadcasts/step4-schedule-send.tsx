'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  AlertCircle,
  ArrowLeft,
  Send,
  Loader2,
  Users,
  Save,
} from 'lucide-react';

interface AudienceConfig {
  type: 'all' | 'contacts' | 'tags' | 'custom_field' | 'csv';
  contactIds?: string[];
  tagIds?: string[];
  customField?: {
    fieldId: string;
    operator: 'is' | 'is_not' | 'contains';
    value: string;
  };
  csvContacts?: { phone: string; name?: string }[];
  excludeTagIds?: string[];
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  onSend: () => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();

        let baseIds: Set<string> | null = null;

        if (audience.type === 'all') {
          // Handled below so tag exclusions can be subtracted.
        } else if (
          audience.type === 'contacts' &&
          audience.contactIds &&
          audience.contactIds.length > 0
        ) {
          baseIds = new Set(audience.contactIds);
        } else if (
          audience.type === 'tags' &&
          audience.tagIds &&
          audience.tagIds.length > 0
        ) {
          const { data: contactTags } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.tagIds);

          baseIds = new Set((contactTags ?? []).map((ct) => ct.contact_id));
        } else if (
          audience.type === 'custom_field' &&
          audience.customField?.fieldId &&
          audience.customField.value
        ) {
          const { fieldId, operator, value } = audience.customField;
          let query = supabase
            .from('contact_custom_values')
            .select('contact_id')
            .eq('custom_field_id', fieldId);

          if (operator === 'is') query = query.eq('value', value);
          else if (operator === 'is_not') query = query.neq('value', value);
          else query = query.ilike('value', `%${value}%`);

          const { data } = await query;
          baseIds = new Set((data ?? []).map((row) => row.contact_id));
        } else if (audience.type === 'csv' && audience.csvContacts) {
          setEstimatedReach(audience.csvContacts.length);
          return;
        } else {
          setEstimatedReach(0);
          return;
        }

        let excludeSet: Set<string> | null = null;
        if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
          const { data: excludeRows } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.excludeTagIds);
          excludeSet = new Set((excludeRows ?? []).map((r) => r.contact_id));
        }

        if (baseIds) {
          setEstimatedReach(
            [...baseIds].filter((id) => !excludeSet?.has(id)).length
          );
        } else {
          const { count } = await supabase
            .from('contacts')
            .select('*', { count: 'exact', head: true });
          const total = count ?? 0;
          setEstimatedReach(
            excludeSet ? Math.max(0, total - excludeSet.size) : total
          );
        }
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  const audienceLabel =
    audience.type === 'all'
      ? 'All Contacts'
      : audience.type === 'contacts'
        ? `Selected Contacts (${audience.contactIds?.length ?? 0})`
        : audience.type === 'tags'
          ? `Tags (${audience.tagIds?.length ?? 0} selected)`
          : audience.type === 'csv'
            ? 'CSV Upload'
            : 'Custom Field';
  const isMarketingTemplate = template.category === 'Marketing';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">Review & Send</h2>
        <p className="mt-1 text-sm text-slate-400">
          Name your broadcast, review the details, and send.
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-white">
          Broadcast Name
        </label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="e.g. Summer Sale Announcement"
          className="border-slate-700 bg-slate-800 text-white placeholder:text-slate-500"
        />
      </div>

      {/* Summary Card */}
      <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
        <p className="text-sm font-medium text-white">Summary</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-slate-400">Template</p>
            <p className="text-white">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-slate-400">Audience</p>
            <p className="text-white">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-slate-400">Estimated Reach</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="text-primary h-3 w-3 animate-spin" />
              ) : (
                <>
                  <Users className="text-primary h-3.5 w-3.5" />
                  <p className="font-medium text-white">
                    {estimatedReach.toLocaleString()}
                  </p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-slate-400">Language</p>
            <p className="text-white">{template.language ?? 'en_US'}</p>
          </div>
        </div>
      </div>

      {isMarketingTemplate && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <div className="flex gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-amber-200">
                Marketing delivery can be limited by WhatsApp
              </p>
              <p className="text-xs leading-5 text-amber-100/80">
                Error #131049 means Meta chose not to deliver to those
                recipients to protect engagement. Reduce broad cold sends,
                target contacts who opted in or replied recently, and avoid
                retrying the same failed numbers immediately.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Processing overlay */}
      {isProcessing && (
        <div className="border-primary/20 bg-primary/5 rounded-xl border p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="text-primary h-4 w-4 animate-spin" />
              <p className="text-sm font-medium text-white">
                Sending broadcast...
              </p>
            </div>
            <span className="text-primary text-xs font-medium">
              {progress}%
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-slate-800">
            <div
              className="bg-primary h-1.5 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-slate-700 text-slate-300"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              Save as Draft
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
            <DialogTrigger
              render={
                <Button
                  disabled={!name.trim() || isProcessing}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                />
              }
            >
              <Send className="h-4 w-4" />
              Send Broadcast
            </DialogTrigger>
            <DialogContent className="border-slate-700 bg-slate-900 sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-white">
                  Confirm Broadcast
                </DialogTitle>
                <DialogDescription className="text-slate-400">
                  You are about to send this broadcast to{' '}
                  <span className="font-medium text-white">
                    {estimatedReach.toLocaleString()}
                  </span>{' '}
                  contacts using the{' '}
                  <span className="font-medium text-white">
                    {template.name}
                  </span>{' '}
                  template. This action cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setShowConfirm(false)}
                  className="border-slate-700 text-slate-300"
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    setShowConfirm(false);
                    onSend();
                  }}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <Send className="h-4 w-4" />
                  Confirm & Send
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
