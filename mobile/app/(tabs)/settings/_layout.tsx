import { Stack } from 'expo-router';

export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#0f172a' },
        headerTintColor: '#f8fafc',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Settings' }} />
      <Stack.Screen name="workspaces" options={{ title: 'Switch Workspace' }} />
      <Stack.Screen name="profile" options={{ title: 'Your Profile' }} />
      <Stack.Screen name="team" options={{ title: 'Team Members' }} />
      <Stack.Screen name="whatsapp" options={{ title: 'WhatsApp Status' }} />
    </Stack>
  );
}
