/**
 * Profile Screen - Modern, polished user profile
 *
 * Features:
 * - Animated sections with smooth entry
 * - Subscription management
 * - User statistics
 * - App settings
 * - Support options
 */

import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Linking,
  Alert,
  Platform,
  Image,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  FadeInUp,
  FadeIn,
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import { Pressable } from 'react-native';
import * as Haptics from 'expo-haptics';
import Constants from 'expo-constants';
import { useSubscriptionStore } from '../../src/stores/subscriptionStore';
import { useAuthStore } from '../../src/stores/authStore';
import { backendClient } from '../../src/services/api/backendClient';
import { supabase } from '../../src/lib/supabase';
import { colors } from '../../src/theme/colors';
import { typography } from '../../src/theme/typography';
import { spacing, borderRadius } from '../../src/theme/styles';
import { BUG_REPORT_EMAIL, HELP_EMAIL, FEEDBACK_EMAIL } from '../../src/utils/constants';
import { SubscriptionTier } from '../../src/types/subscription';

const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';

// Animated Pressable Button
function AnimatedButton({
  onPress,
  style,
  children,
  haptic = true,
}: {
  onPress: () => void;
  style?: any;
  children: React.ReactNode;
  haptic?: boolean;
}) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = () => {
    if (haptic && Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    onPress();
  };

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        onPress={handlePress}
        onPressIn={() => {
          scale.value = withSpring(0.97, { damping: 15, stiffness: 300 });
        }}
        onPressOut={() => {
          scale.value = withSpring(1, { damping: 15, stiffness: 300 });
        }}
        style={style}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

// Menu Item Component
function MenuItem({
  icon,
  label,
  value,
  onPress,
  showChevron = true,
  danger = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value?: string;
  onPress?: () => void;
  showChevron?: boolean;
  danger?: boolean;
}) {
  const iconColor = danger ? colors.semantic.danger : colors.text.secondary;
  const labelColor = danger ? colors.semantic.danger : colors.text.primary;

  const content = (
    <View style={styles.menuItem}>
      <View style={[styles.menuIconContainer, danger && styles.menuIconDanger]}>
        <Ionicons name={icon} size={20} color={iconColor} />
      </View>
      <Text style={[styles.menuLabel, { color: labelColor }]}>{label}</Text>
      {value && <Text style={styles.menuValue}>{value}</Text>}
      {showChevron && !value && (
        <Ionicons name="chevron-forward" size={18} color={colors.text.muted} />
      )}
    </View>
  );

  if (onPress) {
    return (
      <AnimatedButton onPress={onPress} style={styles.menuItemPressable}>
        {content}
      </AnimatedButton>
    );
  }

  return <View style={styles.menuItemPressable}>{content}</View>;
}

export default function ProfileScreen() {
  const router = useRouter();
  const { tier, setTier, applyPromoTier } = useSubscriptionStore();
  const { user, signOut } = useAuthStore();

  // Promo code state
  const [promoCode, setPromoCode] = useState('');
  const [promoLoading, setPromoLoading] = useState(false);

  const handleRedeemPromo = useCallback(async () => {
    const code = promoCode.trim().toUpperCase();
    if (!code) { Alert.alert('Enter a code', 'Please enter a promo code first.'); return; }
    setPromoLoading(true);
    try {
      const { data } = await backendClient.post('/api/promo/redeem', { code });
      setPromoCode('');
      // Bust backend tier cache FIRST so gated endpoints recognize the new tier
      try { await backendClient.post('/api/subscriptions/refresh-tier'); } catch {}
      // Then update local tier
      if (data.tier) applyPromoTier(data.tier);
      Alert.alert('Code Applied!', data.message ?? `${data.tier?.toUpperCase()} access activated.`);
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.response?.data?.error ?? err?.message ?? 'Something went wrong.';
      Alert.alert('Invalid Code', msg);
    } finally {
      setPromoLoading(false);
    }
  }, [promoCode, applyPromoTier]);

  const [editingUsername, setEditingUsername] = useState(false);
  const [newUsername, setNewUsername] = useState(user?.username ?? '');

  const displayUsername = user?.username;
  const displayTier = tier;

  const tierConfig: Record<SubscriptionTier, { label: string; color: string; icon: keyof typeof Ionicons.glyphMap }> = {
    [SubscriptionTier.FREE]: { label: 'Free', color: colors.text.muted, icon: 'person-outline' },
    [SubscriptionTier.STARTER]: { label: 'Starter', color: colors.primary.main, icon: 'star' },
    [SubscriptionTier.PRO]: { label: 'Pro', color: colors.semantic.warning, icon: 'diamond' },
  };

  const currentTierConfig = tierConfig[displayTier];

  const handleSignOut = useCallback(() => {
    Alert.alert(
      'Sign Out',
      'Are you sure you want to sign out?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: () => signOut(),
        },
      ]
    );
  }, [signOut]);

  const handleBugReport = useCallback(() => {
    router.push('/bug-report');
  }, [router]);

  const handleHelpCenter = useCallback(() => {
    const subject = encodeURIComponent('Help Request - VisBets');
    const body = encodeURIComponent(
      `\n\n---\nUser: ${user?.username || 'Unknown'}\nDevice: ${Platform.OS}\nApp Version: ${APP_VERSION}`
    );
    Linking.openURL(`mailto:${HELP_EMAIL}?subject=${subject}&body=${body}`);
  }, [user?.username]);

  const handleFeedback = useCallback(() => {
    const subject = encodeURIComponent('Feedback - VisBets');
    const body = encodeURIComponent(
      `\n\n---\nUser: ${user?.username || 'Unknown'}\nDevice: ${Platform.OS}\nApp Version: ${APP_VERSION}`
    );
    Linking.openURL(`mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${body}`);
  }, [user?.username]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <Animated.View entering={FadeIn.duration(300)} style={styles.header}>
          <Text style={styles.headerTitle}>Profile</Text>
        </Animated.View>

        {/* Profile Card */}
        <Animated.View entering={FadeInUp.duration(400).delay(100)} style={styles.profileCard}>
          <LinearGradient
            colors={[colors.primary.main + '15', colors.background.secondary]}
            style={StyleSheet.absoluteFill}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
          />

          {/* Logo Avatar */}
          <View style={styles.avatarContainer}>
            <View style={styles.avatarGradient}>
              <Image
                source={require('../../assets/animations/visbets-logo.png')}
                style={{ width: 60, height: 60, opacity: 0.9 }}
                resizeMode="contain"
              />
            </View>
            {tier !== SubscriptionTier.FREE && (
              <View style={[styles.tierBadgeSmall, { backgroundColor: currentTierConfig.color + '20', borderColor: currentTierConfig.color }]}>
                <Ionicons name={currentTierConfig.icon} size={10} color={currentTierConfig.color} />
              </View>
            )}
          </View>

          {/* Username (editable) */}
          {editingUsername ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm }}>
              <TextInput
                style={[styles.userName, { borderBottomWidth: 1, borderBottomColor: colors.primary.main, paddingBottom: 4, flex: 1 }]}
                value={newUsername}
                onChangeText={setNewUsername}
                autoCapitalize="words"
                autoCorrect={false}
                autoFocus
                maxLength={30}
              />
              <Pressable onPress={async () => {
                const trimmed = newUsername.trim();
                if (trimmed.length < 2) { Alert.alert('Too short', 'Name must be at least 2 characters'); return; }
                if (user?.id) {
                  const { error: updateError } = await supabase.from('profiles').update({ username: trimmed.toLowerCase().replace(/\s+/g, '_'), display_name: trimmed } as any).eq('id', user.id);
                  if (updateError) {
                    Alert.alert('Update Failed', updateError.message ?? 'Could not update username. Please try again.');
                    return;
                  }
                  await useAuthStore.getState().refreshUser();
                }
                setEditingUsername(false);
              }}>
                <Ionicons name="checkmark-circle" size={24} color={colors.primary.main} />
              </Pressable>
              <Pressable onPress={() => { setEditingUsername(false); setNewUsername(user?.username ?? ''); }}>
                <Ionicons name="close-circle" size={24} color={colors.text.muted} />
              </Pressable>
            </View>
          ) : (
            <Pressable onPress={() => setEditingUsername(true)} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
              <Text style={styles.userName}>
                {displayUsername ? `@${displayUsername}` : 'VisBets User'}
              </Text>
              <Ionicons name="pencil" size={14} color={colors.text.muted} />
            </Pressable>
          )}
          <View style={[styles.tierPill, { backgroundColor: currentTierConfig.color + '15', borderColor: currentTierConfig.color + '40' }]}>
            <Ionicons name={currentTierConfig.icon} size={14} color={currentTierConfig.color} />
            <Text style={[styles.tierPillText, { color: currentTierConfig.color }]}>
              {currentTierConfig.label}
            </Text>
          </View>

          {/* Upgrade Button */}
          {displayTier === SubscriptionTier.FREE && (
            <AnimatedButton
              onPress={() => router.push('/subscription')}
              style={styles.upgradeButton}
            >
              <LinearGradient
                colors={[colors.primary.main, colors.primary.main + 'CC']}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
              />
              <Image
                source={require('../../assets/animations/visbets-logo.png')}
                style={{ width: 18, height: 18 }}
                resizeMode="contain"
              />
              <Text style={styles.upgradeButtonText}>Upgrade</Text>
            </AnimatedButton>
          )}
        </Animated.View>

        {/* Promo Code Section */}
        <Animated.View entering={FadeInUp.duration(400).delay(175)} style={styles.section}>
          <Text style={styles.sectionTitle}>Promo Code</Text>
          <View style={[styles.menuCard, styles.promoCard]}>
            <View style={styles.promoRow}>
              <TextInput
                style={styles.promoInput}
                value={promoCode}
                onChangeText={(t) => setPromoCode(t.toUpperCase())}
                placeholder="ENTER CODE"
                placeholderTextColor={colors.text.muted}
                autoCapitalize="characters"
                autoCorrect={false}
                editable={!promoLoading}
              />
              <AnimatedButton
                onPress={handleRedeemPromo}
                style={[styles.promoButton, promoLoading && { opacity: 0.6 }]}
              >
                {promoLoading
                  ? <ActivityIndicator size="small" color={colors.background.primary} />
                  : <Text style={styles.promoButtonText}>Apply</Text>
                }
              </AnimatedButton>
            </View>
          </View>
        </Animated.View>

        {/* Subscription Section */}
        <Animated.View entering={FadeInUp.duration(400).delay(200)} style={styles.section}>
          <Text style={styles.sectionTitle}>Subscription</Text>
          <View style={styles.menuCard}>
            <MenuItem
              icon="card-outline"
              label="Manage Plan"
              onPress={() => router.push('/subscription')}
            />
            <View style={styles.menuDivider} />
            <MenuItem
              icon="receipt-outline"
              label="Billing History"
              value="Coming Soon"
            />
          </View>
        </Animated.View>

        {/* Settings Section */}
        <Animated.View entering={FadeInUp.duration(400).delay(300)} style={styles.section}>
          <Text style={styles.sectionTitle}>Settings</Text>
          <View style={styles.menuCard}>
            <MenuItem
              icon="notifications-outline"
              label="Notifications"
              value="Coming Soon"
            />
            <View style={styles.menuDivider} />
            <MenuItem
              icon="moon-outline"
              label="Theme"
              value="Dark"
            />
            <View style={styles.menuDivider} />
            <MenuItem
              icon="language-outline"
              label="Language"
              value="English"
            />
          </View>
        </Animated.View>

        {/* Support Section */}
        <Animated.View entering={FadeInUp.duration(400).delay(400)} style={styles.section}>
          <Text style={styles.sectionTitle}>Support</Text>
          <View style={styles.menuCard}>
            <MenuItem
              icon="help-circle-outline"
              label="Help Center"
              onPress={handleHelpCenter}
            />
            <View style={styles.menuDivider} />
            <MenuItem
              icon="bug-outline"
              label="Report a Bug"
              onPress={handleBugReport}
            />
            <View style={styles.menuDivider} />
            <MenuItem
              icon="chatbubble-outline"
              label="Send Feedback"
              onPress={handleFeedback}
            />
          </View>
        </Animated.View>

        {/* About Section */}
        <Animated.View entering={FadeInUp.duration(400).delay(500)} style={styles.section}>
          <Text style={styles.sectionTitle}>About</Text>
          <View style={styles.menuCard}>
            <MenuItem
              icon="information-circle-outline"
              label="Version"
              value={APP_VERSION}
              showChevron={false}
            />
            <View style={styles.menuDivider} />
            <MenuItem
              icon="document-text-outline"
              label="Terms of Service"
              onPress={() => router.push('/terms-of-service')}
            />
            <View style={styles.menuDivider} />
            <MenuItem
              icon="shield-checkmark-outline"
              label="Privacy Policy"
              onPress={() => router.push('/privacy-policy')}
            />
          </View>
        </Animated.View>

        {/* DEV: Tier Toggle */}
        {__DEV__ && (
          <Animated.View entering={FadeInUp.duration(400).delay(600)} style={styles.section}>
            <Text style={styles.sectionTitle}>Developer Options</Text>
            <View style={styles.menuCard}>
              <View style={styles.devTierButtons}>
                {[SubscriptionTier.FREE, SubscriptionTier.STARTER, SubscriptionTier.PRO].map((t) => (
                  <AnimatedButton
                    key={t}
                    onPress={() => setTier(t)}
                    style={[
                      styles.devTierButton,
                      tier === t && styles.devTierButtonActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.devTierButtonText,
                        tier === t && styles.devTierButtonTextActive,
                      ]}
                    >
                      {tierConfig[t].label}
                    </Text>
                  </AnimatedButton>
                ))}
              </View>
            </View>
          </Animated.View>
        )}

        {/* Sign Out */}
        <Animated.View entering={FadeInUp.duration(400).delay(700)} style={styles.section}>
          <View style={styles.menuCard}>
            <MenuItem
              icon="log-out-outline"
              label="Sign Out"
              onPress={handleSignOut}
              showChevron={false}
              danger
            />
          </View>
        </Animated.View>

        {/* Footer */}
        <Animated.View entering={FadeIn.duration(300).delay(800)} style={styles.footer}>
          <Text style={styles.footerText}>2026 User Reality Labs LLC</Text>
          <Text style={styles.footerSubtext}>VisBets v{APP_VERSION}</Text>
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: spacing['3xl'],
  },

  // Header
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  headerTitle: {
    fontSize: typography.fontSize['2xl'],
    fontWeight: typography.fontWeight.bold,
    color: colors.text.primary,
  },

  // Profile Card
  profileCard: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.lg,
    padding: spacing.xl,
    borderRadius: borderRadius.xl,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border.default,
    overflow: 'hidden',
  },
  avatarContainer: {
    position: 'relative',
    marginBottom: spacing.md,
  },
  avatarGradient: {
    width: 88,
    height: 88,
    borderRadius: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 3,
    borderColor: colors.primary.main + '30',
  },
  avatarText: {
    fontSize: 36,
    fontWeight: typography.fontWeight.bold,
    color: colors.primary.main,
  },
  tierBadgeSmall: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
  },
  userName: {
    fontSize: typography.fontSize.xl,
    fontWeight: typography.fontWeight.bold,
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  tierPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    gap: spacing.xs,
    marginBottom: spacing.lg,
  },
  tierPillText: {
    fontSize: typography.fontSize.sm,
    fontWeight: typography.fontWeight.semibold,
  },
  upgradeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.full,
    gap: spacing.sm,
    overflow: 'hidden',
  },
  upgradeButtonText: {
    fontSize: typography.fontSize.base,
    fontWeight: typography.fontWeight.bold,
    color: colors.background.primary,
  },

  // Section
  section: {
    marginBottom: spacing.lg,
    paddingHorizontal: spacing.md,
  },
  sectionTitle: {
    fontSize: typography.fontSize.sm,
    fontWeight: typography.fontWeight.bold,
    color: colors.text.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.sm,
    marginLeft: spacing.sm,
  },

  // Menu Card
  menuCard: {
    backgroundColor: colors.background.secondary,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: colors.border.default,
    overflow: 'hidden',
  },
  menuItemPressable: {
    paddingHorizontal: spacing.md,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  menuIconContainer: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.background.tertiary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  menuIconDanger: {
    backgroundColor: colors.semantic.danger + '15',
  },
  menuLabel: {
    flex: 1,
    fontSize: typography.fontSize.base,
    fontWeight: typography.fontWeight.medium,
  },
  menuValue: {
    fontSize: typography.fontSize.base,
    color: colors.text.muted,
  },
  menuDivider: {
    height: 1,
    backgroundColor: colors.border.default,
    marginLeft: spacing.md + 36 + spacing.md,
  },

  // Dev Tier Buttons
  devTierButtons: {
    flexDirection: 'row',
    padding: spacing.md,
    gap: spacing.sm,
  },
  devTierButton: {
    flex: 1,
    paddingVertical: spacing.sm,
    backgroundColor: colors.background.tertiary,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border.default,
    alignItems: 'center',
  },
  devTierButtonActive: {
    backgroundColor: colors.primary.main + '20',
    borderColor: colors.primary.main,
  },
  devTierButtonText: {
    fontSize: typography.fontSize.sm,
    fontWeight: typography.fontWeight.semibold,
    color: colors.text.secondary,
  },
  devTierButtonTextActive: {
    color: colors.primary.main,
  },

  // Stats Grid
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  statCard: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: colors.background.secondary,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: colors.border.default,
    padding: spacing.md,
    alignItems: 'center',
  },
  statValue: {
    fontSize: typography.fontSize['2xl'],
    fontWeight: typography.fontWeight.bold,
    color: colors.text.primary,
    marginBottom: 4,
  },
  statLabel: {
    fontSize: typography.fontSize.xs,
    color: colors.text.muted,
    textAlign: 'center',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  // Promo Code
  promoCard: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  promoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  promoInput: {
    flex: 1,
    backgroundColor: colors.background.tertiary,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border.default,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: typography.fontSize.base,
    fontWeight: typography.fontWeight.bold,
    color: colors.text.primary,
    letterSpacing: 2,
  },
  promoButton: {
    backgroundColor: colors.primary.main,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 72,
  },
  promoButtonText: {
    fontSize: typography.fontSize.sm,
    fontWeight: typography.fontWeight.bold,
    color: colors.background.primary,
  },

  // Footer
  footer: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
  },
  footerText: {
    fontSize: typography.fontSize.sm,
    color: colors.text.muted,
    marginBottom: spacing.xs,
  },
  footerSubtext: {
    fontSize: typography.fontSize.xs,
    color: colors.text.muted,
  },
});
