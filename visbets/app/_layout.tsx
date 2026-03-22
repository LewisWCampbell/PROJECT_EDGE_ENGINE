/**
 * Root Layout
 * Sets up React Query, Supabase auth, RevenueCat, notifications, and analytics.
 * Firebase has been removed.
 */

import 'react-native-reanimated';
import 'react-native-gesture-handler';

import * as Sentry from '@sentry/react-native';

const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN ?? '';

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: __DEV__ ? 'development' : 'production',
    tracesSampleRate: __DEV__ ? 1.0 : 0.2,
    enableAutoSessionTracking: true,
  });
} else if (!__DEV__) {
  console.error('[Sentry] EXPO_PUBLIC_SENTRY_DSN is not set — crash reporting is DISABLED in production!');
}

import React, { useEffect, useState, useRef } from 'react';
import { Linking } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack, useRouter, useSegments } from 'expo-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { projectionsApi } from '../src/services/api/projectionsApi';
import { StatusBar } from 'expo-status-bar';
import { QUERY_CONFIG } from '../src/utils/constants';
import { useAuthStore, setupAuthListener } from '../src/stores/authStore';
import { useSubscriptionStore } from '../src/stores/subscriptionStore';
// purchasesService is no longer called directly — subscriptionStore.initialize() handles it
import { SplashScreen } from '../src/components/SplashScreen';
import { ErrorBoundary } from '../src/components/common/ErrorBoundary';
import { configureGoogleSignin } from '../src/services/auth/authService';
import { supabase } from '../src/lib/supabase';
import { analyticsService } from '../src/services/analytics/analyticsService';
import { notificationsService } from '../src/services/notifications/notificationsService';

const INIT_TIMEOUT_MS = 30000;
const MIN_SPLASH_TIME_MS = 800;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: QUERY_CONFIG.STALE_TIME.PLAYER_PROPS,
      gcTime: QUERY_CONFIG.CACHE_TIME,
    },
  },
});

/** Getter for the shared QueryClient — used by authStore to clear cache on sign-out. */
export function getQueryClient(): QueryClient {
  return queryClient;
}

// Configure Google Sign-In once at module load (no side-effects, just config)
configureGoogleSignin();

