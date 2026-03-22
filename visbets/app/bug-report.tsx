/**
 * Bug Report Screen
 * In-app form that submits to Supabase bug_reports table.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Platform,
  KeyboardAvoidingView,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { supabase } from '../src/lib/supabase';
import { useAuthStore } from '../src/stores/authStore';
import { colors } from '../src/theme/colors';
import { typography } from '../src/theme/typography';
import { spacing, borderRadius } from '../src/theme/styles';

const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';

const PAGES = [
  'Board (Main Screen)',
  'Player Detail',
  'Parlay Builder',
  'Parlays',
  'Profile',
  'Login / Sign Up',
  'Onboarding',
  'Subscription',
  'Other',
];

export default function BugReportScreen() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);

  const [name, setName] = useState(user?.displayName ?? user?.username ?? '');
  const [selectedPage, setSelectedPage] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = selectedPage.length > 0 && description.trim().length >= 10;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const { error } = await supabase.from('bug_reports').insert({
        user_id: user?.id ?? null,
        reporter_name: name.trim() || null,
        page: selectedPage,
        description: description.trim(),
        app_version: APP_VERSION,
        platform: Platform.OS,
      } as any);

      if (error) throw error;

      Alert.alert(
        'Bug Reported',
        'Thanks for helping us improve VisBets! We\'ll look into this.',
        [{ text: 'OK', onPress: () => router.back() }]
      );
    } catch (err: any) {
      Alert.alert('Submission Failed', err?.message ?? 'Please try again later.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <Ionicons name="arrow-back" size={24} color={colors.text.primary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Report a Bug</Text>
          <View style={{ width: 24 }} />
        </View>

        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Name (optional) */}
          <View style={styles.field}>
            <Text style={styles.label}>Your Name <Text style={styles.optional}>(optional)</Text></Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="How should we address you?"
              placeholderTextColor={colors.text.muted}
              autoCapitalize="words"
              autoCorrect={false}
              maxLength={50}
            />
          </View>

          {/* Page selector */}
          <View style={styles.field}>
            <Text style={styles.label}>Where did you find the bug?</Text>
            <View style={styles.pageGrid}>
              {PAGES.map((page) => {
                const isSelected = selectedPage === page;
                return (
                  <TouchableOpacity
                    key={page}
                    style={[styles.pageChip, isSelected && styles.pageChipSelected]}
                    onPress={() => setSelectedPage(page)}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.pageChipText, isSelected && styles.pageChipTextSelected]}>
                      {page}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Description */}
          <View style={styles.field}>
            <Text style={styles.label}>Explain the issue</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              value={description}
              onChangeText={setDescription}
              placeholder="What happened? What did you expect to happen?"
              placeholderTextColor={colors.text.muted}
              multiline
              numberOfLines={6}
              textAlignVertical="top"
              maxLength={1000}
            />
            <Text style={styles.charCount}>{description.length}/1000</Text>
          </View>

          {/* Submit */}
          <TouchableOpacity
            style={[styles.submitButton, !canSubmit && styles.submitButtonDisabled]}
            onPress={handleSubmit}
            disabled={!canSubmit || submitting}
            activeOpacity={0.8}
          >
            {submitting ? (
              <ActivityIndicator size="small" color={colors.background.primary} />
            ) : (
              <>
                <Ionicons name="send" size={18} color={colors.background.primary} />
                <Text style={styles.submitButtonText}>Submit Report</Text>
              </>
            )}
          </TouchableOpacity>

          <Text style={styles.disclaimer}>
            Bug reports are stored securely and only used to improve VisBets.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  backButton: {
    padding: spacing.xs,
  },
  headerTitle: {
    fontSize: typography.fontSize.lg,
    fontWeight: typography.fontWeight.bold as any,
    color: colors.text.primary,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing['3xl'],
  },
  field: {
    marginBottom: spacing.xl,
  },
  label: {
    fontSize: typography.fontSize.sm,
    fontWeight: typography.fontWeight.bold as any,
    color: colors.text.secondary,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
  optional: {
    fontWeight: typography.fontWeight.regular as any,
    color: colors.text.muted,
    textTransform: 'none',
    letterSpacing: 0,
  },
  input: {
    backgroundColor: colors.background.secondary,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border.default,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: typography.fontSize.base,
    color: colors.text.primary,
  },
  textArea: {
    minHeight: 140,
    paddingTop: spacing.md,
  },
  charCount: {
    fontSize: typography.fontSize.xs,
    color: colors.text.muted,
    textAlign: 'right',
    marginTop: spacing.xs,
  },
  pageGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  pageChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: colors.border.default,
    backgroundColor: colors.background.secondary,
  },
  pageChipSelected: {
    borderColor: colors.primary.main,
    backgroundColor: colors.primary.main + '15',
  },
  pageChipText: {
    fontSize: typography.fontSize.sm,
    color: colors.text.secondary,
    fontWeight: typography.fontWeight.medium as any,
  },
  pageChipTextSelected: {
    color: colors.primary.main,
    fontWeight: typography.fontWeight.bold as any,
  },
  submitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primary.main,
    paddingVertical: spacing.md + 2,
    borderRadius: borderRadius.lg,
    marginTop: spacing.md,
  },
  submitButtonDisabled: {
    opacity: 0.4,
  },
  submitButtonText: {
    fontSize: typography.fontSize.base,
    fontWeight: typography.fontWeight.bold as any,
    color: colors.background.primary,
  },
  disclaimer: {
    fontSize: typography.fontSize.xs,
    color: colors.text.muted,
    textAlign: 'center',
    marginTop: spacing.lg,
  },
});
