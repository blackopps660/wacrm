import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppTheme } from '../../hooks/use-theme';
import type { Palette } from '../../lib/theme';

type IoniconName = keyof typeof Ionicons.glyphMap;

function TabIcon({ name, focused, colors }: { name: IoniconName; focused: boolean; colors: Palette }) {
  return (
    <Ionicons
      name={focused ? name : (`${name}-outline` as IoniconName)}
      size={22}
      color={focused ? colors.accent : colors.textFaint}
    />
  );
}

export default function TabsLayout() {
  // Hardcoded tab bar height/padding put the bar right under the
  // system nav bar (3-button nav or gesture pill) with no clearance,
  // so Android's own nav buttons visually overlapped it. Basing height
  // on the bottom safe-area inset fixes that on every device instead
  // of guessing a fixed padding.
  const insets = useSafeAreaInsets();
  const tabBarHeight = 50 + insets.bottom;
  const { colors } = useAppTheme();

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '700' },
        headerShadowVisible: false,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          height: tabBarHeight,
          paddingBottom: Math.max(insets.bottom, 6),
          paddingTop: 6,
        },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ focused }) => <TabIcon name="grid" focused={focused} colors={colors} />,
        }}
      />
      <Tabs.Screen
        name="inbox"
        options={{
          title: 'Inbox',
          headerShown: false,
          tabBarIcon: ({ focused }) => <TabIcon name="chatbubble-ellipses" focused={focused} colors={colors} />,
        }}
      />
      <Tabs.Screen
        name="contacts"
        options={{
          title: 'Contacts',
          headerShown: false,
          tabBarIcon: ({ focused }) => <TabIcon name="people" focused={focused} colors={colors} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          headerShown: false,
          tabBarIcon: ({ focused }) => <TabIcon name="settings" focused={focused} colors={colors} />,
        }}
      />
    </Tabs>
  );
}
