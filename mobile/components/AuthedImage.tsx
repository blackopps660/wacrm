import { useEffect, useState } from 'react';
import { View, Image, ActivityIndicator, StyleSheet, type ImageStyle, type StyleProp } from 'react-native';
import { resolveAuthedSource, type AuthedSource } from '../lib/media';

/** <Image> that attaches the caller's session token when the url is a relative, auth-gated proxy path (inbound media) — see lib/media.ts for why that's necessary. */
export function AuthedImage({ url, style }: { url: string; style?: StyleProp<ImageStyle> }) {
  const [source, setSource] = useState<AuthedSource | null>(null);

  useEffect(() => {
    let cancelled = false;
    resolveAuthedSource(url).then((resolved) => {
      if (!cancelled) setSource(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!source) {
    return (
      <View style={[style, styles.placeholder]}>
        <ActivityIndicator size="small" />
      </View>
    );
  }

  return <Image source={source} style={style} resizeMode="cover" />;
}

const styles = StyleSheet.create({
  placeholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.06)' },
});