function AuthNavigator() {
  const router = useRouter();
  const segments = useSegments();
  const [initTimedOut, setInitTimedOut] = useState(false);
  const [minSplashTimeElapsed, setMinSplashTimeElapsed] = useState(false);
  const lastNavTarget = useRef<string | null>(null);

  const { user, session, isLoading, isInitialized, devBypass, signOut } =
    useAuthStore();
  const { initialize: initializeSubscription, fetchSubscription } =
    useSubscriptionStore();

  // Splash timer + auth timeout fallback (auth state comes from setupAuthListener)
  useEffect(() => {
    // Minimum splash display time for smooth UX
    const splashTimerId = setTimeout(() => {
      setMinSplashTimeElapsed(true);
    }, MIN_SPLASH_TIME_MS);

    // Fallback: if the auth listener hasn't resolved in 30s, show error
    const timeoutId = setTimeout(() => {
      if (!useAuthStore.getState().isInitialized) {
        console.error('[Auth] Auth listener timed out after 30 seconds');
        setInitTimedOut(true);
        // Force isInitialized so the app doesn't hang on the splash screen
        useAuthStore.setState({ isLoading: false, isInitialized: true });
      }
    }, INIT_TIMEOUT_MS);

    return () => {
      clearTimeout(timeoutId);
      clearTimeout(splashTimerId);
    };
  }, []);

  // Set up Supabase auth state listener
  useEffect(() => {
    const unsubscribe = setupAuthListener();
    return () => unsubscribe();
  }, []);

  // Handle Supabase auth deep links:
  //   implicit flow: visbets://auth/callback#access_token=...&refresh_token=...
  //   PKCE flow:     visbets://auth/callback?code=...
  //   token_hash:    visbets://auth/callback?token_hash=...
  useEffect(() => {
    const handleUrl = async ({ url }: { url: string }) => {
      if (
        !url.includes('access_token') &&
        !url.includes('token_hash') &&
        !url.includes('code=')
      ) return;
      try {
        const fragment = url.split('#')[1] ?? '';
        const query = url.split('?')[1]?.split('#')[0] ?? '';
        const fragmentParams = new URLSearchParams(fragment);
        const queryParams = new URLSearchParams(query);

        const accessToken = fragmentParams.get('access_token') ?? queryParams.get('access_token');
        const refreshToken = fragmentParams.get('refresh_token') ?? queryParams.get('refresh_token');
        const tokenHash = fragmentParams.get('token_hash') ?? queryParams.get('token_hash');
        const code = queryParams.get('code');

        if (accessToken && refreshToken) {
          // Implicit flow — tokens are in the URL directly
          await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
        } else if (code) {
          // PKCE flow — exchange the auth code for a session
          await supabase.auth.exchangeCodeForSession(code);
        } else if (tokenHash) {
          await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
        }
      } catch (err) {
        console.error('[Auth] Deep link error:', err);
      }
    };

    const subscription = Linking.addEventListener('url', handleUrl);
    Linking.getInitialURL().then((url) => { if (url) handleUrl({ url }); });
    return () => subscription.remove();
  }, []);

  // Prefetch projections as soon as auth initializes — this triggers the backend
  // projections pipeline which pre-warms the player-logs cache for fast detail pages.
  useEffect(() => {
    if (!isInitialized || isLoading) return;
    queryClient.prefetchQuery({
      queryKey: ['projections', 'today', undefined],
      queryFn: () => projectionsApi.getTodaysProjections(),
      staleTime: 15 * 60 * 1000,
    }).catch(() => {}); // silent — board will load normally via useProjections
  }, [isInitialized, isLoading]);

  // After auth is ready: init RevenueCat, analytics, notifications
  // NOTE: initializeSubscription() already calls initializeRevenueCat + loginUser
  // + refreshSubscription. Do NOT also call syncWithUser or purchasesService
  // — those duplicate the same RevenueCat configure/logIn calls and cause race conditions.
  useEffect(() => {
    if (!isInitialized || isLoading) return;

    initializeSubscription();

    if (user?.id) {
      fetchSubscription();

      // Analytics
      analyticsService.init(user.id);
      analyticsService.identify(user.id, { created_at: user.createdAt });
    } else {
      analyticsService.init();
    }
  }, [isInitialized, isLoading, user?.id]);

  // Notifications — deferred until user has had a meaningful interaction
  // (permission is requested lazily after first pick save, not on startup)

  // Handle navigation based on auth state — debounced to prevent loops
  useEffect(() => {
    if (!isInitialized || isLoading) return;

    const inAuthGroup = segments[0] === '(auth)';
    const inOnboardingGroup = segments[0] === '(onboarding)';
    // Transient screens the user should never stay on (auth callback, 404)
    const inTransientScreen = segments[0] === 'auth' || segments[0] === '+not-found';

    const isAuthenticated = session !== null;
    const onboardingComplete = user?.onboardingComplete ?? false;

    let target: string | null = null;

    // Dev bypass mode
    if (__DEV__ && devBypass) {
      if (inAuthGroup) target = '/(onboarding)/username';
    } else if (!isAuthenticated && !inAuthGroup) {
      target = '/(auth)/login';
    } else if (isAuthenticated && !onboardingComplete && !inOnboardingGroup) {
      target = '/(onboarding)/username';
    } else if (isAuthenticated && onboardingComplete && (inAuthGroup || inOnboardingGroup || inTransientScreen)) {
      target = '/(tabs)';
    }

    // Only navigate if the target changed — prevents infinite redirect loops
    if (target && target !== lastNavTarget.current) {
      lastNavTarget.current = target;
      router.replace(target as any);
    }

    // Reset navigation tracking when user is on login or auth state changes
    // so that signing in/out always triggers navigation
    if (!target && inAuthGroup) {
      lastNavTarget.current = null;
    }
  }, [isInitialized, isLoading, session, user?.onboardingComplete, segments, devBypass]);

  if (!isInitialized || isLoading || !minSplashTimeElapsed) {
    return (
      <SplashScreen
        showError={initTimedOut}
        errorMessage="Connection timed out"
        errorSubtext="Please check your internet connection and restart the app"
      />
    );
  }

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#0A0A0B' },
        headerTintColor: '#00FF88',
        headerTitleStyle: { fontWeight: 'bold' },
        contentStyle: { backgroundColor: '#0A0A0B' },
      }}
    >
      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      <Stack.Screen name="(onboarding)" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="player" options={{ headerShown: false }} />
      <Stack.Screen name="subscription" options={{ title: 'Subscription', presentation: 'modal' }} />
      <Stack.Screen name="auth/callback" options={{ headerShown: false, animation: 'none' }} />
      <Stack.Screen name="terms-of-service" options={{ title: 'Terms of Service', presentation: 'modal', headerShown: false }} />
      <Stack.Screen name="privacy-policy" options={{ title: 'Privacy Policy', presentation: 'modal', headerShown: false }} />
      <Stack.Screen name="parlay-analysis" options={{ title: 'Parlay Analysis', presentation: 'modal', headerShown: false }} />
      <Stack.Screen name="bug-report" options={{ title: 'Report a Bug', presentation: 'modal', headerShown: false }} />
    </Stack>
  );
}

function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ErrorBoundary
        onError={(error) => {
          console.error('[App] Fatal error:', error.message);
          if (SENTRY_DSN) Sentry.captureException(error);
        }}
      >
        <QueryClientProvider client={queryClient}>
          <StatusBar style="light" />
          <AuthNavigator />
        </QueryClientProvider>
      </ErrorBoundary>
    </GestureHandlerRootView>
  );
}

export default SENTRY_DSN ? Sentry.wrap(RootLayout) : RootLayout;
