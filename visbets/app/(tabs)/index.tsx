/**
 * Board Screen — Real projected props from backend model.
 * Data source: GET /api/projections/today (EWMA + normal distribution model)
 */

import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import {
  View,
  FlatList,
  Text,
  StyleSheet,
  Dimensions,
  TouchableOpacity,
  Animated,
  Image,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import ReAnimated, { FadeIn } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { PlayerPropCard } from '../../src/components/board/PlayerPropCard';
import { DataLoadingScreen } from '../../src/components/common/DataLoadingScreen';
import { useProjections, ProjectedProp } from '../../src/hooks/useProjections';
import { useUserPreferences, resolveBookLine, getSportsbookShortLabel } from '../../src/hooks/useUserPreferences';
import type { EnhancedPlayerProp, PlayerProp, Projection } from '../../src/services/api/types';
import { usePlayerSearch } from '../../src/hooks/usePlayerSearch';
import { colors } from '../../src/theme/colors';
import { typography } from '../../src/theme/typography';
import { spacing, borderRadius } from '../../src/theme/styles';

const { width } = Dimensions.get('window');
const HORIZONTAL_PADDING = spacing.md;
const CARD_GAP = spacing.sm;
const CARD_WIDTH = (width - HORIZONTAL_PADDING * 2 - CARD_GAP) / 2;

const HEADER_MAX_HEIGHT = 150;
const HEADER_MIN_HEIGHT = 0;
const HEADER_SCROLL_DISTANCE = HEADER_MAX_HEIGHT - HEADER_MIN_HEIGHT;
const LOGO_SIZE = 72;

type StatTab = 'PTS' | 'REB' | 'AST' | '3PM' | 'STL';
type SortOption = 'edge' | 'confidence' | 'score';

const STAT_TABS: StatTab[] = ['PTS', 'REB', 'AST', '3PM', 'STL'];

// ── Map a backend ProjectedProp to the EnhancedPlayerProp that PlayerPropCard expects ──

function toEnhancedProp(p: ProjectedProp): EnhancedPlayerProp {
  // Free-tier users receive null analytics from the backend
  const isLocked = p.projection == null;

  const prop: PlayerProp = {
    id: p.id,
    player_id: p.playerApiSportsId ?? 0,
    player_name: p.playerName,
    team: p.teamName,
    opponent: p.opponent,
    game_id: 0,
    game_date: p.gameTime ? p.gameTime.split('T')[0] : new Date().toISOString().split('T')[0],
    stat_type: p.statDisplay,
    line: p.line,
    over_odds: p.overOdds ?? undefined,
    under_odds: p.underOdds ?? undefined,
    sportsbook: p.bookmaker ?? 'visbets',
    image_url: p.headshotUrl ?? undefined,
  };

  const projection: Projection = {
    player_id: p.playerApiSportsId ?? 0,
    stat_type: p.statDisplay,
    projected_value: Math.round((p.projection ?? 0) * 10) / 10,
    confidence: p.visbetsScore ?? 0,
    volatility: isLocked || !p.projection ? 0 : Math.round(((p.stdDev ?? 0) / Math.max(p.projection, 1)) * 100),
    minutes_risk: isLocked ? 'Medium' : p.confidence === 'high' ? 'Low' : p.confidence === 'medium' ? 'Medium' : 'High',
    rationale_short: isLocked ? '' : buildRationale(p),
    recommendation: isLocked ? 'AVOID' : p.visbetsScore >= 60 ? 'OVER' : p.visbetsScore <= 40 ? 'UNDER' : 'AVOID',
    ensemble_breakdown: {
      recency: p.sampleSize ?? 0,
      matchup: isLocked ? 0 : Math.round(p.impliedPOver * 100),
      momentum: isLocked ? 0 : Math.round(p.pOver * 100),
      context: p.visbetsScore ?? 0,
      weights_used: [0.88],
    },
  };

  return {
    prop,
    projection,
    edge: isLocked ? 0 : Math.round((p.projection - p.line) * 10) / 10,
  };
}

function formatFreshness(generatedAt: string | null): string {
  if (!generatedAt) return '';
  const diffMs = Date.now() - new Date(generatedAt).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just updated';
  if (diffMins < 60) return `Updated ${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  return `Updated ${diffHrs}h ago`;
}

function buildRationale(p: ProjectedProp): string {
  const edgePct = Math.round(Math.abs(p.edge) * 100);
  const dir = p.direction === 'over' ? 'over' : 'under';
  return `${edgePct}% edge ${dir} — model P: ${Math.round(p.pOver * 100)}% vs implied ${Math.round(p.impliedPOver * 100)}%`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function BoardScreen() {
  const scrollY = useRef(new Animated.Value(0)).current;

  const { data: projections, isLoading, error, refetch, generatedAt } = useProjections();
  const { leftBook, rightBook, leftBookLabel, rightBookLabel } = useUserPreferences();

  const [selectedStat, setSelectedStat] = useState<StatTab>('PTS');
  const [sortBy, setSortBy] = useState<SortOption>('score');
  const [showPositiveEdgeOnly, setShowPositiveEdgeOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const { results: searchResults, isSearching } = usePlayerSearch(searchQuery);

  // Clear search state when tab loses focus to avoid stale dropdowns
  useFocusEffect(
    useCallback(() => {
      return () => {
        setSearchQuery('');
        setShowSearch(false);
      };
    }, [])
  );

  const isDropdownMode = showSearch && searchQuery.trim().length >= 2;

  const filteredItems = useMemo(() => {
    if (!projections || projections.length === 0) return [];

    let items = projections.filter((p) => p.statDisplay === selectedStat);

    if (showPositiveEdgeOnly) {
      items = items.filter((p) => p.direction === 'over' && p.edge != null && p.edge > 0);
    }

    // Only filter grid by name when NOT in dropdown mode
    // (dropdown handles its own player search separately)
    if (!isDropdownMode && searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      items = items.filter((p) => p.playerName.toLowerCase().includes(q));
    }

    items = [...items].sort((a, b) => {
      switch (sortBy) {
        case 'score':
          return (b.visbetsScore ?? 0) - (a.visbetsScore ?? 0);
        case 'edge':
          return Math.abs(b.edge ?? 0) - Math.abs(a.edge ?? 0);
        case 'confidence':
          return (b.sampleSize ?? 0) - (a.sampleSize ?? 0);
        default:
          return 0;
      }
    });

    return items.map((p) => {
      const hasBookLines = p.bookLines && Object.keys(p.bookLines).length > 0;

      // ── Left side ──
      let left: { line: number | undefined; label: string };
      if (hasBookLines) {
        const fromBook = p.bookLines![leftBook];
        left = fromBook != null
          ? { line: fromBook, label: leftBookLabel }
          : resolveBookLine(p.bookLines, leftBook, leftBookLabel);
      } else {
        // No bookLines (Supabase fallback) — use p.line with the source bookmaker label
        left = { line: p.line ?? undefined, label: leftBookLabel };
      }
      // Final fallback: if bookLines had no match, use p.line
      if (left.line == null && p.line != null) {
        left = { line: p.line, label: p.bookmaker ? getSportsbookShortLabel(p.bookmaker) : leftBookLabel };
      }

      // ── Right side ──
      let right: { line: number | undefined; label: string };
      if (hasBookLines) {
        right = resolveBookLine(p.bookLines, rightBook, rightBookLabel);
        // Secondary fallback: any book that isn't the left book
        if (right.line == null) {
          for (const [bookKey, bookLine] of Object.entries(p.bookLines!)) {
            if (bookLine != null && bookKey !== leftBook) {
              right = { line: bookLine, label: getSportsbookShortLabel(bookKey) };
              break;
            }
          }
        }
      } else {
        // No bookLines — use p.line but label it with the actual source book,
        // NOT the same label as left (avoid "PP | PP" when both are from same source)
        const sourceBook = p.bookmaker ?? 'fanduel';
        right = {
          line: p.line ?? undefined,
          label: sourceBook === leftBook ? rightBookLabel : getSportsbookShortLabel(sourceBook),
        };
      }

      // Last resort: mirror the left value but keep the right label distinct
      if (right.line == null && left.line != null) {
        right = { line: left.line, label: rightBookLabel };
      }

      return {
        enhanced: toEnhancedProp(p),
        leftLine: left.line,
        leftLabel: left.label,
        rightLine: right.line,
        rightLabel: right.label,
      };
    });
  }, [projections, selectedStat, sortBy, showPositiveEdgeOnly, searchQuery, isDropdownMode, leftBook, rightBook, leftBookLabel, rightBookLabel]);

  const totalProps = projections?.length ?? 0;
  const statCount = filteredItems.length;

  // Animated header
  const headerHeight = scrollY.interpolate({
    inputRange: [0, HEADER_SCROLL_DISTANCE],
    outputRange: [HEADER_MAX_HEIGHT, HEADER_MIN_HEIGHT],
    extrapolate: 'clamp',
  });
  const headerOpacity = scrollY.interpolate({
    inputRange: [0, HEADER_SCROLL_DISTANCE / 2],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  const renderItem = useCallback(
    ({ item }: { item: { enhanced: EnhancedPlayerProp; leftLine?: number; leftLabel: string; rightLine?: number; rightLabel: string } }) => (
      <View style={{ width: CARD_WIDTH }}>
        <PlayerPropCard
          enhancedProp={item.enhanced}
          leftLine={item.leftLine}
          rightLine={item.rightLine}
          leftLabel={item.leftLabel}
          rightLabel={item.rightLabel}
        />
      </View>
    ),
    []
  );

  const keyExtractor = useCallback(
    (item: { enhanced: EnhancedPlayerProp }) =>
      `${item.enhanced.prop.id}-${item.enhanced.prop.stat_type}`,
    []
  );

  if (isLoading) {
    return <DataLoadingScreen />;
  }

  if (error) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.centerContent}>
          <Text style={styles.errorText}>Can't load slate right now</Text>
          <Text style={styles.errorSubtext}>{error.message}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => refetch()}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Collapsible Header */}
      <Animated.View style={[styles.collapsibleHeader, { height: headerHeight }]}>
        <Animated.View style={[styles.headerContent, { opacity: headerOpacity }]}>
          <LinearGradient
            colors={['rgba(0, 255, 136, 0.06)', 'transparent']}
            style={StyleSheet.absoluteFill}
          />
          <ReAnimated.View entering={FadeIn.duration(800)} style={styles.headerCentered}>
            {/* Large centered logo */}
            <View style={styles.logoContainer}>
              <Image
                source={require('../../assets/animations/visbets-logo.png')}
                style={styles.headerLogo}
                resizeMode="contain"
              />
            </View>

            {/* Prop count + freshness */}
            <View style={styles.headerMetaRow}>
              <Text style={styles.headerPropCount}>{totalProps} props</Text>
              {generatedAt ? (
                <>
                  <View style={styles.headerMetaDot} />
                  <Text style={styles.freshnessText}>{formatFreshness(generatedAt)}</Text>
                </>
              ) : null}
            </View>
          </ReAnimated.View>

          {/* Action buttons — top-right overlay */}
          <View style={styles.headerActionsOverlay}>
            <TouchableOpacity
              style={styles.headerIconButton}
              activeOpacity={0.7}
              onPress={() => setShowSearch(!showSearch)}
            >
              <Ionicons name={showSearch ? 'close' : 'search'} size={20} color={showSearch ? colors.primary.main : colors.text.secondary} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.headerIconButton, styles.headerIconButtonPremium]}
              activeOpacity={0.7}
              onPress={() => router.push('/subscription')}
            >
              <Ionicons name="diamond" size={18} color={colors.primary.main} />
            </TouchableOpacity>
          </View>
        </Animated.View>
      </Animated.View>

      {/* Search Bar */}
      {showSearch && (
        <View style={{ position: 'relative', zIndex: 1000 }}>
          <View style={styles.searchBarContainer}>
            <Ionicons name="search" size={18} color={colors.text.muted} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search players..."
              placeholderTextColor={colors.text.muted}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCapitalize="words"
              autoCorrect={false}
              autoFocus
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')}>
                <Ionicons name="close-circle" size={18} color={colors.text.muted} />
              </TouchableOpacity>
            )}
          </View>

          {/* Search Results Dropdown */}
          {searchQuery.length >= 2 && (
            <View style={styles.searchDropdown}>
              {isSearching ? (
                <ActivityIndicator color={colors.primary.main} style={{ padding: 16 }} />
              ) : searchResults.length > 0 ? (
                <FlatList
                  data={searchResults}
                  keyExtractor={(item) => String(item.id)}
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      style={styles.searchResultRow}
                      onPress={() => {
                        router.push({
                          pathname: '/player/[id]',
                          params: { id: String(item.id), playerName: item.name, headshotUrl: item.headshotUrl ?? '' },
                        } as any);
                        setShowSearch(false);
                        setSearchQuery('');
                      }}
                    >
                      <View style={styles.searchHeadshotContainer}>
                        {item.headshotUrl ? (
                          <Image
                            source={{ uri: item.headshotUrl }}
                            style={styles.searchHeadshot}
                          />
                        ) : (
                          <View style={[styles.searchHeadshot, styles.searchHeadshotFallback]}>
                            <Text style={styles.searchHeadshotInitial}>
                              {item.name.charAt(0)}
                            </Text>
                          </View>
                        )}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.searchResultName}>{item.name}</Text>
                        {item.team && (
                          <Text style={styles.searchResultTeam}>{item.team}</Text>
                        )}
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={colors.text.muted} />
                    </TouchableOpacity>
                  )}
                  keyboardShouldPersistTaps="handled"
                  style={{ maxHeight: 300 }}
                />
              ) : (
                <Text style={styles.searchNoResults}>No players found for "{searchQuery}"</Text>
              )}
            </View>
          )}
        </View>
      )}

      {/* Stat Tabs */}
      <View style={styles.stickyChipsContainer}>
        <View style={styles.statTabsContainer}>
          {STAT_TABS.map((stat) => {
            const isSelected = selectedStat === stat;
            return (
              <TouchableOpacity
                key={stat}
                style={styles.statTab}
                onPress={() => setSelectedStat(stat)}
                activeOpacity={0.7}
              >
                {isSelected && (
                  <LinearGradient
                    colors={[colors.primary.main + '20', colors.primary.main + '08']}
                    style={styles.statTabGradient}
                  />
                )}
                <Text style={[styles.statTabText, isSelected && styles.statTabTextSelected]}>
                  {stat}
                </Text>
                {isSelected && (
                  <View style={styles.statTabCount}>
                    <Text style={styles.statTabCountText}>{statCount}</Text>
                  </View>
                )}
                {isSelected && <View style={styles.statTabIndicator} />}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Sort & Filter Row */}
        <View style={styles.sortRow}>
          {(['score', 'edge', 'confidence'] as SortOption[]).map((opt) => {
            const icons: Record<SortOption, string> = {
              score: 'flash',
              edge: 'trending-up',
              confidence: 'shield-checkmark',
            };
            const labels: Record<SortOption, string> = {
              score: 'Score',
              edge: 'Edge',
              confidence: 'Sample',
            };
            const isActive = sortBy === opt;
            return (
              <TouchableOpacity
                key={opt}
                style={[styles.sortButton, isActive && styles.sortButtonActive]}
                onPress={() => setSortBy(opt)}
              >
                <Ionicons
                  name={icons[opt] as any}
                  size={14}
                  color={isActive ? colors.primary.main : colors.text.muted}
                />
                <Text style={[styles.sortButtonText, isActive && styles.sortButtonTextActive]}>
                  {labels[opt]}
                </Text>
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity
            style={[styles.filterToggle, showPositiveEdgeOnly && styles.filterToggleActive]}
            onPress={() => setShowPositiveEdgeOnly(!showPositiveEdgeOnly)}
          >
            <Ionicons
              name={showPositiveEdgeOnly ? 'checkmark-circle' : 'add-circle-outline'}
              size={16}
              color={showPositiveEdgeOnly ? colors.primary.main : colors.text.muted}
            />
            <Text style={[styles.filterToggleText, showPositiveEdgeOnly && styles.filterToggleTextActive]}>
              +Edge Only
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Grid */}
      {filteredItems.length === 0 ? (
        <View style={styles.centerContent}>
          <Text style={styles.emptyText}>No {selectedStat} props today</Text>
          <TouchableOpacity
            style={styles.resetButton}
            onPress={() => {
              setSelectedStat('PTS');
              setShowPositiveEdgeOnly(false);
              setSearchQuery('');
            }}
          >
            <Text style={styles.resetButtonText}>Reset Filters</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.retryButton, { marginTop: spacing.md }]}
            onPress={() => refetch()}
          >
            <Text style={styles.retryButtonText}>Refresh</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <Animated.FlatList
          data={filteredItems}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.gridContent}
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { useNativeDriver: false }
          )}
          scrollEventThrottle={16}
          removeClippedSubviews={true}
          initialNumToRender={8}
          maxToRenderPerBatch={6}
          windowSize={5}
        />
      )}

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background.primary },
  collapsibleHeader: { overflow: 'hidden', backgroundColor: colors.background.primary },
  headerContent: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.lg },
  headerCentered: { alignItems: 'center', justifyContent: 'center' },
  logoContainer: {
    shadowColor: colors.primary.main,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
  },
  headerLogo: { width: LOGO_SIZE, height: LOGO_SIZE },
  headerMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.xs,
    gap: spacing.sm,
  },
  headerPropCount: {
    fontSize: typography.fontSize.sm,
    fontWeight: typography.fontWeight.semibold,
    color: colors.text.secondary,
  },
  headerMetaDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: colors.text.muted,
  },
  headerActionsOverlay: {
    position: 'absolute',
    top: spacing.md,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  searchBarContainer: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    marginHorizontal: spacing.md, marginBottom: spacing.sm,
    backgroundColor: colors.background.secondary, borderRadius: borderRadius.lg,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderWidth: 1, borderColor: colors.border.default,
  },
  searchInput: {
    flex: 1, fontSize: typography.fontSize.base, color: colors.text.primary,
    paddingVertical: spacing.xs,
  },
  freshnessText: {
    fontSize: typography.fontSize.xs, color: colors.text.muted,
  },
  headerIconButton: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: colors.background.elevated,
    alignItems: 'center', justifyContent: 'center',
  },
  headerIconButtonPremium: {
    backgroundColor: colors.primary.main + '15',
    borderWidth: 1, borderColor: colors.primary.main + '40',
  },
  stickyChipsContainer: {
    backgroundColor: colors.background.primary,
    paddingBottom: spacing.xs,
  },
  statTabsContainer: {
    flexDirection: 'row',
    marginHorizontal: spacing.md,
    backgroundColor: colors.background.secondary,
    borderRadius: borderRadius.lg,
    padding: spacing.xs,
    marginBottom: spacing.sm,
  },
  statTab: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: spacing.md, paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.md,
    position: 'relative', overflow: 'hidden',
  },
  statTabGradient: { ...StyleSheet.absoluteFillObject, borderRadius: borderRadius.md },
  statTabText: {
    fontSize: typography.fontSize.base,
    fontWeight: typography.fontWeight.bold,
    color: colors.text.muted, letterSpacing: 0.5,
  },
  statTabTextSelected: { color: colors.primary.main },
  statTabCount: {
    position: 'absolute', top: 4, right: 4,
    backgroundColor: colors.primary.main,
    borderRadius: 8, minWidth: 16, height: 16,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
  },
  statTabCountText: {
    fontSize: 9, fontWeight: typography.fontWeight.bold,
    color: colors.background.primary,
  },
  statTabIndicator: {
    position: 'absolute', bottom: 0,
    left: '20%', right: '20%',
    height: 3, backgroundColor: colors.primary.main, borderRadius: 2,
  },
  sortRow: {
    flexDirection: 'row', paddingHorizontal: spacing.md,
    paddingTop: spacing.sm, gap: spacing.sm,
  },
  sortButton: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: spacing.sm, paddingVertical: 4,
    borderRadius: borderRadius.sm,
  },
  sortButtonActive: { backgroundColor: colors.primary.main + '15' },
  sortButtonText: {
    fontSize: typography.fontSize.xs, color: colors.text.muted,
    fontWeight: typography.fontWeight.medium,
  },
  sortButtonTextActive: { color: colors.primary.main },
  filterToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: spacing.sm, paddingVertical: 4,
    borderRadius: borderRadius.sm, marginLeft: 'auto',
  },
  filterToggleActive: { backgroundColor: colors.primary.main + '15' },
  filterToggleText: {
    fontSize: typography.fontSize.xs, color: colors.text.muted,
    fontWeight: typography.fontWeight.medium,
  },
  filterToggleTextActive: { color: colors.primary.main },
  row: { justifyContent: 'space-between', paddingHorizontal: HORIZONTAL_PADDING, gap: CARD_GAP },
  gridContent: { paddingTop: spacing.sm, paddingBottom: spacing['3xl'] + spacing.xl },
  centerContent: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  errorText: {
    fontSize: typography.fontSize.lg, fontWeight: typography.fontWeight.bold,
    color: colors.text.primary, marginBottom: spacing.xs, marginTop: spacing.md,
    textAlign: 'center',
  },
  errorSubtext: {
    fontSize: typography.fontSize.sm, color: colors.text.secondary,
    marginBottom: spacing.lg, textAlign: 'center',
  },
  retryButton: {
    paddingHorizontal: spacing['2xl'], paddingVertical: spacing.md,
    backgroundColor: colors.primary.main, borderRadius: 24,
  },
  retryButtonText: {
    fontSize: typography.fontSize.base, fontWeight: typography.fontWeight.bold,
    color: colors.background.primary,
  },
  emptyText: { fontSize: typography.fontSize.base, color: colors.text.secondary, marginBottom: spacing.md },
  resetButton: {
    paddingHorizontal: spacing.xl, paddingVertical: spacing.md,
    backgroundColor: colors.background.card, borderRadius: 20,
    borderWidth: 1, borderColor: colors.border.default,
  },
  resetButtonText: {
    fontSize: typography.fontSize.base, fontWeight: typography.fontWeight.semibold,
    color: colors.text.primary,
  },
  searchDropdown: {
    position: 'absolute',
    top: '100%',
    left: spacing.md,
    right: spacing.md,
    backgroundColor: colors.background.secondary,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border.default,
    zIndex: 1000,
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    overflow: 'hidden',
  },
  searchResultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.default,
  },
  searchHeadshotContainer: {
    width: 40, height: 40, borderRadius: 20, overflow: 'hidden',
    backgroundColor: colors.background.tertiary,
  },
  searchHeadshot: {
    width: 40, height: 40, borderRadius: 20,
  },
  searchHeadshotFallback: {
    justifyContent: 'center', alignItems: 'center',
    backgroundColor: colors.primary.main + '20',
  },
  searchHeadshotInitial: {
    fontSize: 16, fontWeight: 'bold' as const, color: colors.primary.main,
  },
  searchResultName: {
    fontSize: typography.fontSize.base,
    fontWeight: typography.fontWeight.semibold,
    color: colors.text.primary,
  },
  searchResultTeam: {
    fontSize: typography.fontSize.xs,
    color: colors.text.secondary,
    marginTop: 2,
  },
  searchNoResults: {
    padding: spacing.lg,
    color: colors.text.muted,
    textAlign: 'center',
    fontSize: typography.fontSize.sm,
  },
});
