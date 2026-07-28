'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  Sparkles,
  CheckCircle2,
  Trash2,
  Eye,
  EyeOff,
  Zap,
  Info,
} from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsPanelHead } from './settings-panel-head';
import { AiKnowledgeCard } from './ai-knowledge';
import { AI_PROVIDER_DEFAULT_MODEL } from '@/lib/ai/defaults';
import type { AiActionSetting, AiActionsConfig, AiProvider } from '@/lib/ai/types';

const DISABLED_ACTIONS: AiActionsConfig = {
  updateTags: { enabled: false, guidelines: null },
  updateContactFields: { enabled: false, guidelines: null },
  triggerAutomations: { enabled: false, guidelines: null },
};

function normalizeActionSetting(raw: unknown): AiActionSetting {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    enabled: obj.enabled === true,
    guidelines: typeof obj.guidelines === 'string' ? obj.guidelines : null,
  };
}

function normalizeActionsFromResponse(raw: unknown): AiActionsConfig {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    updateTags: normalizeActionSetting(obj.updateTags),
    updateContactFields: normalizeActionSetting(obj.updateContactFields),
    triggerAutomations: normalizeActionSetting(obj.triggerAutomations),
  };
}

const MASKED_KEY = '••••••••••••••••';

const PROVIDER_LABEL: Record<AiProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
};

const KEY_PLACEHOLDER: Record<AiProvider, string> = {
  openai: 'sk-...',
  anthropic: 'sk-ant-...',
};

interface AiConfigProps {
  /** null when creating a brand-new agent. */
  agentId: string | null;
  /** Whether this agent is the account's default — auto-reply, the
   *  webhook's new-conversation routing, and inbox draft only ever use
   *  the default agent's settings, so a non-default agent's Behaviour/
   *  Actions/Knowledge base sections are inert until promoted. */
  isDefault: boolean;
  /** Called after a successful create or update, with the agent's id
   *  (a fresh one for a create) so the parent can switch to editing it
   *  and refresh the agents list. */
  onSaved: (agentId: string) => void;
  /** Called after a successful delete. */
  onDeleted: () => void;
}

