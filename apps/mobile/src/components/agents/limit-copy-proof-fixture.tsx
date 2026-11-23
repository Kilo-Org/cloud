import { useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { BuildLogSection } from '@/components/agents/environment-build-detail-parts';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { isSupportedLanguage } from '@/i18n/languages';
import { describeClassificationFailure } from '@/lib/agent-attachments/validate';

const buildLogLines = Array.from({ length: 4 }, (_, index) => ({
  seq: 498 + index,
  text: `fixture build output line ${498 + index}`,
}));

export function LimitCopyProofFixture() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ lang?: string | string[] }>();
  const requested = Array.isArray(params.lang) ? params.lang[0] : params.lang;
  const requestedLanguage = requested && isSupportedLanguage(requested) ? requested : undefined;

  useEffect(() => {
    if (requestedLanguage) {
      void i18n.changeLanguage(requestedLanguage);
    }
  }, [requestedLanguage]);

  return (
    <View className="flex-1 bg-background">
      <ScrollView contentContainerClassName="gap-4 p-4">
        <Text selectable className="text-sm text-foreground">
          {describeClassificationFailure('too-large')}
        </Text>
        <BuildLogSection
          open
          onToggle={() => undefined}
          lines={buildLogLines}
          truncated
          isLoading={false}
          isError={false}
          onRetry={() => undefined}
        />
        <Text selectable className="text-xs text-muted-foreground">
          {t('agentChat.environment.buildLogsTruncated')}
        </Text>
      </ScrollView>
    </View>
  );
}
