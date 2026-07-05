import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { router } from 'expo-router';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { DEFAULT_CURRENCY } from '../lib/currency';
import { syncPushTokenWithBackend, unregisterPushToken } from '../lib/push-notifications';
import {
  canEditSettings as canEditSettingsFor,
  canManageMembers as canManageMembersFor,
  canSendMessages as canSendMessagesFor,
  isAccountRole,
  type AccountRole,
} from '../lib/roles';

// Ported from src/hooks/use-auth.tsx (web). Same shape, same queries —
// only the session store differs (AsyncStorage here vs the web app's
// HTTP-only cookies), and `signOut` navigates via expo-router instead
// of `window.location.href`.

interface Profile {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  beta_features: string[];
  account_id: string | null;
  account_role: AccountRole | null;
}

interface AccountSummary {
  id: string;
  name: string;
  default_currency: string;
}

interface AuthContextValue {
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  profileLoading: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  accountId: string | null;
  accountRole: AccountRole | null;
  account: AccountSummary | null;
  defaultCurrency: string;
  isOwner: boolean;
  isAdmin: boolean;
  isAgent: boolean;
  isViewer: boolean;
  canManageMembers: boolean;
  canEditSettings: boolean;
  canSendMessages: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(true);

  const lastFetchedUserIdRef = useRef<string | null>(null);

  const fetchProfile = useCallback(async (userId: string) => {
    setProfileLoading(true);
    lastFetchedUserIdRef.current = userId;
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select(
          'id, full_name, email, avatar_url, role, beta_features, account_id, account_role',
        )
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        console.error('[AuthProvider] fetchProfile error:', error.message);
        lastFetchedUserIdRef.current = null;
        return;
      }

      if (data) {
        let accountRow: AccountSummary | null = null;
        if (data.account_id) {
          const { data: accountData, error: accountErr } = await supabase
            .from('accounts')
            .select('id, name, default_currency')
            .eq('id', data.account_id)
            .maybeSingle();
          if (accountErr) {
            console.error('[AuthProvider] fetchAccount error:', accountErr.message);
          } else if (accountData) {
            accountRow = {
              id: accountData.id,
              name: accountData.name,
              default_currency: accountData.default_currency ?? DEFAULT_CURRENCY,
            };
          }
        }

        const accountRole = isAccountRole(data.account_role)
          ? data.account_role
          : null;

        setProfile({
          id: data.id,
          full_name: data.full_name,
          email: data.email,
          avatar_url: data.avatar_url,
          role: data.role,
          beta_features: data.beta_features ?? [],
          account_id: data.account_id ?? null,
          account_role: accountRole,
        });
        setAccount(accountRow);
      } else {
        lastFetchedUserIdRef.current = null;
      }
    } catch (err) {
      console.error('[AuthProvider] fetchProfile threw:', err);
      lastFetchedUserIdRef.current = null;
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    const safetyTimer = setTimeout(() => {
      if (mounted) {
        console.warn('[AuthProvider] getSession() timed out after 3s');
        setLoading(false);
        setProfileLoading(false);
      }
    }, 3000);

    const init = async () => {
      try {
        const {
          data: { session },
          error,
        } = await supabase.auth.getSession();

        if (error) console.error('[AuthProvider] getSession error:', error.message);

        if (!mounted) return;
        const currentUser = session?.user ?? null;
        setUser(currentUser);

        if (currentUser) {
          fetchProfile(currentUser.id);
          // Best-effort, fire-and-forget — a push registration failure
          // (e.g. no EAS project configured yet) must never block auth.
          void syncPushTokenWithBackend();
        } else {
          setProfileLoading(false);
        }
      } catch (err) {
        console.error('[AuthProvider] init threw:', err);
      } finally {
        if (mounted) setLoading(false);
        clearTimeout(safetyTimer);
      }
    };

    init();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      const currentUser = session?.user ?? null;
      setUser(currentUser);

      if (currentUser) {
        if (currentUser.id !== lastFetchedUserIdRef.current) {
          fetchProfile(currentUser.id);
          void syncPushTokenWithBackend();
        }
      } else {
        lastFetchedUserIdRef.current = null;
        setProfile(null);
        setAccount(null);
        setProfileLoading(false);
      }

      setLoading(false);
    });

    return () => {
      mounted = false;
      clearTimeout(safetyTimer);
      subscription.unsubscribe();
    };
  }, [fetchProfile]);

  const signOut = useCallback(async () => {
    // Must run before signOut() — needs the still-valid session to
    // authenticate the DELETE call.
    await unregisterPushToken();
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setAccount(null);
    router.replace('/login');
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!user?.id) return;
    await fetchProfile(user.id);
  }, [user?.id, fetchProfile]);

  const derived = useMemo(() => {
    const role = profile?.account_role ?? null;
    return {
      accountRole: role,
      accountId: profile?.account_id ?? null,
      isOwner: role === 'owner',
      isAdmin: role === 'admin',
      isAgent: role === 'agent',
      isViewer: role === 'viewer',
      canManageMembers: role ? canManageMembersFor(role) : false,
      canEditSettings: role ? canEditSettingsFor(role) : false,
      canSendMessages: role ? canSendMessagesFor(role) : false,
    };
  }, [profile?.account_role, profile?.account_id]);

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        profileLoading,
        signOut,
        refreshProfile,
        account,
        defaultCurrency: account?.default_currency ?? DEFAULT_CURRENCY,
        ...derived,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    return {
      user: null,
      profile: null,
      loading: false,
      profileLoading: false,
      signOut: async () => {
        router.replace('/login');
      },
      refreshProfile: async () => {},
      account: null,
      defaultCurrency: DEFAULT_CURRENCY,
      accountId: null,
      accountRole: null,
      isOwner: false,
      isAdmin: false,
      isAgent: false,
      isViewer: false,
      canManageMembers: false,
      canEditSettings: false,
      canSendMessages: false,
    };
  }
  return ctx;
}