export function AiConfig({ agentId, isDefault, onSaved, onDeleted }: AiConfigProps) {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [loading, setLoading] = useState(!!agentId);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [configured, setConfigured] = useState(false);
  const [name, setName] = useState('New Agent');
  const [provider, setProvider] = useState<AiProvider>('openai');
  const [model, setModel] = useState(AI_PROVIDER_DEFAULT_MODEL.openai);
  const [apiKey, setApiKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [embeddingsKey, setEmbeddingsKey] = useState('');
  const [embeddingsKeyEdited, setEmbeddingsKeyEdited] = useState(false);
  const [hasStoredEmbeddingsKey, setHasStoredEmbeddingsKey] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  // null = unlimited (no per-conversation cap).
  const [maxPerConversation, setMaxPerConversation] = useState<number | null>(3);
  const [defaultNewConversationOwner, setDefaultNewConversationOwner] =
    useState<'ai' | 'human'>('human');
  const [actions, setActions] = useState<AiActionsConfig>(DISABLED_ACTIONS);
  const [rescueReplyEnabled, setRescueReplyEnabled] = useState(false);
  const [rescueAfterHours, setRescueAfterHours] = useState(20);
  const [rescueMaxPerConversation, setRescueMaxPerConversation] = useState(2);

  const fetchConfig = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ai/agents/${id}`);
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to load agent');
        return;
      }
      setConfigured(true);
      setName(data.name ?? 'New Agent');
      setProvider(data.provider);
      setModel(data.model);
      setSystemPrompt(data.system_prompt ?? '');
      setIsActive(data.is_active);
      setAutoReplyEnabled(data.auto_reply_enabled);
      // A stored NULL is the deliberate "unlimited" state — keep it as
      // null rather than defaulting it back to a number.
      setMaxPerConversation(
        typeof data.auto_reply_max_per_conversation === 'number'
          ? data.auto_reply_max_per_conversation
          : null,
      );
      setDefaultNewConversationOwner(
        data.default_new_conversation_owner === 'ai' ? 'ai' : 'human',
      );
      setActions(normalizeActionsFromResponse(data.actions));
      setRescueReplyEnabled(Boolean(data.rescue_reply_enabled));
      setRescueAfterHours(
        typeof data.rescue_after_hours === 'number' ? data.rescue_after_hours : 20,
      );
      setRescueMaxPerConversation(
        typeof data.rescue_max_per_conversation === 'number'
          ? data.rescue_max_per_conversation
          : 2,
      );
      setHasStoredKey(Boolean(data.has_key));
      setApiKey(data.has_key ? MASKED_KEY : '');
      setKeyEdited(false);
      setHasStoredEmbeddingsKey(Boolean(data.has_embeddings_key));
      setEmbeddingsKey(data.has_embeddings_key ? MASKED_KEY : '');
      setEmbeddingsKeyEdited(false);
    } catch {
      toast.error('Failed to load agent');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (agentId) {
      void fetchConfig(agentId);
    } else {
      // Creating a new agent — reset to defaults rather than showing
      // whatever the previously-selected agent left behind.
      setConfigured(false);
      setName('New Agent');
      setProvider('openai');
      setModel(AI_PROVIDER_DEFAULT_MODEL.openai);
      setApiKey('');
      setKeyEdited(false);
      setHasStoredKey(false);
      setEmbeddingsKey('');
      setEmbeddingsKeyEdited(false);
      setHasStoredEmbeddingsKey(false);
      setSystemPrompt('');
      setIsActive(false);
      setAutoReplyEnabled(false);
      setMaxPerConversation(3);
      setDefaultNewConversationOwner('human');
      setActions(DISABLED_ACTIONS);
      setRescueReplyEnabled(false);
      setRescueAfterHours(20);
      setRescueMaxPerConversation(2);
      setLoading(false);
    }
  }, [agentId, fetchConfig]);

  // Swap the model default when the provider changes, unless the user
  // typed a custom model.
  const handleProviderChange = (next: AiProvider) => {
    setProvider(next);
    const isDefaultModel =
      model === AI_PROVIDER_DEFAULT_MODEL.openai ||
      model === AI_PROVIDER_DEFAULT_MODEL.anthropic ||
      model.trim() === '';
    if (isDefaultModel) setModel(AI_PROVIDER_DEFAULT_MODEL[next]);
  };

  const keyPayload = () => (keyEdited ? apiKey.trim() : undefined);

  // undefined = leave unchanged; '' typed = null (clear); text = set.
  const embeddingsKeyPayload = () =>
    embeddingsKeyEdited ? embeddingsKey.trim() || null : undefined;

  const buildBody = () => ({
    name: name.trim(),
    provider,
    model: model.trim(),
    api_key: keyPayload(),
    embeddings_api_key: embeddingsKeyPayload(),
    system_prompt: systemPrompt.trim() || null,
    is_active: isActive,
    auto_reply_enabled: autoReplyEnabled,
    auto_reply_max_per_conversation: maxPerConversation,
    default_new_conversation_owner: defaultNewConversationOwner,
    actions,
    rescue_reply_enabled: rescueReplyEnabled,
    rescue_after_hours: rescueAfterHours,
    rescue_max_per_conversation: rescueMaxPerConversation,
  });

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model: model.trim(),
          api_key: keyPayload(),
        }),
      });
      const data = await res.json();
      if (res.ok) toast.success('Key works — the provider responded.');
      else toast.error(data.error ?? 'The provider rejected the request.');
    } catch {
      toast.error('Could not reach the provider.');
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error('Give this agent a name.');
      return;
    }
    if (!model.trim()) {
      toast.error('Enter a model name.');
      return;
    }
    if (!configured && !keyEdited) {
      toast.error('Enter your API key.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(
        agentId ? `/api/ai/agents/${agentId}` : '/api/ai/agents',
        {
          method: agentId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildBody()),
        },
      );
      const data = await res.json();
      if (res.ok) {
        toast.success(agentId ? 'Agent saved.' : 'Agent created.');
        onSaved(agentId ?? data.id);
      } else {
        toast.error(data.error ?? 'Failed to save.');
      }
    } catch {
      toast.error('Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!agentId) return;
    setRemoving(true);
    try {
      const res = await fetch(`/api/ai/agents/${agentId}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success('Agent removed.');
        onDeleted();
      } else {
        const data = await res.json();
        toast.error(data.error ?? 'Failed to remove.');
      }
    } catch {
      toast.error('Failed to remove.');
    } finally {
      setRemoving(false);
    }
  };

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  const disabled = !canEdit || saving;

  return (
    <div>
      <SettingsPanelHead
        title={agentId ? 'Agent setup' : 'Create agent'}
        description="Bring your own OpenAI or Anthropic key. wacrm calls the provider directly with your key — no per-seat AI fees, and your data stays yours."
      />

      {!canEdit && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Only admins and owners can change agent configuration.
        </p>
      )}

      {configured && !isDefault && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            This isn&apos;t your default agent. Auto-reply, new-conversation
            routing, and the knowledge base only use the default agent — set
            this one as default from the agents list to make its Behaviour,
            Actions, and Knowledge base settings take effect.
          </p>
        </div>
      )}

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" /> Provider & key
            </CardTitle>
            <CardDescription>
              Your key is encrypted at rest (AES-256-GCM) and never shown again
              after saving.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ai-name">Agent name</Label>
              <Input
                id="ai-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Support Bot"
                disabled={disabled}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Provider</Label>
                <Select
                  value={provider}
                  onValueChange={(v) => handleProviderChange(v as AiProvider)}
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue>
                      {(v: AiProvider) => PROVIDER_LABEL[v] ?? v}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">{PROVIDER_LABEL.openai}</SelectItem>
                    <SelectItem value="anthropic">
                      {PROVIDER_LABEL.anthropic}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="ai-model">Model</Label>
                <Input
                  id="ai-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={AI_PROVIDER_DEFAULT_MODEL[provider]}
                  disabled={disabled}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-key">API key</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="ai-key"
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setKeyEdited(true);
                    }}
                    onFocus={() => {
                      if (!keyEdited && hasStoredKey) {
                        setApiKey('');
                        setKeyEdited(true);
                      }
                    }}
                    placeholder={KEY_PLACEHOLDER[provider]}
                    disabled={disabled}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showKey ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <Button
                  variant="outline"
                  onClick={handleTest}
                  disabled={disabled || testing}
                >
                  {testing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                  )}
                  Test key
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-embeddings-key">
                Embeddings key{' '}
                <span className="font-normal text-muted-foreground">
                  (optional — enables semantic knowledge-base search)
                </span>
              </Label>
              <Input
                id="ai-embeddings-key"
                type="password"
                value={embeddingsKey}
                onChange={(e) => {
                  setEmbeddingsKey(e.target.value);
                  setEmbeddingsKeyEdited(true);
                }}
                onFocus={() => {
                  if (!embeddingsKeyEdited && hasStoredEmbeddingsKey) {
                    setEmbeddingsKey('');
                    setEmbeddingsKeyEdited(true);
                  }
                }}
                placeholder="sk-... (OpenAI)"
                disabled={disabled}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                An OpenAI key used only to embed your knowledge base
                (text-embedding-3-small)
                {provider === 'openai' ? ' — can be the same key as above' : ''}.
                Leave blank to use keyword search instead. Clear it to turn
                semantic search off.{' '}
                {!isDefault && 'Only takes effect if this agent is the default.'}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Behaviour</CardTitle>
            <CardDescription>
              Tell the assistant about your business — products, tone, what it
              may and may not promise. This context feeds both drafts and
              auto-replies.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ai-prompt">Business context & instructions</Label>
              <Textarea
                id="ai-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="e.g. We are Acme, a coffee-equipment store. Be warm and concise. Never quote prices or delivery dates — hand off to a human for those."
                rows={5}
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Enable AI assistant
                </p>
                <p className="text-xs text-muted-foreground">
                  Master switch. Turns on the “Draft with AI” button in the
                  inbox.
                </p>
              </div>
              <Switch
                checked={isActive}
                onCheckedChange={setIsActive}
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Auto-reply to inbound messages
                </p>
                <p className="text-xs text-muted-foreground">
                  The bot answers new inbound messages automatically (only when
                  no flow handles them and no agent is assigned). Hands off to a
                  human when it can’t help.
                </p>
              </div>
              <Switch
                checked={autoReplyEnabled}
                onCheckedChange={setAutoReplyEnabled}
                disabled={disabled || !isActive}
              />
            </div>

            {autoReplyEnabled && (
              <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    New conversations go to
                  </p>
                  <p className="text-xs text-muted-foreground">
                    When a new contact messages in (or a closed conversation
                    reopens), route it here by default. An agent can always
                    take over from the inbox afterwards.
                  </p>
                </div>
                <Select
                  value={defaultNewConversationOwner}
                  onValueChange={(v) =>
                    setDefaultNewConversationOwner(v as 'ai' | 'human')
                  }
                  disabled={disabled}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue>
                      {(v: 'ai' | 'human') => (v === 'ai' ? 'AI agent' : 'Agent')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="human">Agent</SelectItem>
                    <SelectItem value="ai">AI agent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="ai-max">Max auto-replies per conversation</Label>
                <p className="text-xs text-muted-foreground">
                  {maxPerConversation === null
                    ? 'Unlimited — the bot keeps replying for as long as the conversation needs.'
                    : 'After this many bot replies in one thread, the bot goes quiet.'}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Input
                  id="ai-max"
                  type="number"
                  min={1}
                  value={maxPerConversation ?? ''}
                  placeholder="Unlimited"
                  onChange={(e) =>
                    setMaxPerConversation(Math.max(1, Number(e.target.value) || 1))
                  }
                  disabled={disabled || !autoReplyEnabled || maxPerConversation === null}
                  className="w-20"
                />
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch
                    checked={maxPerConversation === null}
                    onCheckedChange={(checked) =>
                      setMaxPerConversation(checked ? null : 3)
                    }
                    disabled={disabled || !autoReplyEnabled}
                  />
                  Unlimited
                </label>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="h-4 w-4 text-primary" /> 24-hour rescue reply
            </CardTitle>
            <CardDescription>
              WhatsApp blocks free replies once 24h pass since the customer&apos;s last
              message. If a conversation is still waiting on your agent when it&apos;s
              about to hit that wall, the agent can send ONE short, natural check-in
              to keep it open — it never takes the conversation over, and stops the
              moment your agent (or the customer) replies.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Enable 24-hour rescue reply
                </p>
                <p className="text-xs text-muted-foreground">
                  Only fires when the customer&apos;s message is still unanswered — a
                  customer who has gone quiet on their own is left alone.
                </p>
              </div>
              <Switch
                checked={rescueReplyEnabled}
                onCheckedChange={setRescueReplyEnabled}
                disabled={disabled || !isActive}
              />
            </div>

            {rescueReplyEnabled && (
              <>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Label htmlFor="ai-rescue-hours">Send after (hours unanswered)</Label>
                    <p className="text-xs text-muted-foreground">
                      Must stay under 24 so the reply can still send.
                    </p>
                  </div>
                  <Input
                    id="ai-rescue-hours"
                    type="number"
                    min={1}
                    max={23}
                    value={rescueAfterHours}
                    onChange={(e) =>
                      setRescueAfterHours(
                        Math.min(23, Math.max(1, Number(e.target.value) || 20)),
                      )
                    }
                    disabled={disabled}
                    className="w-20"
                  />
                </div>

                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Label htmlFor="ai-rescue-max">Max rescue replies per conversation</Label>
                    <p className="text-xs text-muted-foreground">
                      Resets whenever your agent actually replies.
                    </p>
                  </div>
                  <Input
                    id="ai-rescue-max"
                    type="number"
                    min={1}
                    value={rescueMaxPerConversation}
                    onChange={(e) =>
                      setRescueMaxPerConversation(Math.max(1, Number(e.target.value) || 2))
                    }
                    disabled={disabled}
                    className="w-20"
                  />
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="h-4 w-4 text-primary" /> Actions
            </CardTitle>
            <CardDescription>
              Let the agent do more than reply with text. Each action is off by
              default — turn one on and describe when to use it in plain
              language; the agent only ever acts on tags/fields/automations
              that already exist.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ActionSettingRow
              title="Update tags"
              description="Add or remove existing tags on the contact based on the conversation."
              setting={actions.updateTags}
              onChange={(next) => setActions((a) => ({ ...a, updateTags: next }))}
              guidelinesPlaceholder="e.g. Tag as Hot Lead when they ask about pricing or say they want to buy."
              disabled={disabled}
            />
            <ActionSettingRow
              title="Update contact fields"
              description="Fill in custom fields the agent picks up from the chat (email, city, order number, etc.)."
              setting={actions.updateContactFields}
              onChange={(next) =>
                setActions((a) => ({ ...a, updateContactFields: next }))
              }
              guidelinesPlaceholder="e.g. Save their city into the City field when they mention it."
              disabled={disabled}
            />
            <ActionSettingRow
              title="Trigger automations"
              description="Let the agent trigger one of your existing Automations mid-conversation."
              setting={actions.triggerAutomations}
              onChange={(next) =>
                setActions((a) => ({ ...a, triggerAutomations: next }))
              }
              guidelinesPlaceholder='e.g. If the customer asks for the FBR certificate, trigger the "FBR Certificate Flow" automation.'
              disabled={disabled}
            />
          </CardContent>
        </Card>

        <AiKnowledgeCard
          accountId={accountId}
          canEdit={canEdit}
          hasEmbeddingsKey={
            embeddingsKeyEdited
              ? embeddingsKey.trim().length > 0
              : hasStoredEmbeddingsKey
          }
        />

        <div className="flex items-center justify-between">
          {agentId ? (
            <Button
              variant="ghost"
              onClick={handleRemove}
              disabled={!canEdit || removing}
              className="text-destructive hover:text-destructive"
            >
              {removing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              Remove
            </Button>
          ) : (
            <span />
          )}

          <Button onClick={handleSave} disabled={disabled}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {agentId ? 'Save' : 'Create agent'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ActionSettingRow({
  title,
  description,
  setting,
  onChange,
  guidelinesPlaceholder,
  disabled,
}: {
  title: string;
  description: string;
  setting: AiActionSetting;
  onChange: (next: AiActionSetting) => void;
  guidelinesPlaceholder: string;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Switch
          checked={setting.enabled}
          onCheckedChange={(enabled) => onChange({ ...setting, enabled })}
          disabled={disabled}
        />
      </div>
      {setting.enabled && (
        <Textarea
          value={setting.guidelines ?? ''}
          onChange={(e) => onChange({ ...setting, guidelines: e.target.value })}
          placeholder={guidelinesPlaceholder}
          rows={2}
          disabled={disabled}
        />
      )}
    </div>
  );
}
