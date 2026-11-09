import { createContext, useContext, useEffect, useRef, useState } from "react";
import { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";
import { getTierByProductId, SubscriptionTier } from "@/lib/subscriptionTiers";

type AppRole = 'admin' | 'user' | 'client';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  role: AppRole | null;
  subscriptionTier: SubscriptionTier | null;
  subscribed: boolean;
  subscriptionEnd: string | null;
  isTrial: boolean;
  isStripeTrial: boolean;
  trialDaysRemaining: number | null;
  canCancel: boolean;
  signIn: (email: string, password: string) => Promise<{ error: any }>;
  signUp: (email: string, password: string, fullName: string, businessName: string) => Promise<{ error: any; needsEmailConfirmation: boolean; alreadyRegistered: boolean }>;
  signOut: () => Promise<void>;
  isPasswordRecovery: boolean;
  updatePassword: (newPassword: string) => Promise<{ error: any }>;
  checkSubscription: () => Promise<void>;
  openCustomerPortal: () => Promise<void>;
  loading: boolean;
  /** Platform administrator (MAJR Books staff). */
  isAdmin: boolean;
  /** Invited client portal user. */
  isClient: boolean;
  /**
   * Invited team member (accountant/employee) working inside another
   * account owner's books. Covered by that owner's subscription.
   */
  isStaff: boolean;
  /** Account owner: a self-signed-up firm/business that pays for its own plan. */
  isOwner: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<AppRole | null>(null);
  const [isTeamMember, setIsTeamMember] = useState(false);
  const [roleLoading, setRoleLoading] = useState(true);
  const roleUserIdRef = useRef<string | null>(null);
  const [subscriptionTier, setSubscriptionTier] = useState<SubscriptionTier | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [subscriptionEnd, setSubscriptionEnd] = useState<string | null>(null);
  const [isTrial, setIsTrial] = useState(false);
  const [isStripeTrial, setIsStripeTrial] = useState(false);
  const [trialDaysRemaining, setTrialDaysRemaining] = useState<number | null>(null);
  const [canCancel, setCanCancel] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false);
  const navigate = useNavigate();

  const fetchUserRole = async (userId: string) => {
    // Only block the UI on the first load for this user. Later refreshes
    // (e.g. TOKEN_REFRESHED events) update in the background so pages are
    // never unmounted by the route guard's loading spinner.
    if (roleUserIdRef.current !== userId) setRoleLoading(true);
    try {
      const [{ data: roleRows, error }, { data: membership }] = await Promise.all([
        supabase.from('app_user_roles').select('role').eq('user_id', userId),
        supabase
          .from('team_members')
          .select('id')
          .eq('user_id', userId)
          .eq('is_active', true)
          .limit(1),
      ]);

      // A user can hold more than one row; the most privileged wins.
      const roles = new Set((!error && roleRows ? roleRows : []).map((r) => r.role as AppRole));
      const userRole: AppRole = roles.has('admin') ? 'admin' : roles.has('client') ? 'client' : 'user';
      setRole(userRole);
      setIsTeamMember(!!membership && membership.length > 0);
      roleUserIdRef.current = userId;
    } finally {
      setRoleLoading(false);
    }
  };

  const checkSubscription = async () => {
    if (!session) return;
    
    try {
      const { data, error } = await supabase.functions.invoke('check-subscription');
      
      if (error) {
        console.error('Error checking subscription:', error);
        return;
      }
      
      // Admin users get full access from the backend
      if (data.is_admin) {
        setSubscribed(true);
        setSubscriptionTier('enterprise');
        setIsTrial(false);
        setIsStripeTrial(false);
        setTrialDaysRemaining(null);
        setSubscriptionEnd(null);
        setCanCancel(false);
        return;
      }
      
      setSubscribed(data.subscribed || false);
      setIsTrial(data.is_trial || false);
      setIsStripeTrial(data.is_stripe_trial || false);
      setCanCancel(data.can_cancel || false);
      
      if (data.is_trial || data.is_stripe_trial) {
        // During free trial, give full access (trial tier has all features)
        setSubscriptionTier('trial');
        
        const trialEndDate = data.trial_ends_at || data.subscription_end;
        setSubscriptionEnd(trialEndDate || null);
        
        // Calculate days remaining
        if (trialEndDate) {
          const endDate = new Date(trialEndDate);
          const now = new Date();
          const daysRemaining = Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
          setTrialDaysRemaining(Math.max(0, daysRemaining));
        }
      } else if (data.subscribed && data.product_id) {
        // Active paid subscription - features based on their chosen plan
        setSubscriptionTier(getTierByProductId(data.product_id));
        setSubscriptionEnd(data.subscription_end || null);
        setTrialDaysRemaining(null);
      } else {
        // No active subscription and trial expired - no tier access
        setSubscriptionTier(null);
        setSubscriptionEnd(null);
        setTrialDaysRemaining(null);
      }
    } catch (err) {
      console.error('Failed to check subscription:', err);
    }
  };

  const openCustomerPortal = async () => {
    try {
      const { data, error } = await supabase.functions.invoke('customer-portal');
      
      if (error) throw error;
      
      if (data?.url) {
        window.open(data.url, '_blank');
      }
    } catch (err) {
      console.error('Failed to open customer portal:', err);
    }
  };

  // The server derives the recipient from the account itself; for signups
  // without a session yet, it verifies the new account by id.
  const sendLoginNotification = async (eventType: 'login' | 'signup', userId?: string) => {
    try {
      await supabase.functions.invoke('send-login-notification', {
        body: {
          eventType,
          userId,
          userAgent: navigator.userAgent,
        }
      });
    } catch (err) {
      console.error('Failed to send login notification:', err);
    }
  };

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (event === 'PASSWORD_RECOVERY') {
          setIsPasswordRecovery(true);
        }

        setSession(session);
        setUser(session?.user ?? null);
        setLoading(false);

        if (session?.user) {
          setTimeout(() => {
            fetchUserRole(session.user.id);
          }, 0);
        } else {
          setRole(null);
          setIsTeamMember(false);
          setRoleLoading(false);
          roleUserIdRef.current = null;
          setSubscribed(false);
          setSubscriptionTier(null);
          setSubscriptionEnd(null);
          setIsTrial(false);
          setTrialDaysRemaining(null);
        }
      }
    );

    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
      
      if (session?.user) {
        fetchUserRole(session.user.id);
      } else {
        setRoleLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // Check subscription when session changes
  useEffect(() => {
    if (session) {
      checkSubscription();
    }
  }, [session]);

  // Periodic subscription check every 60 seconds
  useEffect(() => {
    if (!session) return;
    
    const interval = setInterval(() => {
      checkSubscription();
    }, 60000);
    
    return () => clearInterval(interval);
  }, [session]);

  const signIn = async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    
    if (!error && data.user) {
      // Send login notification
      sendLoginNotification('login');
    }
    
    return { error };
  };

  const signUp = async (email: string, password: string, fullName: string, businessName: string) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/dashboard`,
        data: {
          full_name: fullName,
          business_name: businessName,
        },
      },
    });

    if (error) {
      return { error, needsEmailConfirmation: false, alreadyRegistered: false };
    }

    // Supabase returns a 200 with an obfuscated user (empty identities) instead of an
    // error when the email is already registered, to avoid leaking which emails exist.
    const alreadyRegistered = !!data.user && (data.user.identities?.length ?? 0) === 0;
    if (alreadyRegistered) {
      return { error: null, needsEmailConfirmation: false, alreadyRegistered: true };
    }

    if (data.user) {
      // The 14-day trial is granted by the database signup trigger.
      sendLoginNotification('signup', data.user.id);
    }

    // If email confirmation is required, signUp succeeds but returns no session —
    // the caller needs to know so it doesn't treat this as an authenticated signup.
    return { error: null, needsEmailConfirmation: !data.session, alreadyRegistered: false };
  };

  const updatePassword = async (newPassword: string) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (!error) {
      setIsPasswordRecovery(false);
    }
    return { error };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setRole(null);
    setIsTeamMember(false);
    roleUserIdRef.current = null;
    setSubscribed(false);
    setSubscriptionTier(null);
    setSubscriptionEnd(null);
    setIsTrial(false);
    setIsStripeTrial(false);
    setTrialDaysRemaining(null);
    setCanCancel(false);
    navigate("/");
  };

  return (
    <AuthContext.Provider value={{ 
      user, 
      session, 
      role,
      subscriptionTier,
      subscribed,
      subscriptionEnd,
      isTrial,
      isStripeTrial,
      trialDaysRemaining,
      canCancel,
      signIn,
      signUp,
      signOut,
      isPasswordRecovery,
      updatePassword,
      checkSubscription,
      openCustomerPortal,
      // Not "loaded" until the role is known, so route guards never act on a null role.
      loading: loading || (!!user && roleLoading),
      isAdmin: role === 'admin',
      isClient: role === 'client',
      isStaff: role === 'user' && isTeamMember,
      isOwner: role === 'user' && !isTeamMember,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
