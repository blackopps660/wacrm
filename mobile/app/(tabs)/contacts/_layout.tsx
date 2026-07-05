import { Stack } from 'expo-router';

export default function ContactsLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#0f172a' },
        headerTintColor: '#f8fafc',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Contacts' }} />
      <Stack.Screen name="[id]" options={{ title: '' }} />
      <Stack.Screen name="new" options={{ title: 'New Contact', presentation: 'modal' }} />
    </Stack>
  );
}
