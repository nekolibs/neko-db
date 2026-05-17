import { Button, Card, Link, ScrollView, Text, TopBar, View } from '@neko-os/ui'
import { useNavigation } from '@react-navigation/native'
import { useSQLiteContext } from 'expo-sqlite'
import { useEffect, useState } from 'react'

import { getModels } from '../models'

export function ModelListView({ dataViewRoute = 'nekodb/model' }) {
  const db = useSQLiteContext()
  const { push, goBack } = useNavigation()
  const models = getModels()
  const entries = Object.values(models)

  const [counts, setCounts] = useState({})

  useEffect(() => {
    Promise.all(
      entries.map((model) =>
        model.query().count(db).then((count) => [model.name, count])
      )
    ).then((results) => setCounts(Object.fromEntries(results)))
  }, [])

  return (
    <View flex bg="mainBG">
      <TopBar
        title="NekoDB"
        subtitle={`${entries.length} model(s)`}
        bg="overlayBG"
        left={<Button icon="arrow-left-s-line" ratio={1} mainBG onPress={goBack} xs />}
      />
      <View flex>
        <ScrollView padding="md">
          <Card bg="overlayBG" padding={0}>
            {entries.map((model, index) => (
              <Link key={model.name} onPress={() => push(dataViewRoute, { model: model.name })}>
                <View centerV padding="md" borderB={index < entries.length - 1}>
                  <Text>{model.name}</Text>
                  <Text xs text3>
                    {counts[model.name] != null ? `${counts[model.name]} row(s)` : '...'}
                  </Text>
                </View>
              </Link>
            ))}
          </Card>
        </ScrollView>
      </View>
    </View>
  )
}
